import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createClient } from '../src/client.ts';
import { fakeClock, localServer, send } from './helpers.ts';

// /hang не отвечает никогда; /slow-once зависает только на первом запросе
const server = await localServer((req, res, n) => {
  if (req.url === '/hang') return;
  if (req.url === '/slow-once' && n === 1) return;
  send(res, 200, { ok: true, n });
});
after(() => server.close());

test('таймаут прерывает зависший запрос через AbortController', async () => {
  const client = createClient({ timeoutMs: 50, retry: false });
  const started = Date.now();
  await assert.rejects(client.json(`${server.url}/hang`), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'TimeoutError');
    return true;
  });
  assert.ok(Date.now() - started < 5000);
  assert.equal(client.stats.failures, 1);
});

test('после таймаута запрос повторяется и проходит', async () => {
  const client = createClient({ timeoutMs: 50, retry: { retries: 2, baseMs: 1, maxMs: 1 }, clock: fakeClock() });
  server.hits.length = 0;
  const r = await client.json<{ ok: boolean }>(`${server.url}/slow-once`);
  assert.equal(r.ok, true);
  assert.equal(client.stats.requests, 2);
  assert.equal(client.stats.retries, 1);
});

test('таймаут на запрос сильнее общего', async () => {
  const client = createClient({ timeoutMs: 60_000, retry: false });
  await assert.rejects(client.json(`${server.url}/hang`, { timeoutMs: 30 }), { name: 'TimeoutError' });
});

test('отмена снаружи не повторяется', async () => {
  const client = createClient({ timeoutMs: 60_000, retry: { retries: 5, baseMs: 1, maxMs: 1 } });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 30);
  await assert.rejects(client.json(`${server.url}/hang`, { signal: ctrl.signal }), { name: 'AbortError' });
  assert.equal(client.stats.requests, 1);
  assert.equal(client.stats.retries, 0);
});
