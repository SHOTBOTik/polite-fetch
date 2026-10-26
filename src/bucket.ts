import { realClock, type Clock } from './clock.ts';

export interface LimitSpec {
  /** Сколько веса восстанавливается за секунду. */
  ratePerSec: number;
  /** Сколько веса можно потратить залпом. По умолчанию — ratePerSec, но не меньше 1. */
  burst?: number;
}

/**
 * Лимит вида «limit за windowSec» в параметры ведра. Сервер считает окном, а ведро
 * позволяет залп, поэтому залп и пополнение за окно вместе должны уложиться в лимит:
 * 20% на залп, 80% на равномерный поток.
 */
export function limitForWindow(limit: number, windowSec: number): Required<LimitSpec> {
  if (!(limit > 0) || !(windowSec > 0)) throw new Error('limit и windowSec должны быть > 0');
  return { burst: Math.max(1, Math.floor(limit * 0.2)), ratePerSec: (limit * 0.8) / windowSec };
}

/**
 * Token bucket с весом запроса. Запросы обслуживаются строго по очереди,
 * поэтому тяжёлый запрос не голодает за потоком лёгких.
 */
export class TokenBucket {
  readonly burst: number;
  readonly ratePerSec: number;
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();
  private clock: Clock;

  constructor(spec: LimitSpec, clock: Clock = realClock) {
    const burst = spec.burst ?? Math.max(1, spec.ratePerSec);
    if (!(burst > 0) || !(spec.ratePerSec > 0)) throw new Error('ratePerSec и burst должны быть > 0');
    this.burst = burst;
    this.ratePerSec = spec.ratePerSec;
    this.clock = clock;
    this.tokens = burst;
    this.last = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
  }

  /** Сколько веса доступно прямо сейчас; после charge бывает отрицательным. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** Дождаться, пока накопится weight, и потратить его. */
  take(weight = 1): Promise<void> {
    // Вес больше залпа не дождался бы никогда: ждём полного ведра.
    const w = Math.min(Math.max(0, weight), this.burst);
    const run = async () => {
      for (;;) {
        this.refill();
        if (this.tokens >= w) {
          this.tokens -= w;
          return;
        }
        await this.clock.sleep(Math.ceil(((w - this.tokens) / this.ratePerSec) * 1000));
      }
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Довесить вес, который стал известен только по ответу. Ведро уходит в долг. */
  charge(weight: number): void {
    this.refill();
    this.tokens -= weight;
  }
}
