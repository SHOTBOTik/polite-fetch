/**
 * Проверка числовой опции: конечное и неотрицательное (или положительное) число.
 * NaN в `retries` дал бы бесконечные повторы, а Infinity в таймауте — вечное ожидание, поэтому лучше сразу понятная ошибка.
 */
export function checkNumber(name: string, value: unknown, kind: { integer?: boolean; positive?: boolean; max?: number } = {}): void {
  if (value === undefined) return;
  const ok =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (kind.positive ? value > 0 : value >= 0) &&
    (!kind.integer || Number.isInteger(value)) &&
    (kind.max === undefined || value <= kind.max);
  if (!ok) {
    const what = `${kind.positive ? 'положительное' : 'неотрицательное'}${kind.integer ? ' целое' : ''} конечное число${kind.max === undefined ? '' : ` не больше ${kind.max}`}`;
    throw new RangeError(`polite-fetch: ${name} — нужно ${what}, а не ${typeof value === 'string' ? `'${value}'` : String(value)}`);
  }
}
