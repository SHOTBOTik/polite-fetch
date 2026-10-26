import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limitForWindow, TokenBucket } from '../src/bucket.ts';
import { createClient } from '../src/client.ts';
import { fakeClock, json } from './helpers.ts';

test('ведро отдаёт залп до burst, дальше ждёт пополнения', async () => {
  const clock = fakeClock();
  const b = new TokenBucket({ ratePerSec: 1, burst: 3 }, clock);
  for (let i = 0; i < 3; i++) await b.take();
  assert.equal(clock.now(), 0);
  await b.take();
  assert.equal(clock.now(), 1000);
});

test('вес запроса: тяжёлый запрос ждёт, пока накопится его вес', async () => {
  const clock = fakeClock();
  const b = new TokenBucket({ ratePerSec: 10, burst: 20 }, clock);
  await b.take(20);
  await b.take(15);
  assert.equal(clock.now(), 1500);
});

test('время между запросами само пополняет ведро', async () => {
  const clock = fakeClock();
  const b = new TokenBucket({ ratePerSec: 2, burst: 2 }, clock);
  await b.take(2);
  clock.advance(500);
  await b.take(1);
  assert.equal(clock.now(), 500);
  assert.deepEqual(clock.sleeps, []);
});

test('вес больше burst не зависает, а ждёт полного ведра', async () => {
  const clock = fakeClock();
  const b = new TokenBucket({ ratePerSec: 5, burst: 5 }, clock);
  await b.take(5);
  await b.take(100);
  assert.equal(clock.now(), 1000);
});

test('charge уводит ведро в долг: следующий запрос ждёт и долг, и свой вес', async () => {
  const clock = fakeClock();
  const b = new TokenBucket({ ratePerSec: 10, burst: 10 }, clock);
  await b.take(10);
  b.charge(20);
  assert.equal(Math.round(b.available()), -20);
  await b.take(10);
  assert.equal(clock.now(), 3000);
});

test('очередь честная: запросы выходят в порядке вызова', async () => {
  const clock = fakeClock();
  const b = new TokenBucket({ ratePerSec: 1, burst: 1 }, clock);
  const order: number[] = [];
  await Promise.all([1, 2, 3].map((i) => b.take().then(() => order.push(i))));
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(clock.now(), 2000);
});

test('limitForWindow: залп плюс пополнение за окно не больше лимита', async () => {
  for (const [limit, win] of [[1200, 60], [5, 2], [20, 2]] as const) {
    const clock = fakeClock();
    const b = new TokenBucket(limitForWindow(limit, win), clock);
    let spent = 0;
    while (clock.now() < win * 1000) {
      await b.take(1);
      if (clock.now() < win * 1000) spent++;
    }
    assert.ok(spent <= limit, `${limit}/${win}s: потрачено ${spent}`);
  }
});

test('неверные параметры ведра — ошибка', () => {
  assert.throws(() => new TokenBucket({ ratePerSec: 0 }));
  assert.throws(() => new TokenBucket({ ratePerSec: 1, burst: -1 }));
  assert.throws(() => limitForWindow(0, 60));
});

test('клиент: лимит на хост, вес запроса, свой ключ и хост без лимита', async () => {
  const clock = fakeClock();
  const client = createClient({
    limits: { 'api.example.com': { ratePerSec: 2, burst: 2 } },
    fetch: async () => json({ ok: true }),
    clock,
  });
  await client.json('https://api.example.com/a');
  await client.json('https://api.example.com/b');
  assert.equal(clock.now(), 0);
  await client.json('https://api.example.com/c', { weight: 2 });
  assert.equal(clock.now(), 1000);
  // у другого хоста лимита нет — ждать не нужно
  await client.json('https://other.example.com/x', { weight: 50 });
  assert.equal(clock.now(), 1000);
  // свой ключ: два хоста делят одно ведро
  const shared = createClient({
    limits: { 'key-1': { ratePerSec: 1, burst: 1 } },
    limitKey: () => 'key-1',
    fetch: async () => json({}),
    clock,
  });
  await shared.json('https://a.example.com/');
  await shared.json('https://b.example.com/');
  assert.equal(clock.now(), 2000);
  assert.equal(client.bucket('nope.example.com'), undefined);
});

test('клиент: лимит * для всех хостов, charge после ответа', async () => {
  const clock = fakeClock();
  const client = createClient({ limits: { '*': { ratePerSec: 10, burst: 10 } }, fetch: async () => json([1, 2, 3]), clock });
  const items = await client.json<number[]>('https://api.example.com/list', { weight: 10 });
  client.charge('api.example.com', items.length * 10);
  await client.json('https://api.example.com/list', { weight: 10 });
  assert.equal(clock.now(), 4000);
});
