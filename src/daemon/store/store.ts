/**
 * One JSON store file held in memory: loaded once at boot (with `??`
 * defaults for fields a newer daemon added), mutated in place, saved
 * atomically. `save` is fire-and-forget; `flush` waits for durability.
 */

import * as path from 'node:path';
import { readJsonFile, writeFileAtomicSync, writeJsonAtomic } from './jsonfile';

export class JsonStore<T> {
  private value: T;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    readonly file: string,
    defaults: () => T,
    normalize: (raw: unknown) => T = (raw) => raw as T,
  ) {
    const raw = readJsonFile<unknown>(file);
    this.value = raw === null ? defaults() : normalize(raw);
  }

  get(): T {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    this.save();
  }

  save(): void {
    this.pending = writeJsonAtomic(this.file, this.value);
  }

  /** Writes the current value before returning, ahead of any earlier queued save. */
  commit(): void {
    this.pending = writeJsonAtomic(this.file, this.value);
    writeFileAtomicSync(this.file, JSON.stringify(this.value));
  }

  /** Resolves once the last save is on disk (rejects if it failed). */
  flush(): Promise<void> {
    return this.pending;
  }

  get name(): string {
    return path.basename(this.file);
  }
}
