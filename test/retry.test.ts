import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createClient, type PoliteEvent } from '../src/client.ts';
import { backoffDelay, HttpError, parseRetryAfter, withRetry } from '../src/retry.ts';
import { fakeClock, json, localServer, send } from './helpers.ts';

test('parseRetryAfter: секунды, HTTP-дата, мусор', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter('0.5'), 500);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:10 GMT', Date.parse('2026-10-21T07:28:00Z')), 10_000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:10 GMT', Date.parse('2026-10-21T08:00:00Z')), 0);
  assert.equal(parseRetryAfter('скоро'), undefined);
  assert.equal(parseRetryAfter(null), undefined);
});

test('backoffDelay растёт как 2^n, упирается в потолок, джиттер в [0, cap]', () => {
  const o = { baseMs: 100, maxMs: 1000 };
  assert.equal(backoffDelay(0, o, () => 1), 100);
  assert.equal(backoffDelay(3, o, () => 1), 800);
  assert.equal(backoffDelay(10, o, () => 1), 1000);
  assert.equal(backoffDelay(10, o, () => 0), 0);
  assert.equal(backoffDelay(2, o, () => 0.5), 200);
});

test('withRetry повторяет 429/5xx и обрыв, уважает Retry-After', async () => {
  const clock = fakeClock();
  const errors = [new HttpError('429', 429, true, 2500), new HttpError('503', 503, true), new TypeError('fetch failed')];
  let calls = 0;
  const v = await withRetry(
    async () => {
      const e = errors[calls++];
      if (e) throw e;
      return 'ok';
    },
    { retries: 5, baseMs: 100, maxMs: 10_000 },
    { clock, random: () => 1 },
  );
  assert.equal(v, 'ok');
  assert.deepEqual(clock.sleeps, [2500, 200, 400]);
});

test('withRetry не повторяет 4xx и сдаётся после retries', async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new HttpError('400', 400, false); }, { retries: 3, baseMs: 1, maxMs: 1 }, { clock }),
    /400/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new HttpError('500', 500, true); }, { retries: 3, baseMs: 1, maxMs: 1 }, { clock }),
    /500/,
  );
  assert.equal(calls, 4);
});

test('Retry-After ограничен сверху', async () => {
  const clock = fakeClock();
  let calls = 0;
  await withRetry(
    async () => { if (calls++ === 0) throw new HttpError('429', 429, true, 3_600_000); return 1; },
    { retries: 1, baseMs: 1, maxMs: 1, maxRetryAfterMs: 5000 },
    { clock },
  );
  assert.deepEqual(clock.sleeps, [5000]);
});

const server = await localServer((req, res, n) => {
  if (req.url === '/flaky') {
    if (n === 1) return send(res, 429, { error: 'slow down' }, { 'retry-after': '2' });
    if (n === 2) return send(res, 503, { error: 'unavailable' });
    return send(res, 200, { ok: true, n });
  }
  if (req.url === '/bad') return send(res, 404, { error: 'not found' });
  if (req.url === '/always-503') return send(res, 503, {});
  if (req.url === '/echo') return send(res, 200, { method: req.method, type: req.headers['content-type'] ?? null });
  send(res, 200, {});
});
after(() => server.close());

test('локальный сервер: 429 с Retry-After, потом 503, потом 200', async () => {
  const clock = fakeClock();
  const events: PoliteEvent['type'][] = [];
  const client = createClient({
    retry: { retries: 3, baseMs: 100, maxMs: 1000 },
    clock,
    random: () => 1,
    onEvent: (e) => events.push(e.type),
  });
  server.hits.length = 0;
  const r = await client.json<{ ok: boolean; n: number }>(`${server.url}/flaky`);
  assert.deepEqual(r, { ok: true, n: 3 });
  // первая пауза — из Retry-After, вторая — экспонента: 100·2^1
  assert.deepEqual(clock.sleeps, [2000, 200]);
  assert.deepEqual(client.stats, { requests: 3, retries: 2, cacheHits: 0, cacheMisses: 0, failures: 0 });
  assert.deepEqual(events, ['request', 'response', 'retry', 'request', 'response', 'retry', 'request', 'response']);
});

test('4xx не повторяется, HttpError несёт статус и тело', async () => {
  const client = createClient({ retry: { retries: 3, baseMs: 1, maxMs: 1 }, clock: fakeClock() });
  await assert.rejects(client.json(`${server.url}/bad`), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 404);
    assert.equal(err.retryable, false);
    assert.match(err.body, /not found/);
    return true;
  });
  assert.deepEqual(client.stats, { requests: 1, retries: 0, cacheHits: 0, cacheMisses: 0, failures: 1 });
});

test('повторы кончились — последняя ошибка наружу; retry: false — без повторов', async () => {
  const clock = fakeClock();
  const client = createClient({ retry: { retries: 2, baseMs: 10, maxMs: 10 }, clock });
  await assert.rejects(client.json(`${server.url}/always-503`), /503/);
  assert.equal(client.stats.requests, 3);
  const once = createClient({ retry: false, clock });
  await assert.rejects(once.json(`${server.url}/always-503`), /503/);
  assert.equal(once.stats.requests, 1);
});

test('тело POST уходит как JSON', async () => {
  const client = createClient();
  const r = await client.json(`${server.url}/echo`, { method: 'post', body: { q: 1 } });
  assert.deepEqual(r, { method: 'POST', type: 'application/json' });
  assert.equal(server.hits.at(-1)?.body, '{"q":1}');
});

test('POST по умолчанию не повторяется; idempotent: true или свой retry — повторяется', async () => {
  const clock = fakeClock();
  const client = createClient({ retry: { retries: 2, baseMs: 10, maxMs: 10 }, clock });
  await assert.rejects(client.json(`${server.url}/always-503`, { method: 'POST', body: { q: 1 } }), /503/);
  assert.equal(client.stats.requests, 1);
  await assert.rejects(client.json(`${server.url}/always-503`, { method: 'POST', body: { q: 1 }, idempotent: true }), /503/);
  assert.equal(client.stats.requests, 4);
  await assert.rejects(client.json(`${server.url}/always-503`, { method: 'POST', retry: { retries: 1, baseMs: 1, maxMs: 1 } }), /503/);
  assert.equal(client.stats.requests, 6);
  await assert.rejects(client.json(`${server.url}/always-503`, { method: 'PUT' }), /503/);
  assert.equal(client.stats.requests, 9);
});

test('check: 200 с ошибкой в теле повторяется, если check бросил retryable', async () => {
  const answers = [json({ status: 'busy' }), json({ status: 'ok', items: [1] })];
  const client = createClient({ fetch: async () => answers.shift()!, retry: { retries: 2, baseMs: 1, maxMs: 1 }, clock: fakeClock() });
  const r = await client.json<{ items: number[] }>('https://api.example.com/q', {
    check: (d) => {
      if ((d as { status: string }).status !== 'ok') throw new HttpError('busy', 200, true);
    },
  });
  assert.deepEqual(r.items, [1]);
  assert.equal(client.stats.retries, 1);
});
