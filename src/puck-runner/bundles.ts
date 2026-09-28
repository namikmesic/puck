/**
 * The daemon bundle cache: `cache/daemon/<sha256>.js`. The app supplies the
 * daemon (its version is the app's), uploading a bundle only when
 * `bundle.has` says the runner lacks it; the runner copies cached bundles
 * into containers on create, rebuild and daemon upgrade. An upload arrives
 * in ordered chunks into `<sha256>.partial` and becomes `<sha256>.js` only
 * when the whole file hashes to the name. The newest few bundles are kept.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RUNNER_LIMITS } from '../harness/runner-protocol';

export const SHA_RE = /^[0-9a-f]{64}$/;
const KEEP = 5;

export class BundleError extends Error {
  constructor(
    readonly code: 'invalid-args' | 'not-found' | 'limit',
    message: string,
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

export class BundleCache {
  constructor(private readonly dir: string) {}

  private file(sha: string): string {
    if (!SHA_RE.test(sha)) throw new BundleError('invalid-args', 'A bundle is named by its sha256 (64 lowercase hex).');
    return path.join(this.dir, `${sha}.js`);
  }

  has(sha: string): boolean {
    return fs.existsSync(this.file(sha));
  }

  get(sha: string): Buffer {
    try {
      return fs.readFileSync(this.file(sha));
    } catch {
      throw new BundleError('not-found', 'That daemon bundle is not in the runner cache; upload it with bundle.put first.');
    }
  }

  /** Appends one chunk at `offset` (which must be the bytes received so far). */
  put(sha: string, offset: number, data: Buffer, last: boolean): { received: number; complete: boolean } {
    const final = this.file(sha);
    if (fs.existsSync(final)) return { received: fs.statSync(final).size, complete: true };
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const partial = path.join(this.dir, `${sha}.partial`);
    let size = 0;
    try {
      size = fs.statSync(partial).size;
    } catch {
      size = 0;
    }
    if (offset === 0 && size > 0) {
      fs.rmSync(partial, { force: true });
      size = 0;
    }
    if (offset !== size) throw new BundleError('invalid-args', `Expected the chunk at offset ${size}, got ${offset}.`);
    if (size + data.length > RUNNER_LIMITS.maxBundleBytes) {
      fs.rmSync(partial, { force: true });
      throw new BundleError('limit', 'The daemon bundle is too large.');
    }
    fs.appendFileSync(partial, data, { mode: 0o600 });
    size += data.length;
    if (!last) return { received: size, complete: false };
    const actual = createHash('sha256').update(fs.readFileSync(partial)).digest('hex');
    if (actual !== sha) {
      fs.rmSync(partial, { force: true });
      throw new BundleError('invalid-args', 'The uploaded bundle does not match its sha256.');
    }
    fs.renameSync(partial, final);
    this.prune(sha);
    return { received: size, complete: true };
  }

  /** Keeps the newest bundles (and always `keep`). */
  private prune(keep: string): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => /^[0-9a-f]{64}\.js$/.test(n));
    } catch {
      return;
    }
    const byAge = names
      .map((n) => ({ n, t: fs.statSync(path.join(this.dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .map((x) => x.n);
    for (const name of byAge.slice(KEEP)) {
      if (name !== `${keep}.js`) fs.rmSync(path.join(this.dir, name), { force: true });
    }
  }
}
