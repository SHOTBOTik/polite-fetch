import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cacheKey, DiskCache } from '../src/cache.ts';
import { createClient, type PoliteEvent } from '../src/client.ts';
import { fakeClock, json } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'polite-fetch-cache-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('cacheKey зависит от тела запроса и стабилен', () => {
  assert.equal(cacheKey(['POST', 'u', { a: 1 }]), cacheKey(['POST', 'u', { a: 1 }]));
  assert.notEqual(cacheKey(['POST', 'u', { a: 1 }]), cacheKey(['POST', 'u', { a: 2 }]));
  assert.match(cacheKey(['GET', 'u']), /^[0-9a-f]{64}$/);
});

test('DiskCache: запись живёт ровно ttl, потом промах; битый файл — промах', () => {
  let now = 1_000_000;
  const c = new DiskCache(join(dir, 'ttl'), () => now);
  c.set('k1', { v: 42 });
  now += 59_999;
  assert.deepEqual(c.get('k1', 60_000), { v: 42 });
  now += 2;
  assert.equal(c.get('k1', 60_000), undefined);
  assert.equal(c.get('no-such-key', 60_000), undefined);
  c.set('k2', 1);
  writeFileSync(join(dir, 'ttl', 'k2'.slice(0, 2), 'k2.json'), '{"savedAt":');
  assert.equal(c.get('k2', 60_000), undefined);
  // временных файлов после записи не остаётся
  assert.deepEqual(readdirSync(join(dir, 'ttl', 'k1')), ['k1.json']);
});

function setup(sub: string) {
  const clock = fakeClock(1_000_000);
  let calls = 0;
  const events: PoliteEvent['type'][] = [];
  const client = createClient({
    fetch: async (url) => {
      calls++;
      return url.endsWith('/bad') ? json({}, 400) : json({ n: calls });
    },
    retry: false,
    cache: { dir: join(dir, sub), ttlMs: 60_000 },
    clock,
    onEvent: (e) => events.push(e.type),
  });
  return { client, clock, calls: () => calls, events };
}

test('кэш: промах, потом попадание', async () => {
  const { client, calls, events } = setup('hit');
  const a = await client.json('https://api.example.com/items?page=1');
  const b = await client.json('https://api.example.com/items?page=1');
  assert.deepEqual(a, { n: 1 });
  assert.deepEqual(b, a);
  assert.equal(calls(), 1);
  assert.deepEqual(client.stats, { requests: 1, retries: 0, cacheHits: 1, cacheMisses: 1, failures: 0 });
  assert.deepEqual(events, ['cache-miss', 'request', 'response', 'cache-hit']);
  // другой URL и другое тело — другой ключ
  await client.json('https://api.example.com/items?page=2');
  await client.json('https://api.example.com/search', { method: 'POST', body: { q: 'a' }, idempotent: true });
  await client.json('https://api.example.com/search', { method: 'POST', body: { q: 'b' }, idempotent: true });
  assert.equal(calls(), 4);
  await client.json('https://api.example.com/search', { method: 'POST', body: { q: 'a' }, idempotent: true });
  assert.equal(calls(), 4, 'тот же POST с idempotent: true — из кэша');
});

test('кэш: POST без idempotent не кэшируется — каждый уходит на сервер', async () => {
  const { client, calls } = setup('post');
  await client.json('https://api.example.com/comments', { method: 'POST', body: { q: 1 } });
  await client.json('https://api.example.com/comments', { method: 'POST', body: { q: 1 } });
  assert.equal(calls(), 2);
  assert.equal(client.stats.cacheHits, 0);
  await client.json('https://api.example.com/comments', { method: 'POST', body: { q: 1 }, cacheTtlMs: 60_000 });
  await client.json('https://api.example.com/comments', { method: 'POST', body: { q: 1 }, cacheTtlMs: 60_000 });
  assert.equal(calls(), 3, 'явный cacheTtlMs включает кэш и для POST');
});

test('кэш: истечение TTL и свой TTL на запрос', async () => {
  const { client, clock, calls } = setup('ttl-client');
  await client.json('https://api.example.com/a');
  clock.advance(60_000);
  await client.json('https://api.example.com/a');
  assert.equal(calls(), 1, 'ровно на границе TTL запись ещё жива');
  clock.advance(1);
  assert.deepEqual(await client.json('https://api.example.com/a'), { n: 2 });
  assert.equal(calls(), 2);
  // свой TTL короче общего
  clock.advance(5_000);
  await client.json('https://api.example.com/a', { cacheTtlMs: 1_000 });
  assert.equal(calls(), 3);
});

test('кэш: cacheTtlMs: 0 обходит кэш, ошибки не кэшируются', async () => {
  const { client, calls } = setup('bypass');
  await client.json('https://api.example.com/a');
  await client.json('https://api.example.com/a', { cacheTtlMs: 0 });
  assert.equal(calls(), 2);
  await assert.rejects(client.json('https://api.example.com/bad'));
  await assert.rejects(client.json('https://api.example.com/bad'));
  assert.equal(calls(), 4);
  assert.equal(client.stats.cacheHits, 0);
});

test('кэш переживает новый клиент с тем же каталогом', async () => {
  const first = setup('persist');
  await first.client.json('https://api.example.com/a');
  const second = setup('persist');
  assert.deepEqual(await second.client.json('https://api.example.com/a'), { n: 1 });
  assert.equal(second.calls(), 0);
});
