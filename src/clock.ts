/** Часы, которые можно подменить в тестах: now — миллисекунды, sleep — пауза. */
export interface Clock {
  now(): number;
  /** Пауза. signal — необязательная подсказка: можно снять таймер при отмене. Прерывание гарантирует `sleep()` ниже. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
    }),
};

/** Обещание p, которое при отмене сразу отклоняется с signal.reason; само p продолжает идти. */
export function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Пауза по часам clock, которая при отмене сразу отклоняется с signal.reason. */
export function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return abortable(clock.sleep(ms, signal), signal);
}
