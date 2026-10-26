import { checkNumber } from './check.ts';
import { realClock, sleep, type Clock } from './clock.ts';

/** Ответ не 2xx или тело, которое не прошло проверку. */
export class HttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  /** Начало тела ответа, до 500 знаков. */
  readonly body: string;

  constructor(message: string, status: number, retryable: boolean, retryAfterMs?: number, body = '') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.body = body;
  }
}

export interface RetryOptions {
  /** Сколько повторов после первой попытки. По умолчанию 4. */
  retries?: number;
  /** База экспоненты, мс. По умолчанию 500. */
  baseMs?: number;
  /** Потолок паузы между попытками, мс. По умолчанию 30 000. */
  maxMs?: number;
  /** Потолок для Retry-After, чтобы сервер не усыпил прогон на час. По умолчанию 60 000. */
  maxRetryAfterMs?: number;
}

export interface RetryRuntime {
  clock?: Clock;
  random?: () => number;
  signal?: AbortSignal;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export const retryDefaults: Required<RetryOptions> = { retries: 4, baseMs: 500, maxMs: 30_000, maxRetryAfterMs: 60_000 };

/** Числа в RetryOptions — конечные и неотрицательные, retries — целое. Иначе RangeError. */
export function checkRetryOptions(o: RetryOptions, prefix = 'retry'): void {
  checkNumber(`${prefix}.retries`, o.retries, { integer: true });
  checkNumber(`${prefix}.baseMs`, o.baseMs);
  checkNumber(`${prefix}.maxMs`, o.maxMs);
  checkNumber(`${prefix}.maxRetryAfterMs`, o.maxRetryAfterMs);
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/** Retry-After бывает в секундах или HTTP-датой. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

/** Полный джиттер: случайно от 0 до base·2^attempt, не больше max. */
export function backoffDelay(attempt: number, opts: { baseMs: number; maxMs: number }, random: () => number = Math.random): number {
  const cap = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);
  return Math.round(random() * cap);
}

/** Повторяем HttpError с retryable, обрыв соединения (TypeError у fetch) и свой таймаут. Отмену снаружи — нет. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.retryable;
  return err instanceof TypeError || (err instanceof Error && err.name === 'TimeoutError');
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}, rt: RetryRuntime = {}): Promise<T> {
  checkRetryOptions(options);
  const o = { ...retryDefaults, ...options };
  const clock = rt.clock ?? realClock;
  const random = rt.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= o.retries || !isRetryable(err) || rt.signal?.aborted) throw err;
      const hinted = err instanceof HttpError ? err.retryAfterMs : undefined;
      const delay = hinted !== undefined ? Math.min(hinted, o.maxRetryAfterMs) : backoffDelay(attempt, o, random);
      rt.onRetry?.(err, attempt + 1, delay);
      // пауза прерывается отменой сразу, а не после Retry-After в минуту
      await sleep(clock, delay, rt.signal);
    }
  }
}
