import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limitForWindow, TokenBucket } from '../src/bucket.ts';
import { createClient } from '../src/client.ts';
import type { Clock } from '../src/clock.ts';
import { HttpError, withRetry } from '../src/retry.ts';
import { fakeClock, json } from './helpers.ts';

/** Часы, у которых пауза не кончается никогда: выйти из неё можно только отменой. */
const stuckClock = (): Clock => ({ now: () => 0, sleep: () => new Promise(() => {}) });

test('числовые опции: NaN, Infinity, отрицательные и дробные retries — понятная ошибка', async () => {
  // раньше retries: NaN давал бесконечные повторы
  await assert.rejects(withRetry(async () => 1, { retries: NaN }), { name: 'RangeError', message: /retry\.retries/ });
  assert.throws(() => createClient({ retry: { retries: -1 } }), /retry\.retries — нужно неотрицательное целое/);
  assert.throws(() => createClient({ retry: { retries: 1.5 } }), RangeError);
  assert.throws(() => createClient({ retry: { baseMs: Infinity } }), /retry\.baseMs/);
  assert.throws(() => createClient({ timeoutMs: NaN }), /timeoutMs/);
  assert.throws(() => createClient({ timeoutMs: 0 }), /timeoutMs — нужно положительное/);
  assert.throws(() => createClient({ timeoutMs: 1e10 }), /не больше 2147483647/);
  assert.throws(() => createClient({ limits: { 'api.example.com': { ratePerSec: 0 } } }), /limits\['api\.example\.com'\]\.ratePerSec/);
  assert.throws(() => createClient({ limits: { '*': { ratePerSec: 1, burst: NaN } } }), /limits\['\*'\]\.burst/);
  assert.throws(() => new TokenBucket({ ratePerSec: Infinity }), RangeError);
  assert.throws(() => limitForWindow(NaN, 60), RangeError);

  const client = createClient({ fetch: async () => json({}), retry: false });
  await assert.rejects(client.json('https://api.example.com/a', { weight: -1 }), /weight/);
  await assert.rejects(client.json('https://api.example.com/a', { timeoutMs: Infinity }), /timeoutMs/);
  await assert.rejects(client.json('https://api.example.com/a', { retry: { retries: NaN } }), /retry\.retries/);
  // обычные значения проходят
  assert.deepEqual(await client.json('https://api.example.com/a', { weight: 0, timeoutMs: 1000, retry: { retries: 0 } }), {});
});

test('пауза повтора прерывается отменой сразу, не дожидаясь Retry-After', async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20);
  const t0 = Date.now();
  await assert.rejects(
    withRetry(
      async () => {
        throw new HttpError('429', 429, true, 60_000);
      },
      { retries: 3 },
      { clock: stuckClock(), signal: ctrl.signal },
    ),
    { name: 'AbortError' },
  );
  assert.ok(Date.now() - t0 < 2000);
});

test('ожидание токена прерывается отменой; очередь ведра после этого не застревает', async () => {
  const b = new TokenBucket({ ratePerSec: 1, burst: 1 }, stuckClock());
  await b.take();
  const ctrl = new AbortController();
  const waiting = b.take(1, ctrl.signal);
  ctrl.abort();
  await assert.rejects(waiting, { name: 'AbortError' });

  // запрос, отменённый, пока он стоит в очереди за другим, тоже отказывает сразу и веса не тратит
  const clock = fakeClock();
  const b2 = new TokenBucket({ ratePerSec: 1, burst: 1 }, clock);
  await b2.take();
  const first = b2.take(1);
  const ctrl2 = new AbortController();
  const second = b2.take(1, ctrl2.signal);
  ctrl2.abort();
  await assert.rejects(second, { name: 'AbortError' });
  await first;
  await b2.take(1);
  assert.equal(clock.now(), 2000, 'отменённый запрос не занял токен');
});

for (const [where, retryAfter] of [['паузы повтора', '60'], ['ожидания токена в ведре', '0']] as const) {
  test(`клиент: отмена во время ${where}`, async () => {
    let calls = 0;
    const client = createClient({
      fetch: async () => {
        calls++;
        return json({ error: 'slow down' }, 429, { 'retry-after': retryAfter });
      },
      // токен копится ~17 минут: второй попытке пришлось бы ждать в ведре
      limits: { '*': { ratePerSec: 0.001, burst: 1 } },
      retry: { retries: 5 },
      // нулевая пауза проходит сразу, любая другая не кончается никогда
      clock: { now: () => Date.now(), sleep: (ms) => (ms === 0 ? Promise.resolve() : new Promise(() => {})) },
    });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    const t0 = Date.now();
    await assert.rejects(client.json('https://api.example.com/a', { signal: ctrl.signal }), { name: 'AbortError' });
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(calls, 1);
  });
}
