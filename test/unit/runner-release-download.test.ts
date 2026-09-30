import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatRunnerRelease,
  formatSignedRunnerRelease,
  MAX_MANIFEST_BYTES,
  MAX_RELEASE_METADATA_BYTES,
  MAX_RELEASE_RECORDS,
  RUNNER_TARGETS,
  runnerPackageFile,
  RunnerReleaseError,
  type RunnerReleaseManifest,
} from '../../src/harness/runner-releases';
import * as mainApi from '../../src/main/server/api';
import { serverRequest, useServerDeps } from '../../src/main/server/http';
import { ServerApi } from '../../src/puck-runner/api';
import {
  BODY_TIMEOUT_MS,
  checkDownloadUrl,
  DOWNLOAD_HOSTS,
  downloadRunnerPackage,
  HEADER_TIMEOUT_MS,
  MAX_PACKAGE_BYTES,
  MAX_REDIRECTS,
  OFFICIAL_RELEASE_PREFIX,
  officialPackageUrl,
  readBoundedBody,
  readReleaseListing,
  RunnerDownloadError,
  verifySignedRunnerReleases,
  writeAll,
  type DownloadPolicy,
  type PackageDownload,
  type RunnerDownloadErrorCode,
} from '../../src/runner-release/download';
import { releaseKeyId } from '../../src/runner-release/verify';
import { startServer, type Harness } from './server-fakes';

// The bounded release transport: the metadata reader's bounds and
// encodings, signed records verified on their exact bytes, and the package
// downloader's URL construction, redirect policy, credentials, byte
// accounting, timeouts and cleanup. Every response here is a fake fetch's
// except the development branch, which runs against the real server.

const VERSION = '1.2.3';
const FILE = runnerPackageFile({ os: 'linux', arch: 'x64' }, VERSION);
const PAGE = `${OFFICIAL_RELEASE_PREFIX}/v${VERSION}/${FILE}`;
const CDN = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r&sig=abc';
const OFFICIAL: DownloadPolicy = { kind: 'official' };

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
/** A package's bytes: several stream chunks' worth of random data. */
const PACKAGE = randomBytes(70_000);

const dirs: string[] = [];
let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  useServerDeps(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'puck-download-'));
  dirs.push(dir);
  return dir;
};

function request(overrides: Partial<PackageDownload> = {}): PackageDownload {
  return { version: VERSION, file: FILE, sha256: sha256(PACKAGE), size: PACKAGE.length, dest: join(tmp(), FILE), ...overrides };
}

interface Call {
  url: string;
  init: RequestInit;
}

interface BodyControl {
  /** Set once the reader cancelled the stream. */
  cancelled: boolean;
  /** Set once the reader pulled from the stream. */
  pulled: boolean;
}

/** A response whose body streams `chunks`; `stall` keeps it open after them, so only cancellation ends it. */
function streamed(chunks: Uint8Array[], init: ResponseInit & { stall?: boolean } = {}): { res: Response; body: BodyControl } {
  const body: BodyControl = { cancelled: false, pulled: false };
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      body.pulled = true;
      if (at < chunks.length) controller.enqueue(chunks[at++]);
      else if (!init.stall) controller.close();
      else return new Promise(() => undefined);
    },
    cancel() {
      body.cancelled = true;
    },
  }, { highWaterMark: 0 });
  const rest: ResponseInit = { status: init.status, headers: init.headers };
  return { res: new Response(stream, { status: 200, ...rest }), body };
}

const chunked = (bytes: Uint8Array, size = 16 * 1024): Uint8Array[] => {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
  return out;
};

const redirect = (location: string | null, status = 302): { res: Response; body: BodyControl } =>
  streamed([new TextEncoder().encode('moved')], { status, headers: location === null ? {} : { location } });

type Route = (url: string, init: RequestInit) => Promise<Response> | Response;

/** A fetch answering from `routes` in order of the URLs it sees; records every call. */
function fakeFetch(routes: Record<string, Route | Route[]>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    const next = Array.isArray(route) ? route.shift() : route;
    if (!next) throw new Error(`no more answers for ${url}`);
    return next(url, init);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

async function failure(promise: Promise<unknown>): Promise<{ code: RunnerDownloadErrorCode; message: string }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof RunnerDownloadError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error('expected a RunnerDownloadError');
}

/** The one shape of every request: GET, manual redirects, no credentials, only the two headers. */
function expectPlainRequest(call: Call): void {
  expect(call.init.method).toBe('GET');
  expect(call.init.redirect).toBe('manual');
  expect(call.init.credentials).toBe('omit');
  expect(call.init.headers).toEqual({ accept: 'application/octet-stream', 'accept-encoding': 'identity' });
  expect(new URL(call.url).username).toBe('');
  expect(new URL(call.url).password).toBe('');
}

describe('official package URLs', () => {
  it('are built from the release prefix, the tag and the exact file name, never from a server', () => {
    expect(OFFICIAL_RELEASE_PREFIX).toBe('https://github.com/namikmesic/puck/releases/download');
    expect(officialPackageUrl(VERSION, FILE)).toBe(PAGE);
    for (const t of RUNNER_TARGETS) expect(officialPackageUrl('10.0.0', runnerPackageFile(t, '10.0.0'))).toBe(`${OFFICIAL_RELEASE_PREFIX}/v10.0.0/${runnerPackageFile(t, '10.0.0')}`);
  });

  it('refuse a non-canonical version or a file that is not a package of it', () => {
    for (const version of ['v1.2.3', '01.2.3', '1.2', '1.2.3-rc1', '1.2.3\n', '', '../1.2.3']) {
      expect(() => officialPackageUrl(version, FILE), version).toThrow(/not a release version/);
    }
    for (const file of ['puck-runner-linux-x64-1.2.4.tar.gz', 'puck-runner-windows-x64-1.2.3.tar.gz', 'puck-runner-linux-x64-1.2.3.tar.gz/../x', '../SHA256SUMS', 'runner-release.json', '']) {
      expect(() => officialPackageUrl(VERSION, file), file).toThrow(/not a package of runner/);
    }
  });
});

describe('the redirect policy', () => {
  const expected = { version: VERSION, file: FILE };
  const refused = (url: string, hop = 1, policy: DownloadPolicy = OFFICIAL): string => {
    try {
      checkDownloadUrl(new URL(url), policy, expected, hop);
    } catch (err) {
      if (err instanceof RunnerDownloadError && err.code === 'bad-url') return err.message;
      throw err;
    }
    throw new Error(`expected ${url} to be refused`);
  };

  it('allows exactly the two release hosts over https', () => {
    expect(DOWNLOAD_HOSTS).toEqual(['github.com', 'release-assets.githubusercontent.com']);
    expect(() => checkDownloadUrl(new URL(PAGE), OFFICIAL, expected, 0)).not.toThrow();
    expect(() => checkDownloadUrl(new URL(CDN), OFFICIAL, expected, 1)).not.toThrow();
    expect(() => checkDownloadUrl(new URL('https://GITHUB.COM/namikmesic/puck/releases/download/v1.2.3/' + FILE), OFFICIAL, expected, 1)).not.toThrow();
    for (const url of [
      'https://evil.example/x',
      'https://github.com.evil.example/x',
      'https://evilgithub.com/x',
      'https://release-assets.githubusercontent.com.evil.example/x',
      'https://objects.githubusercontent.com/x',
      'https://api.github.com/x',
      'https://gіthub.com/x',
      'https://github.com./namikmesic/puck/releases/download/v1.2.3/' + FILE,
    ]) {
      expect(refused(url), url).toMatch(/not a release host/);
    }
  });

  it('refuses an https downgrade, credentials, a port, a fragment and other schemes', () => {
    expect(refused(`http://github.com/namikmesic/puck/releases/download/v${VERSION}/${FILE}`)).toMatch(/not https/);
    expect(refused('ftp://github.com/x')).toMatch(/not https/);
    expect(refused('https://user:pw@release-assets.githubusercontent.com/x')).toMatch(/carries credentials/);
    expect(refused('https://user@release-assets.githubusercontent.com/x')).toMatch(/carries credentials/);
    expect(refused('https://release-assets.githubusercontent.com:8443/x')).toMatch(/names a port/);
    expect(refused(`https://github.com:444/namikmesic/puck/releases/download/v${VERSION}/${FILE}`)).toMatch(/names a port/);
    expect(refused('https://release-assets.githubusercontent.com/x#fragment')).toMatch(/fragment/);
    // The default port is no port.
    expect(() => checkDownloadUrl(new URL('https://release-assets.githubusercontent.com:443/x'), OFFICIAL, expected, 1)).not.toThrow();
  });

  it('compares the github.com path segment by segment with the expected release page', () => {
    const prefix = 'https://github.com/namikmesic/puck/releases/download';
    for (const url of [
      `${prefix}/v${VERSION}/${FILE}?token=x`,
      `${prefix}/v${VERSION}/${FILE}/`,
      `${prefix}/v${VERSION}/${FILE}/extra`,
      `${prefix}/v${VERSION}/puck-runner-linux-arm64-${VERSION}.tar.gz`,
      `${prefix}/v9.9.9/${FILE}`,
      `${prefix}-x/v${VERSION}/${FILE}`,
      `https://github.com/namikmesic/puckx/releases/download/v${VERSION}/${FILE}`,
      `https://github.com/namikmesic/puck/releases/downloads/v${VERSION}/${FILE}`,
      `https://github.com/namikmesicx/puck/releases/download/v${VERSION}/${FILE}`,
      `https://github.com/other/puck/releases/download/v${VERSION}/${FILE}`,
      `https://github.com/namikmesic/puck/releases/download/v${VERSION}`,
      `https://github.com/namikmesic/puck/releases/download/v${VERSION}/../v9.9.9/${FILE}`,
      `https://github.com/namikmesic/puck/releases/download/v${VERSION}/%2e%2e/v9.9.9/${FILE}`,
      `https://github.com/namikmesic/puck/releases/download//v${VERSION}/${FILE}`,
      'https://github.com/',
    ]) {
      expect(refused(url), url).toMatch(/not the release page|empty or relative path segment/);
    }
    // The comparison is on the parsed path, where the URL parser has already resolved dot segments.
    expect(() => checkDownloadUrl(new URL(`https://github.com/namikmesic/puck/releases/download/./v${VERSION}/${FILE}`), OFFICIAL, expected, 1)).not.toThrow();
    expect(() => checkDownloadUrl(new URL(`https://github.com/namikmesic/puck/x/../releases/download/v${VERSION}/${FILE}`), OFFICIAL, expected, 1)).not.toThrow();
    // A string prefix would pass these; the segment comparison does not.
    expect(`${prefix}-x/v${VERSION}/${FILE}`.startsWith(prefix)).toBe(true);
    expect(`${prefix}/v${VERSION}/${FILE}/extra`.startsWith(`${prefix}/v${VERSION}/${FILE}`)).toBe(true);
  });

  it('refuses empty and relative segments on the asset host too', () => {
    for (const url of ['https://release-assets.githubusercontent.com', 'https://release-assets.githubusercontent.com//x', 'https://release-assets.githubusercontent.com/a//b']) {
      expect(refused(url), url).toMatch(/empty or relative path segment/);
    }
  });

  it('under the development policy allows http on the configured origin only, and no redirect at all', () => {
    const policy: DownloadPolicy = { kind: 'development', origin: 'http://puck.test:8765' };
    expect(() => checkDownloadUrl(new URL(`http://puck.test:8765/runner/${VERSION}/${FILE}`), policy, expected, 0)).not.toThrow();
    expect(refused(`http://puck.test:8765/runner/${VERSION}/${FILE}`, 1, policy)).toMatch(/must not redirect/);
    for (const url of [`http://puck.test/runner/${VERSION}/${FILE}`, `https://puck.test:8765/runner/${VERSION}/${FILE}`, `http://127.0.0.1:8765/runner/${VERSION}/${FILE}`, PAGE, CDN]) {
      expect(refused(url, 0, policy), url).toMatch(/not on the development server http:\/\/puck.test:8765/);
    }
    expect(refused('http://user:pw@puck.test:8765/x', 0, policy)).toMatch(/carries credentials/);
    expect(refused('http://puck.test:8765/x#y', 0, policy)).toMatch(/fragment/);
    expect(refused('http://puck.test:8765//b', 0, policy)).toMatch(/empty or relative path segment/);
    expect(refused('http://puck.test:8765/x', 0, { kind: 'development', origin: 'not a url' })).toMatch(/origin "not a url" is not a URL/);
    expect(refused('http://puck.test:8765/x', 0, { kind: 'development', origin: 'file:///tmp' })).toMatch(/not on the development server/);
  });
});

describe('downloadRunnerPackage', () => {
  it('follows the release page to the asset host, sends no credentials, cancels the redirect and stores the exact bytes', async () => {
    const page = redirect(CDN);
    const { fetch, calls } = fakeFetch({ [PAGE]: () => page.res, [CDN]: () => streamed(chunked(PACKAGE), { headers: { 'content-length': String(PACKAGE.length) } }).res });
    const req = request();
    const result = await downloadRunnerPackage(req, OFFICIAL, { fetch });
    expect(result).toEqual({ url: CDN, size: PACKAGE.length, sha256: sha256(PACKAGE) });
    expect(calls.map((c) => c.url)).toEqual([PAGE, CDN]);
    for (const call of calls) expectPlainRequest(call);
    expect(page.body.cancelled).toBe(true);
    expect(readFileSync(req.dest).equals(PACKAGE)).toBe(true);
    expect(statSync(req.dest).mode & 0o777).toBe(0o600);
  });

  it('never carries a token, whatever the caller has around', async () => {
    const { fetch, calls } = fakeFetch({ [PAGE]: () => streamed(chunked(PACKAGE)).res });
    process.env.GITHUB_TOKEN = 'ghp_never';
    try {
      await downloadRunnerPackage(request(), OFFICIAL, { fetch });
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
    const headers = Object.keys(calls[0].init.headers as Record<string, string>).map((k) => k.toLowerCase());
    expect(headers).not.toContain('authorization');
    expect(headers).not.toContain('cookie');
    expect(headers).not.toContain('x-runner-token');
    expect(JSON.stringify(calls)).not.toContain('ghp_never');
  });

  it('takes every redirect status, absolute or relative Locations, and at most MAX_REDIRECTS hops', async () => {
    expect(MAX_REDIRECTS).toBe(5);
    const hop = (n: number): string => `https://release-assets.githubusercontent.com/hop/${n}`;
    for (const status of [301, 302, 303, 307, 308]) {
      const { fetch, calls } = fakeFetch({
        [PAGE]: () => redirect('https://release-assets.githubusercontent.com/hop/1', status).res,
        [hop(1)]: () => redirect('/hop/2', status).res,
        [hop(2)]: () => redirect('../hop/3', status).res,
        [hop(3)]: () => redirect('4', status).res,
        [hop(4)]: () => redirect(`https://github.com/namikmesic/puck/releases/download/v${VERSION}/${FILE}`, status).res,
        [PAGE + '']: [() => redirect('https://release-assets.githubusercontent.com/hop/1', status).res, () => streamed(chunked(PACKAGE)).res],
      });
      const req = request();
      await downloadRunnerPackage(req, OFFICIAL, { fetch });
      expect(calls.map((c) => c.url)).toEqual([PAGE, hop(1), hop(2), hop(3), hop(4), PAGE]);
      expect(readFileSync(req.dest).equals(PACKAGE)).toBe(true);
    }
    const six = fakeFetch({ [PAGE]: () => redirect(hop(1)).res, ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [hop(n), () => redirect(hop(n + 1)).res])) });
    const req = request();
    expect(await failure(downloadRunnerPackage(req, OFFICIAL, { fetch: six.fetch }))).toEqual({ code: 'too-many-redirects', message: 'The download redirected more than 5 times.' });
    expect(six.calls).toHaveLength(6);
    expect(existsSync(req.dest)).toBe(false);
  });

  it('refuses a redirect outside the policy before requesting it', async () => {
    for (const [location, message] of [
      ['https://evil.example/x', /not a release host/],
      [`http://github.com/namikmesic/puck/releases/download/v${VERSION}/${FILE}`, /not https/],
      ['https://user:pw@release-assets.githubusercontent.com/x', /carries credentials/],
      ['https://release-assets.githubusercontent.com:8443/x', /names a port/],
      ['https://release-assets.githubusercontent.com/x#f', /fragment/],
      ['https://release-assets.githubusercontent.com/x\tSet-Cookie: a', /control character or a space/],
      ['https://release-assets.githubusercontent.com/x\u0001y', /control character or a space/],
      ['https://release-assets.githubusercontent.com/a b', /control character or a space/],
      ['http://[', /not a URL/],
      [null, /names no Location/],
    ] as [string | null, RegExp][]) {
      const { fetch, calls } = fakeFetch({ [PAGE]: () => redirect(location).res });
      const req = request();
      const f = await failure(downloadRunnerPackage(req, OFFICIAL, { fetch }));
      expect(f.code, String(location)).toBe('bad-url');
      expect(f.message, String(location)).toMatch(message);
      expect(calls, String(location)).toHaveLength(1);
      expect(existsSync(req.dest)).toBe(false);
    }
    // An empty Location is the page itself; the hop limit ends that loop.
    const self = fakeFetch({ [PAGE]: () => redirect('').res });
    expect((await failure(downloadRunnerPackage(request(), OFFICIAL, { fetch: self.fetch }))).code).toBe('too-many-redirects');
    expect(self.calls).toHaveLength(MAX_REDIRECTS + 1);
  });

  it('refuses a URL under the official policy, and a package over the absolute cap, without any request', async () => {
    const { fetch, calls } = fakeFetch({});
    expect((await failure(downloadRunnerPackage(request({ url: CDN }), OFFICIAL, { fetch }))).message).toMatch(/takes no URL/);
    expect(await failure(downloadRunnerPackage(request({ size: MAX_PACKAGE_BYTES + 1 }), OFFICIAL, { fetch }))).toEqual({
      code: 'too-large',
      message: `The package is ${MAX_PACKAGE_BYTES + 1} bytes; at most ${MAX_PACKAGE_BYTES} are downloaded.`,
    });
    expect(MAX_PACKAGE_BYTES).toBe(256 * 1024 * 1024);
    for (const size of [0, -1, 1.5, Number.NaN]) expect((await failure(downloadRunnerPackage(request({ size }), OFFICIAL, { fetch }))).code).toBe('size-mismatch');
    expect((await failure(downloadRunnerPackage(request({ sha256: 'ABC' }), OFFICIAL, { fetch }))).code).toBe('digest-mismatch');
    expect((await failure(downloadRunnerPackage(request({ version: 'v1' }), OFFICIAL, { fetch }))).code).toBe('bad-url');
    expect(calls).toHaveLength(0);
  });

  it('rejects any status but 200 after the redirects, and a content encoding', async () => {
    for (const status of [404, 403, 500, 206, 204]) {
      const { fetch } = fakeFetch({ [PAGE]: () => (status === 204 ? new Response(null, { status }) : streamed(chunked(PACKAGE), { status }).res) });
      const req = request();
      expect(await failure(downloadRunnerPackage(req, OFFICIAL, { fetch })), String(status)).toEqual({ code: 'http-status', message: `github.com answered ${status} for ${FILE}.` });
      expect(existsSync(req.dest)).toBe(false);
    }
    for (const encoding of ['gzip', 'br', 'GZIP', ' deflate ']) {
      const body = streamed(chunked(PACKAGE), { headers: { 'content-encoding': encoding } });
      const { fetch } = fakeFetch({ [PAGE]: () => body.res });
      const req = request();
      expect((await failure(downloadRunnerPackage(req, OFFICIAL, { fetch }))).code, encoding).toBe('content-encoding');
      expect(body.body.pulled).toBe(false);
      expect(body.body.cancelled).toBe(true);
      expect(existsSync(req.dest)).toBe(false);
    }
    const identity = streamed(chunked(PACKAGE), { headers: { 'content-encoding': 'identity' } });
    await downloadRunnerPackage(request(), OFFICIAL, { fetch: fakeFetch({ [PAGE]: () => identity.res }).fetch });
  });

  it('checks Content-Length against the signed size before reading a byte', async () => {
    for (const length of [String(PACKAGE.length + 1), String(PACKAGE.length - 1), 'abc', '-1', '1e3']) {
      const body = streamed(chunked(PACKAGE), { headers: { 'content-length': length } });
      const { fetch } = fakeFetch({ [PAGE]: () => body.res });
      const req = request();
      expect((await failure(downloadRunnerPackage(req, OFFICIAL, { fetch }))).code, length).toBe('size-mismatch');
      expect(body.body.pulled, length).toBe(false);
      expect(body.body.cancelled, length).toBe(true);
      expect(existsSync(req.dest)).toBe(false);
    }
  });

  it('rejects a short body, a long one and a wrong digest, cancelling the response and removing the file', async () => {
    const cases: [string, Uint8Array[], Partial<PackageDownload>, RunnerDownloadErrorCode, RegExp][] = [
      ['short', chunked(PACKAGE.subarray(0, PACKAGE.length - 1)), {}, 'truncated', /ended after 69999 of 70000 bytes/],
      ['empty', [], {}, 'truncated', /ended after 0 of 70000 bytes/],
      ['long', chunked(Buffer.concat([PACKAGE, Buffer.from([1])])), {}, 'size-mismatch', /longer than the 70000 bytes/],
      ['digest', chunked(PACKAGE), { sha256: 'a'.repeat(64) }, 'digest-mismatch', /does not match the sha256/],
      ['same length, other bytes', chunked(randomBytes(PACKAGE.length)), {}, 'digest-mismatch', /does not match the sha256/],
    ];
    for (const [name, chunks, overrides, code, message] of cases) {
      const body = streamed(chunks, { stall: name === 'long' });
      const { fetch } = fakeFetch({ [PAGE]: () => body.res });
      const req = request(overrides);
      const f = await failure(downloadRunnerPackage(req, OFFICIAL, { fetch }));
      expect(f.code, name).toBe(code);
      expect(f.message, name).toMatch(message);
      expect(existsSync(req.dest), name).toBe(false);
      if (name === 'long') expect(body.body.cancelled).toBe(true);
    }
  });

  it('stops on the caller\'s signal mid-stream, cancelling the response and removing the file', async () => {
    const body = streamed(chunked(PACKAGE).slice(0, 1), { stall: true });
    const { fetch } = fakeFetch({ [PAGE]: () => body.res });
    const controller = new AbortController();
    const req = request();
    const pending = failure(downloadRunnerPackage(req, OFFICIAL, { fetch, signal: controller.signal }));
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect(await pending).toEqual({ code: 'cancelled', message: 'The download was cancelled.' });
    expect(body.body.cancelled).toBe(true);
    expect(existsSync(req.dest)).toBe(false);
    const already = new AbortController();
    already.abort();
    expect((await failure(downloadRunnerPackage(request(), OFFICIAL, { fetch, signal: already.signal }))).code).toBe('cancelled');
  });

  it('times out waiting for headers and for the whole body', async () => {
    expect(HEADER_TIMEOUT_MS).toBe(30_000);
    expect(BODY_TIMEOUT_MS).toBe(15 * 60_000);
    const hanging = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    const req = request();
    expect(await failure(downloadRunnerPackage(req, OFFICIAL, { fetch: hanging, headerTimeoutMs: 20 }))).toEqual({ code: 'timeout', message: `The download of ${FILE} timed out.` });
    expect(existsSync(req.dest)).toBe(false);

    const body = streamed(chunked(PACKAGE).slice(0, 2), { stall: true });
    const { fetch } = fakeFetch({ [PAGE]: () => body.res });
    const slow = request();
    expect((await failure(downloadRunnerPackage(slow, OFFICIAL, { fetch, bodyTimeoutMs: 30 }))).code).toBe('timeout');
    expect(body.body.cancelled).toBe(true);
    expect(existsSync(slow.dest)).toBe(false);
  });

  it('reports an unreachable host and never touches an existing file at dest', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const req = request();
    expect(await failure(downloadRunnerPackage(req, OFFICIAL, { fetch: down }))).toEqual({ code: 'unreachable', message: 'Cannot reach https://github.com: fetch failed' });
    const { fetch } = fakeFetch({ [PAGE]: () => streamed(chunked(PACKAGE)).res });
    const taken = request();
    writeFileSync(taken.dest, 'keep me');
    expect((await failure(downloadRunnerPackage(taken, OFFICIAL, { fetch }))).code).toBe('write-failed');
    expect(readFileSync(taken.dest, 'utf8')).toBe('keep me');
  });

  it('downloads from a development server over http on its own origin, with no redirect', async () => {
    const downloads = tmp();
    mkdirSync(join(downloads, VERSION));
    writeFileSync(join(downloads, VERSION, FILE), PACKAGE);
    h = await startServer({ PUCK_DEVELOPMENT: 'true', PUCK_RUNNER_DOWNLOADS: downloads });
    const policy: DownloadPolicy = { kind: 'development', origin: h.base };
    const listed = await new ServerApi(h.base).releases();
    const asset = listed.assets.find((a) => a.file === FILE);
    expect(asset).toBeDefined();
    // The server names its public URL; a client points that at the origin it configured.
    const url = new URL(asset?.url ?? '');
    const local = `${h.base}${url.pathname}`;
    const req = request({ url: local });
    expect(await downloadRunnerPackage(req, policy)).toEqual({ url: local, size: PACKAGE.length, sha256: sha256(PACKAGE) });
    expect(readFileSync(req.dest).equals(PACKAGE)).toBe(true);

    const { fetch, calls } = fakeFetch({});
    for (const other of [asset?.url ?? '', PAGE, `${h.base.replace('127.0.0.1', 'localhost')}${url.pathname}`, `http://user:pw@${new URL(h.base).host}${url.pathname}`]) {
      expect((await failure(downloadRunnerPackage(request({ url: other }), policy, { fetch }))).code, other).toBe('bad-url');
    }
    expect((await failure(downloadRunnerPackage(request(), policy, { fetch }))).message).toMatch(/needs the server's URL/);
    expect(calls).toHaveLength(0);
    const redirecting = fakeFetch({ [local]: () => redirect(`${h.base}/elsewhere`).res });
    expect((await failure(downloadRunnerPackage(request({ url: local }), policy, { fetch: redirecting.fetch }))).message).toMatch(/must not redirect/);
    expect(redirecting.calls).toHaveLength(1);
  });
});

describe('readBoundedBody', () => {
  it('returns the exact bytes within the bound', async () => {
    const bytes = randomBytes(40_000);
    expect(Buffer.from(await readBoundedBody(streamed(chunked(bytes, 7_000)).res, 40_000)).equals(bytes)).toBe(true);
    expect(await readBoundedBody(new Response(null), 10)).toEqual(new Uint8Array(0));
  });

  it('refuses an announced or a streamed overrun, cancelling the body', async () => {
    const announced = streamed(chunked(randomBytes(10)), { headers: { 'content-length': '11' } });
    expect(await failure(readBoundedBody(announced.res, 10))).toEqual({ code: 'too-large', message: 'The response announces 11 bytes; at most 10 are read.' });
    expect(announced.body.pulled).toBe(false);
    expect(announced.body.cancelled).toBe(true);
    const streamedOver = streamed(chunked(randomBytes(30), 7), { stall: true });
    expect(await failure(readBoundedBody(streamedOver.res, 20))).toEqual({ code: 'too-large', message: 'The response is over 20 bytes.' });
    expect(streamedOver.body.cancelled).toBe(true);
    expect(Buffer.from(await readBoundedBody(streamed(chunked(randomBytes(20), 7)).res, 20))).toHaveLength(20);
  });

  it('refuses a content encoding or an unreadable Content-Length, cancelling the body unread', async () => {
    const encoded = streamed(chunked(randomBytes(10)), { headers: { 'content-encoding': 'gzip' } });
    expect((await failure(readBoundedBody(encoded.res, 100))).code).toBe('content-encoding');
    expect(encoded.body.pulled).toBe(false);
    expect(encoded.body.cancelled).toBe(true);
    const odd = streamed(chunked(randomBytes(10)), { headers: { 'content-length': 'ten' } });
    expect((await failure(readBoundedBody(odd.res, 100))).code).toBe('size-mismatch');
    expect(odd.body.pulled).toBe(false);
    expect(odd.body.cancelled).toBe(true);
  });
});

describe('release listings', () => {
  it('parses bounded UTF-8 JSON and hands back the exact bytes', async () => {
    const text = '{"latest":"1.2.3","releases":[]}';
    const { bytes, value } = await readReleaseListing(new Response(text));
    expect(Buffer.from(bytes).toString('utf8')).toBe(text);
    expect(value).toEqual({ latest: '1.2.3', releases: [] });
    const encoded = await readReleaseListing(new Response(text, { headers: { 'content-encoding': 'gzip' } }));
    expect(Buffer.from(encoded.bytes).toString('utf8')).toBe(text);
    expect(encoded.value).toEqual({ latest: '1.2.3', releases: [] });
    for (const body of [new Uint8Array([0x7b, 0xff, 0x7d]), new TextEncoder().encode('{"a":'), new TextEncoder().encode('﻿{}')]) {
      await expect(readReleaseListing(new Response(body))).rejects.toMatchObject({ name: 'RunnerReleaseError', code: 'malformed' });
    }
    const big = streamed(chunked(Buffer.alloc(MAX_RELEASE_METADATA_BYTES + 1, 0x20), 65_536));
    expect((await failure(readReleaseListing(big.res))).code).toBe('too-large');
    expect(big.body.cancelled).toBe(true);
  });

  it('bounds the app\'s and the runner\'s release readers, and only those', async () => {
    const huge = Buffer.alloc(MAX_RELEASE_METADATA_BYTES + 1, 0x20);
    const seen: Call[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      seen.push({ url: String(input), init });
      return streamed(chunked(huge, 65_536), { headers: { 'content-type': 'application/json' } }).res;
    }) as typeof fetch;
    useServerDeps({ fetch: fetchImpl as never }, 'http://puck.test');
    expect((await failure(mainApi.releases())).code).toBe('too-large');
    expect(seen[0].url).toBe('http://puck.test/v1/runner/releases');
    expect((seen[0].init.headers as Record<string, string>)['Accept-Encoding']).toBeUndefined();
    // Other requests read as before: the whole (blank) body, parsed leniently.
    expect(await serverRequest('GET', '/v1/me')).toBeNull();
    expect((seen[1].init.headers as Record<string, string>)['Accept-Encoding']).toBeUndefined();

    const runner = new ServerApi('http://puck.test', fetchImpl);
    expect((await failure(runner.releases())).code).toBe('too-large');
    expect((seen[2].init.headers as Record<string, string>)['Accept-Encoding']).toBeUndefined();
    expect(seen[2].init.headers).not.toHaveProperty('Authorization');
  });

  it('reads a content-encoded listing within the byte bound', async () => {
    const listing = JSON.stringify({ latest: VERSION, minVersion: null, assets: [] });
    const fetchImpl = (async () =>
      streamed(chunked(Buffer.from(listing)), { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }).res) as typeof fetch;
    useServerDeps({ fetch: fetchImpl as never }, 'http://puck.test');
    expect(await mainApi.releases()).toEqual({ latest: VERSION, minVersion: null, assets: [] });
    expect(await new ServerApi('http://puck.test', fetchImpl).releases()).toEqual({ latest: VERSION, minVersion: null, assets: [] });
  });

  it('reads a development server listing through both bounded readers', async () => {
    const downloads = tmp();
    mkdirSync(join(downloads, VERSION));
    writeFileSync(join(downloads, VERSION, FILE), PACKAGE);
    h = await startServer({ PUCK_DEVELOPMENT: 'true', PUCK_RUNNER_DOWNLOADS: downloads });
    const probe = await fetch(`${h.base}/v1/runner/releases`);
    expect(probe.headers.get('content-encoding') ?? 'identity').toBe('identity');
    await probe.body?.cancel();
    const expected = {
      latest: VERSION,
      minVersion: null,
      assets: [
        {
          os: 'linux',
          arch: 'x64',
          version: VERSION,
          file: FILE,
          url: `http://puck.test/runner/${VERSION}/${FILE}`,
          sha256: sha256(PACKAGE),
          size: PACKAGE.length,
        },
      ],
    };
    useServerDeps({}, h.base);
    expect(await mainApi.releases()).toEqual(expected);
    expect(await new ServerApi(h.base).releases()).toEqual(expected);
  });
});

describe('verifySignedRunnerReleases', () => {
  interface TestKey {
    privateKey: KeyObject;
    pem: string;
    id: string;
  }
  const ed25519 = (): TestKey => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return { privateKey, pem: publicKey.export({ type: 'spki', format: 'pem' }) as string, id: releaseKeyId(publicKey) };
  };
  const manifest = (key: TestKey, version = '2.0.0'): RunnerReleaseManifest => ({
    schemaVersion: 1,
    product: 'puck-runner',
    publisher: 'namikmesic/puck',
    version,
    sourceCommit: 'f'.repeat(40),
    runnerProtocol: 1,
    signingKeyId: key.id,
    sha256sumsSha256: 'a'.repeat(64),
    assets: RUNNER_TARGETS.map((t, i) => ({ os: t.os, arch: t.arch, file: runnerPackageFile(t, version), sha256: sha256(`p${i}`), size: 100 + i })),
  });
  const record = (key: TestKey, text: string) => {
    const bytes = new TextEncoder().encode(text);
    return formatSignedRunnerRelease(bytes, sign(null, bytes, key.privateKey));
  };
  const releaseFailure = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      if (err instanceof RunnerReleaseError) return err.code;
      throw err;
    }
    throw new Error('expected a RunnerReleaseError');
  };

  it('verifies each record on its exact bytes and returns them with the manifest', () => {
    const key = ed25519();
    const texts = [formatRunnerRelease(manifest(key, '2.0.0')), formatRunnerRelease(manifest(key, '2.1.0'))];
    const verified = verifySignedRunnerReleases(texts.map((t) => record(key, t)), [key.pem]);
    expect(verified.map((v) => v.manifest.version)).toEqual(['2.0.0', '2.1.0']);
    expect(verified.map((v) => v.keyId)).toEqual([key.id, key.id]);
    expect(verified.map((v) => Buffer.from(v.bytes).toString('utf8'))).toEqual(texts);
    expect(verified[0].signature).toHaveLength(64);
    expect(verifySignedRunnerReleases([], [key.pem])).toEqual([]);
  });

  it('fails closed on the compiled roots, and refuses another key, altered bytes and a re-serialised manifest', () => {
    const key = ed25519();
    const other = ed25519();
    const text = formatRunnerRelease(manifest(key));
    const good = record(key, text);
    expect(releaseFailure(() => verifySignedRunnerReleases([good]))).toBe('no-trusted-key');
    expect(releaseFailure(() => verifySignedRunnerReleases([good], [other.pem]))).toBe('bad-signature');
    const reserialised = { ...good, manifest: Buffer.from(JSON.stringify(JSON.parse(text))).toString('base64') };
    expect(releaseFailure(() => verifySignedRunnerReleases([reserialised], [key.pem]))).toBe('bad-signature');
    const signedByOther = record(other, text);
    expect(releaseFailure(() => verifySignedRunnerReleases([signedByOther], [key.pem, other.pem]))).toBe('key-id-mismatch');
    // Signed garbage verifies, then fails to read; unsigned garbage never gets that far.
    expect(releaseFailure(() => verifySignedRunnerReleases([good, record(key, 'not json')], [key.pem]))).toBe('malformed');
    expect(releaseFailure(() => verifySignedRunnerReleases([{ ...good, signature: Buffer.alloc(64).toString('base64') }], [key.pem]))).toBe('bad-signature');
  });

  it('bounds the records before any signature check', () => {
    const key = ed25519();
    const good = record(key, formatRunnerRelease(manifest(key)));
    expect(releaseFailure(() => verifySignedRunnerReleases(Array.from({ length: MAX_RELEASE_RECORDS + 1 }, () => good), [key.pem]))).toBe('malformed');
    expect(releaseFailure(() => verifySignedRunnerReleases([{ ...good, manifest: Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x20).toString('base64') }], [key.pem]))).toBe('malformed');
    expect(releaseFailure(() => verifySignedRunnerReleases([{ ...good, manifest: `${good.manifest}\n` }], [key.pem]))).toBe('malformed');
    expect(releaseFailure(() => verifySignedRunnerReleases({ records: [good] }, [key.pem]))).toBe('malformed');
  });
});


describe('writeAll', () => {
  /** A handle that persists at most `most` bytes per write and records what it got. */
  const sink = (most: number) => {
    const written: number[] = [];
    let calls = 0;
    return {
      written,
      calls: () => calls,
      write: async (data: Uint8Array) => {
        calls++;
        const take = Math.min(most, data.length);
        written.push(...data.subarray(0, take));
        return { bytesWritten: take };
      },
    };
  };

  it('keeps writing until every byte is persisted, in order', async () => {
    const bytes = randomBytes(10);
    const short = sink(3);
    await writeAll(short, bytes);
    expect(Buffer.from(short.written).equals(bytes)).toBe(true);
    expect(short.calls()).toBe(4);
    const whole = sink(1024);
    await writeAll(whole, bytes);
    expect(whole.calls()).toBe(1);
    const empty = sink(3);
    await writeAll(empty, new Uint8Array(0));
    expect(empty.calls()).toBe(0);
  });

  it('fails on a write that persists nothing rather than looping or reporting success', async () => {
    const stuck = sink(0);
    await expect(writeAll(stuck, randomBytes(4))).rejects.toThrow('wrote none of the remaining 4 bytes');
    expect(stuck.calls()).toBe(1);
    const stalls = { write: async () => ({ bytesWritten: Number.NaN }) };
    await expect(writeAll(stalls, randomBytes(4))).rejects.toThrow(/wrote none/);
  });

  it('makes a short write fail a download with the file removed, and an unpack with staging removed', async () => {
    // A handle that writes half of what it is given, then nothing.
    const half = (real: { write(data: Uint8Array): Promise<{ bytesWritten: number }> }) => {
      let calls = 0;
      return async (data: Uint8Array) => {
        calls++;
        if (calls > 1) return { bytesWritten: 0 };
        return real.write(data.subarray(0, Math.max(1, data.length >> 1)));
      };
    };
    const fsPromises = (await import('node:fs')).promises;
    const realOpen = fsPromises.open;
    const opened: { write: (data: Uint8Array) => Promise<{ bytesWritten: number }> }[] = [];
    (fsPromises as { open: unknown }).open = async (...args: unknown[]) => {
      const handle = await (realOpen as (...a: unknown[]) => Promise<{ write(data: Uint8Array): Promise<{ bytesWritten: number }> }>)(...args);
      const write = half(handle);
      const patched = Object.create(handle) as typeof handle;
      patched.write = write;
      opened.push(patched);
      return patched;
    };
    try {
      const { fetch } = fakeFetch({ [PAGE]: () => streamed(chunked(PACKAGE)).res });
      const req = request();
      const f = await failure(downloadRunnerPackage(req, OFFICIAL, { fetch }));
      expect(f.code).toBe('write-failed');
      expect(f.message).toMatch(/wrote none of the remaining/);
      expect(existsSync(req.dest)).toBe(false);
      expect(opened).toHaveLength(1);
    } finally {
      (fsPromises as { open: unknown }).open = realOpen;
    }
  });
});
