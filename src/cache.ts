import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Ключ кэша — sha256 от частей запроса. */
export function cacheKey(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Кэш ответов на диске: файл на ключ, срок жизни проверяется при чтении. */
export class DiskCache {
  readonly dir: string;
  private now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir;
    this.now = now;
  }

  private path(key: string): string {
    return join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  /** undefined — промах: записи нет, она старше ttlMs или битая. */
  get<T>(key: string, ttlMs: number): T | undefined {
    try {
      const entry = JSON.parse(readFileSync(this.path(key), 'utf8')) as { savedAt: number; value: T };
      return this.now() - entry.savedAt <= ttlMs ? entry.value : undefined;
    } catch {
      return undefined; // нет файла или он битый — это промах, не ошибка
    }
  }

  set(key: string, value: unknown): void {
    const file = this.path(key);
    mkdirSync(dirname(file), { recursive: true });
    // запись через временный файл: обрыв посреди записи не оставит полуфайл
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ savedAt: this.now(), value }));
    renameSync(tmp, file);
  }

  delete(key: string): void {
    rmSync(this.path(key), { force: true });
  }

  /** Удалить весь каталог кэша. */
  clear(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
