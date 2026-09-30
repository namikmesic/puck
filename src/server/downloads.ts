/**
 * Runner downloads, served only by a development server (`PUCK_DEVELOPMENT`;
 * elsewhere the directory is null, the list is empty, and every file is
 * 404). The development image packages this version's tarballs into the
 * `PUCK_RUNNER_DOWNLOADS` directory as
 *
 *   <version>/puck-runner-<os>-<arch>-<version>.tar.gz     os: linux | macos, arch: x64 | arm64
 *
 * and the server publishes them: `GET /v1/runner/releases` lists the latest
 * version's assets with their sha256 and the minimum version this server
 * accepts; `GET /runner/<version>/<file>` serves a tarball, and
 * `<file>.sha256` its checksum line. Only names matching that pattern are
 * ever served, so no request path reaches outside the directory. Checksums
 * are computed once per file (keyed by size and mtime) and cached.
 */

import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { compareVersions } from './config';
import type { ServerContext } from './context';
import { HttpError, type Router } from './http';

const VERSION = '\\d+\\.\\d+\\.\\d+';
const VERSION_RE = new RegExp(`^${VERSION}$`);
const FILE_RE = new RegExp(`^puck-runner-(linux|macos)-(x64|arm64)-(${VERSION})\\.tar\\.gz$`);

export interface RunnerAsset {
  os: string;
  arch: string;
  version: string;
  file: string;
  url: string;
  sha256: string;
  size: number;
}

export class RunnerDownloads {
  private sums = new Map<string, { key: string; sha256: string }>();

  constructor(
    private dir: string | null,
    private publicUrl: string,
  ) {}

  private async sha256(path: string, size: number, mtimeMs: number): Promise<string> {
    const key = `${size}:${mtimeMs}`;
    const cached = this.sums.get(path);
    if (cached?.key === key) return cached.sha256;
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      createReadStream(path)
        .on('data', (chunk) => hash.update(chunk))
        .on('end', resolve)
        .on('error', reject);
    });
    const sha256 = hash.digest('hex');
    this.sums.set(path, { key, sha256 });
    return sha256;
  }

  async versions(): Promise<string[]> {
    if (!this.dir) return [];
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    return names.filter((n) => VERSION_RE.test(n)).sort((a, b) => compareVersions(b, a));
  }

  async assets(version: string): Promise<RunnerAsset[]> {
    if (!this.dir || !VERSION_RE.test(version)) return [];
    let names: string[];
    try {
      names = await fs.readdir(join(this.dir, version));
    } catch {
      return [];
    }
    const out: RunnerAsset[] = [];
    for (const file of names.sort()) {
      const m = FILE_RE.exec(file);
      if (!m || m[3] !== version) continue;
      const path = join(this.dir, version, file);
      const st = await fs.stat(path);
      if (!st.isFile()) continue;
      out.push({
        os: m[1],
        arch: m[2],
        version,
        file,
        url: `${this.publicUrl}/runner/${version}/${file}`,
        sha256: await this.sha256(path, st.size, st.mtimeMs),
        size: st.size,
      });
    }
    return out;
  }

  /** The file's path and size when `version/file` names a published tarball. */
  async locate(version: string, file: string): Promise<{ path: string; size: number; sha256: string } | null> {
    const m = FILE_RE.exec(file);
    if (!this.dir || !VERSION_RE.test(version) || !m || m[3] !== version) return null;
    const path = join(this.dir, version, file);
    try {
      const st = await fs.stat(path);
      return st.isFile() ? { path, size: st.size, sha256: await this.sha256(path, st.size, st.mtimeMs) } : null;
    } catch {
      return null;
    }
  }
}

export function registerDownloadRoutes(router: Router, ctx: ServerContext, downloads: RunnerDownloads): void {
  router.add('GET', '/v1/runner/releases', async () => {
    const versions = await downloads.versions();
    let latest: string | null = null;
    let assets: RunnerAsset[] = [];
    for (const v of versions) {
      assets = await downloads.assets(v);
      if (assets.length) {
        latest = v;
        break;
      }
    }
    return { body: { latest, minVersion: ctx.config.minRunnerVersion, assets } };
  });

  router.add('GET', '/runner/:version/:file', async (req) => {
    const { version } = req.params;
    const wantsSum = req.params.file.endsWith('.sha256');
    const file = wantsSum ? req.params.file.slice(0, -'.sha256'.length) : req.params.file;
    const found = await downloads.locate(version, file);
    if (!found) throw new HttpError(404, 'not-found', 'No such runner download.');
    if (wantsSum) return { text: `${found.sha256}  ${file}\n` };
    req.res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': String(found.size),
      'Content-Disposition': `attachment; filename="${file}"`,
      'Cache-Control': 'public, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    await new Promise<void>((resolve) => {
      const stream = createReadStream(found.path);
      stream.on('error', () => {
        req.res.destroy();
        resolve();
      });
      stream.on('end', () => resolve());
      stream.pipe(req.res);
    });
    return { streamed: true };
  });
}
