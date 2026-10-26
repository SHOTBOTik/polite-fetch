# polite-fetch

*In English.* polite-fetch is a small HTTP client for JSON APIs that enforce rate limits and fail now and then. It keeps a weighted token bucket per host (or per any key you choose), retries 429, 5xx, network errors and timeouts with exponential backoff and full jitter, and honours `Retry-After`. Only idempotent requests are retried and cached by default: a POST is sent once unless you mark it `idempotent: true`. Each attempt has its own timeout via `AbortController`, and successful responses can be cached on disk with a TTL, keyed by a hash of the request. An event callback and a stats object show requests, retries and cache hits. TypeScript, Node ≥ 22.18, zero runtime dependencies.

---

Небольшой HTTP-клиент для JSON API, у которых есть лимиты и которые иногда падают.

## Что делает и зачем

Когда нужно выгрузить много данных из публичного API, мешают три вещи: сервер режет за превышение лимита, отвечает 429 и 503 под нагрузкой и иногда просто зависает. polite-fetch закрывает их в одном месте:

- **лимит** — token bucket на каждый хост или свой ключ, у запроса есть вес;
- **повторы** — 429, 408, 5xx, обрыв соединения и таймаут; пауза экспоненциальная с полным джиттером, `Retry-After` в секундах или HTTP-датой имеет приоритет. POST и PATCH по умолчанию не повторяются, см. `idempotent`;
- **таймаут** — на каждую попытку, через `AbortController`;
- **кэш** — необязательный, на диске, с TTL; ключ — sha256 от метода, URL и тела;
- **статистика** — счётчики и событие на каждый шаг.

Вынесено из моего инструмента для выгрузки больших объёмов публичных данных.

## Быстрый старт

Нужен Node ≥ 22.18: он запускает TypeScript сам, без сборки. Зависимостей во время работы нет.

```sh
git clone https://github.com/SHOTBOTik/polite-fetch
```

```ts
import { createClient } from './polite-fetch/src/index.ts';

const client = createClient({
  limits: { 'api.example.com': { ratePerSec: 5, burst: 10 } },
  retry: { retries: 4, baseMs: 500, maxMs: 30_000 },
  timeoutMs: 15_000,
  cache: { dir: '.cache/http', ttlMs: 60 * 60_000 },
});

const page = await client.json<{ items: unknown[] }>('https://api.example.com/v1/items?page=1');
console.log(client.stats); // { requests: 1, retries: 0, cacheHits: 0, cacheMisses: 1, failures: 0 }
```

Пакет не публикуется в npm (`"private": true`). Node снимает типы только у файлов вне `node_modules`, поэтому подключайте `src/index.ts` из клона или копируйте нужные файлы в свой проект.

## API

### `createClient(options?)`

| Опция | Что делает |
|---|---|
| `limits` | `{ [ключ]: { ratePerSec, burst? } }`. Ключ по умолчанию — `host` из URL (с портом, если он не стандартный). `'*'` — лимит для всех остальных ключей. Ключ без лимита не ждёт. |
| `limitKey(url)` | Свой ключ лимита: по API-ключу, по группе путей. Получает `URL`. |
| `retry` | `{ retries = 4, baseMs = 500, maxMs = 30000, maxRetryAfterMs = 60000 }` или `false`. |
| `timeoutMs` | Таймаут одной попытки, по умолчанию 30 000. |
| `cache` | `{ dir, ttlMs }`. Без этой опции кэша нет. |
| `headers` | Заголовки для каждого запроса. |
| `onEvent(e)` | Событие на каждый шаг, см. ниже. |
| `fetch`, `clock`, `random` | Подмена для тестов: свой `fetch`, часы `{ now, sleep }`, генератор джиттера. |

Числа в опциях проверяются сразу: `retries` — целое ≥ 0, паузы ≥ 0, `timeoutMs` и `ratePerSec`/`burst` — больше нуля, всё конечное. `NaN`, `Infinity` или отрицательное значение — `RangeError` с именем опции, а не бесконечные повторы или вечное ожидание. То же для `weight`, `timeoutMs` и `retry` у запроса.

### `client.json<T>(url, options?)`

| Опция | Что делает |
|---|---|
| `method`, `body`, `headers` | Тело не строкой уходит как JSON с `content-type: application/json`. |
| `weight` | Вес в ведре, по умолчанию 1. Каждая попытка, включая повтор, тратит вес. |
| `limitKey` | Ключ лимита для этого запроса. |
| `cacheTtlMs` | Свой срок в кэше; `0` — не читать и не писать кэш. |
| `idempotent` | Можно ли повторить запрос и взять ответ из кэша. По умолчанию `true` для GET, HEAD, OPTIONS; PUT и DELETE повторяются, но не кэшируются; POST, PATCH и прочие не повторяются и не кэшируются, пока не задать `idempotent: true` или явно `retry`/`cacheTtlMs`. Повтор POST с побочным действием выполнил бы его дважды, ответ из кэша — ни разу. |
| `timeoutMs`, `retry` | Свои таймаут и повторы. |
| `signal` | Отмена снаружи. Прерывает и попытку, и ожидание в ведре, и паузу перед повтором (даже минутный `Retry-After`). Отменённый запрос не повторяется. |
| `check(data)` | Проверка тела. Бросьте `HttpError` с `retryable: true`, если сервер ответил 200 с ошибкой внутри, — запрос повторится. |

Ошибка ответа — `HttpError` с полями `status`, `retryable`, `retryAfterMs` и `body` (первые 500 знаков). Таймаут — `DOMException` с именем `TimeoutError`.

### Остальное

- `client.stats` — `{ requests, retries, cacheHits, cacheMisses, failures }`; `requests` считает попытки, ушедшие в сеть.
- `client.bucket(key)` — ведро ключа или `undefined`.
- `client.charge(key, weight)` — довесить вес, который стал известен только по ответу: например, сервер берёт по единице за каждый элемент списка. Ведро уходит в долг, следующий запрос подождёт.
- `limitForWindow(limit, windowSec)` — перевести лимит «N запросов за окно» в `{ ratePerSec, burst }`: 20% на залп, 80% на поток, чтобы залп и пополнение вместе уложились в окно.
- `TokenBucket`, `DiskCache`, `withRetry`, `backoffDelay`, `parseRetryAfter`, `isRetryableStatus` — части по отдельности.

### События

```ts
type PoliteEvent =
  | { type: 'request'; method; url; attempt; limitKey; weight }
  | { type: 'response'; method; url; attempt; status; ms }
  | { type: 'retry'; method; url; attempt; delayMs; error }
  | { type: 'cache-hit' | 'cache-miss'; method; url; key }
  | { type: 'failure'; method; url; error };
```

## Примеры

Лимит «1200 весов в минуту», тяжёлый запрос весит 20:

```ts
import { createClient, limitForWindow } from './polite-fetch/src/index.ts';

const client = createClient({ limits: { 'api.example.com': limitForWindow(1200, 60) } });
// POST, который только читает: его можно повторять и кэшировать
const report = await client.json('https://api.example.com/v1/report', { method: 'POST', body: { range: '30d' }, weight: 20, idempotent: true });
```

Один лимит на API-ключ, а не на хост:

```ts
const client = createClient({
  limits: { 'key:demo': { ratePerSec: 2 } },
  limitKey: () => 'key:demo',
  headers: { 'x-api-key': process.env.EXAMPLE_API_KEY ?? '' },
});
```

Сервер отвечает 200 с ошибкой в теле:

```ts
import { HttpError } from './polite-fetch/src/index.ts';

const data = await client.json('https://api.example.com/v1/items', {
  check: (d) => {
    const body = d as { status?: string };
    if (body.status === 'busy') throw new HttpError('busy', 200, true);
  },
});
```

Лог повторов:

```ts
const client = createClient({
  onEvent: (e) => {
    if (e.type === 'retry') console.warn(`${e.url}: попытка ${e.attempt} через ${e.delayMs} мс`);
  },
});
```

## Как устроено

- **Ведро.** Токены пополняются непрерывно со скоростью `ratePerSec`, ёмкость — `burst`. Ожидающие запросы стоят в одной очереди на ключ и выходят строго по порядку, поэтому тяжёлый запрос не голодает за потоком лёгких. Вес больше `burst` ждёт полного ведра, а не вечно.
- **Повторы.** Пауза — случайная от 0 до `min(maxMs, baseMs · 2^n)` («полный джиттер»): параллельные клиенты не бьют в сервер одновременно. Если пришёл `Retry-After`, берётся он, но не больше `maxRetryAfterMs`. Каждая попытка снова берёт вес из ведра: сервер считает и повторы.
- **Таймаут.** Свой `AbortController` на каждую попытку; внешний `signal` объединяется с ним через `AbortSignal.any`. Таймаут повторяется, внешняя отмена — нет.
- **Кэш.** Файл на ключ в `dir/<первые 2 знака>/<sha256>.json`, запись через временный файл и `rename`. Срок проверяется при чтении. Кэшируются только успешные ответы, прошедшие `check`, и по умолчанию только GET, HEAD, OPTIONS. Битый файл — это промах, а не ошибка.

## Ограничения

- Только JSON-ответы: `client.json` всегда разбирает тело как JSON.
- Лимит живёт в памяти одного процесса. Несколько процессов на один API делят лимит только если вы сами разделите `ratePerSec` между ними.
- Заголовки не входят в ключ кэша. Если ответ зависит от заголовка (токен, язык), разводите кэш по разным `dir` или выключайте его для таких запросов.
- Старые записи кэша с диска не удаляются сами; есть `DiskCache.clear()`.
- Ответ не читается потоком: большое тело целиком в памяти.
- Таймаут меряется настоящим временем, а не подменёнными часами.

## Тесты

```sh
npm install      # только typescript и @types/node для проверки типов
npm run typecheck
npm test
```

Тесты на `node:test`, без внешней сети. Повторы и таймауты проверяются на локальном http-сервере на петлевом адресе: он отдаёт 429 с `Retry-After`, потом 503, потом 200; другой маршрут зависает. Кэш — попадание, промах, истечение TTL, обход. Тайминги ведра — на подменённых часах, без настоящего ожидания.

## Автор и лицензия

[SHOTBOTik](https://shotbotik.me) · MIT, см. [LICENSE](LICENSE).
