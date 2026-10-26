import { TokenBucket, type LimitSpec } from './bucket.ts';
import { cacheKey, DiskCache } from './cache.ts';
import { checkNumber } from './check.ts';
import { realClock, type Clock } from './clock.ts';
import { checkRetryOptions, HttpError, isRetryableStatus, parseRetryAfter, withRetry, type RetryOptions } from './retry.ts';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type PoliteEvent =
  | { type: 'request'; method: string; url: string; attempt: number; limitKey: string; weight: number }
  | { type: 'response'; method: string; url: string; attempt: number; status: number; ms: number }
  | { type: 'retry'; method: string; url: string; attempt: number; delayMs: number; error: unknown }
  | { type: 'cache-hit'; method: string; url: string; key: string }
  | { type: 'cache-miss'; method: string; url: string; key: string }
  | { type: 'failure'; method: string; url: string; error: unknown };

export interface ClientOptions {
  /** Лимиты по ключу; ключ по умолчанию — host из URL (с портом, если он не стандартный). '*' — для всех остальных. */
  limits?: Record<string, LimitSpec>;
  /** Свой ключ лимита, например по API-ключу или по группе путей. */
  limitKey?: (url: URL) => string;
  /** Повторы; false — без повторов. */
  retry?: RetryOptions | false;
  /** Таймаут одной попытки, мс. По умолчанию 30 000. */
  timeoutMs?: number;
  /** Кэш на диске. ttlMs — срок по умолчанию; 0 — кэш только для запросов со своим cacheTtlMs. */
  cache?: { dir: string; ttlMs: number };
  /** Заголовки для каждого запроса. */
  headers?: Record<string, string>;
  /** Свой fetch: для тестов или прокси. */
  fetch?: FetchFn;
  clock?: Clock;
  random?: () => number;
  onEvent?: (event: PoliteEvent) => void;
}

export interface RequestOptions {
  method?: string;
  /** Тело; не строка — отправляется как JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Вес запроса в ведре. По умолчанию 1. */
  weight?: number;
  /** Ключ лимита вместо вычисленного по URL. */
  limitKey?: string;
  /** Срок жизни в кэше для этого запроса; 0 — не читать и не писать кэш. */
  cacheTtlMs?: number;
  /**
   * Запрос можно повторить без вреда, а его ответ — взять из кэша. По умолчанию true для GET, HEAD, OPTIONS
   * (для PUT и DELETE — только повторы), false для POST, PATCH и прочих: их не повторяют и не кэшируют,
   * если не задать здесь true или явно `retry`/`cacheTtlMs` у запроса. POST, который только читает, — `idempotent: true`.
   */
  idempotent?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  retry?: RetryOptions | false;
  /** Проверка тела. Бросьте HttpError с retryable: true, если сервер ответил 200 с ошибкой внутри. */
  check?: (data: unknown) => void;
}

export interface ClientStats {
  /** Попытки, ушедшие в сеть, включая повторы. */
  requests: number;
  retries: number;
  cacheHits: number;
  cacheMisses: number;
  /** Запросы, которые так и не удались. */
  failures: number;
}

export interface Client {
  json<T = unknown>(url: string, opts?: RequestOptions): Promise<T>;
  /** Ведро для ключа; undefined — ключ без лимита. */
  bucket(limitKey: string): TokenBucket | undefined;
  /** Довесить вес, известный только по ответу. */
  charge(limitKey: string, weight: number): void;
  readonly stats: ClientStats;
}

const noRetry: RetryOptions = { retries: 0 };
/** Больше setTimeout не умеет: такой таймаут сработал бы сразу. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const REPLAYABLE = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const CACHEABLE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createClient(options: ClientOptions = {}): Client {
  // Опции проверяются сразу: NaN в retries — бесконечные повторы, ratePerSec: 0 — вечное ожидание.
  checkNumber('timeoutMs', options.timeoutMs, { positive: true, max: MAX_TIMEOUT_MS });
  if (options.retry) checkRetryOptions(options.retry);
  for (const [k, spec] of Object.entries(options.limits ?? {})) {
    checkNumber(`limits['${k}'].ratePerSec`, spec.ratePerSec ?? NaN, { positive: true });
    checkNumber(`limits['${k}'].burst`, spec.burst, { positive: true });
  }
  const clock = options.clock ?? realClock;
  const fetchFn: FetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  const emit = options.onEvent ?? (() => {});
  const cache = options.cache ? new DiskCache(options.cache.dir, () => clock.now()) : null;
  const stats: ClientStats = { requests: 0, retries: 0, cacheHits: 0, cacheMisses: 0, failures: 0 };
  const buckets = new Map<string, TokenBucket | null>();

  const bucket = (key: string): TokenBucket | undefined => {
    let b = buckets.get(key);
    if (b === undefined) {
      const spec = options.limits?.[key] ?? options.limits?.['*'];
      b = spec ? new TokenBucket(spec, clock) : null;
      buckets.set(key, b);
    }
    return b ?? undefined;
  };

  async function once(method: string, url: string, attempt: number, key: string, o: RequestOptions): Promise<unknown> {
    const weight = o.weight ?? 1;
    // Каждая попытка, включая повтор, тратит вес: сервер считает и их.
    await bucket(key)?.take(weight, o.signal);
    o.signal?.throwIfAborted();
    stats.requests++;
    emit({ type: 'request', method, url, attempt, limitKey: key, weight });
    const started = clock.now();
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException('timeout', 'TimeoutError')),
      o.timeoutMs ?? options.timeoutMs ?? 30_000,
    );
    const signal = o.signal ? AbortSignal.any([timeout.signal, o.signal]) : timeout.signal;
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers, ...o.headers };
    let body: string | undefined;
    if (o.body !== undefined) {
      body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
      if (typeof o.body !== 'string' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
    }
    try {
      const res = await fetchFn(url, { method, headers, body, signal });
      emit({ type: 'response', method, url, attempt, status: res.status, ms: clock.now() - started });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 500);
        throw new HttpError(
          `${method} ${url} -> ${res.status}`,
          res.status,
          isRetryableStatus(res.status),
          parseRetryAfter(res.headers.get('retry-after'), clock.now()),
          text,
        );
      }
      const data: unknown = await res.json();
      o.check?.(data);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function json<T>(url: string, o: RequestOptions = {}): Promise<T> {
    const method = (o.method ?? 'GET').toUpperCase();
    checkNumber('weight', o.weight);
    checkNumber('timeoutMs', o.timeoutMs, { positive: true, max: MAX_TIMEOUT_MS });
    if (o.retry) checkRetryOptions(o.retry);
    const key = o.limitKey ?? (options.limitKey ?? ((u: URL) => u.host))(new URL(url));
    // Повтор или ответ из кэша для POST с побочным действием — второе действие или ни одного. Поэтому общие
    // retry и cache.ttlMs действуют только на запросы, которые можно повторить; явная опция запроса сильнее.
    const replayable = o.idempotent ?? REPLAYABLE.has(method);
    const cacheable = o.idempotent ?? CACHEABLE.has(method);
    const ttl = o.cacheTtlMs ?? (cacheable ? options.cache?.ttlMs : 0) ?? 0;
    const ck = cache && ttl > 0 ? cacheKey([method, url, o.body ?? null]) : null;
    if (cache && ck) {
      const hit = cache.get<T>(ck, ttl);
      if (hit !== undefined) {
        stats.cacheHits++;
        emit({ type: 'cache-hit', method, url, key: ck });
        return hit;
      }
      stats.cacheMisses++;
      emit({ type: 'cache-miss', method, url, key: ck });
    }
    const retry = o.retry ?? (replayable ? options.retry : false);
    try {
      const data = await withRetry((attempt) => once(method, url, attempt, key, o), retry === false ? noRetry : retry, {
        clock,
        ...(options.random ? { random: options.random } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
        onRetry: (error, attempt, delayMs) => {
          stats.retries++;
          emit({ type: 'retry', method, url, attempt, delayMs, error });
        },
      });
      if (cache && ck) cache.set(ck, data);
      return data as T;
    } catch (error) {
      stats.failures++;
      emit({ type: 'failure', method, url, error });
      throw error;
    }
  }

  return {
    json,
    bucket,
    charge: (key, weight) => bucket(key)?.charge(weight),
    stats,
  };
}
