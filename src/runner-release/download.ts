/**
 * The bounded transport for runner releases: how the app's main process,
 * the Puck server and the runner read release metadata and fetch a runner
 * package before verify.ts and archive.ts check what arrived. Node
 * built-ins and the global fetch only; the renderer and the daemon never
 * import this directory (.eslintrc.json), and nothing here runs a package.
 *
 * Metadata. `readBoundedBody` returns a response's bytes: the bound is
 * checked against Content-Length before the read and against the count
 * during it. A listing passes `refuseContentEncoding: false`, because
 * fetch has already decoded the body and signed bytes travel base64
 * inside the JSON. A package download refuses a content encoding, because
 * those bytes are hashed as sent. `verifySignedRunnerReleases` decodes a
 * listing's records (at most MAX_RELEASE_RECORDS, each manifest at most
 * MAX_MANIFEST_BYTES once decoded) and hands every manifest's exact bytes
 * to the verifier. Nothing re-serialised is ever verified, and the bytes
 * come back with the manifest so a server can pass them on unchanged.
 *
 * Packages. `downloadRunnerPackage` streams one package into a private
 * file. Under the official policy the URL is built here from the
 * repository's release prefix, the canonical version and the signed file
 * name; nothing a server sends chooses it. Every redirect is checked by
 * hand: at most MAX_REDIRECTS, https only, exactly the hosts in
 * DOWNLOAD_HOSTS, no userinfo, fragment, port or control character, and a
 * github.com path compared segment by segment with the one expected. A
 * redirect's body is cancelled. The request carries only the headers
 * written here, so no Puck, runner or GitHub token ever leaves with it,
 * and a URL with credentials is refused before any request. The signed
 * byte count is enforced while streaming, under MAX_PACKAGE_BYTES, with
 * HEADER_TIMEOUT_MS to each response's headers and BODY_TIMEOUT_MS for the
 * whole download. A short body, a long one, a wrong digest, a timeout or a
 * cancellation fails the download, cancels the response, closes the file
 * and removes it.
 *
 * The development policy is the caller's, never a server's: it allows http
 * on the configured server's own origin and no redirect at all.
 *
 * Only erasable TypeScript here (see verify.ts).
 */

import { createHash } from 'node:crypto';
import { promises as fs, rmSync } from 'node:fs';
import {
  isReleaseVersion,
  MAX_RELEASE_METADATA_BYTES,
  readSignedRunnerReleases,
  RUNNER_RELEASE_PUBLISHER,
  RUNNER_TARGETS,
  runnerPackageFile,
  runnerReleaseTag,
  RunnerReleaseError,
} from '../harness/runner-releases';
import { RELEASE_KEYS } from './trust';
import { verifyRunnerRelease, type VerifiedRunnerRelease } from './verify';

/** Where official packages hang: the repository's GitHub Release assets. */
export const OFFICIAL_RELEASE_PREFIX = `https://github.com/${RUNNER_RELEASE_PUBLISHER}/releases/download`;
/** The only hosts an official download may touch: the release page and the asset store it redirects to (observed, not promised). */
export const DOWNLOAD_HOSTS: readonly string[] = ['github.com', 'release-assets.githubusercontent.com'];
export const MAX_REDIRECTS = 5;
/** Most bytes a package may have on the wire, whatever a manifest says. */
export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
/** From a request to its response headers, per hop. */
export const HEADER_TIMEOUT_MS = 30_000;
/** From the first request to the last byte. */
export const BODY_TIMEOUT_MS = 15 * 60_000;

export type RunnerDownloadErrorCode =
  /** The URL, or a redirect's target, is outside the policy. */
  | 'bad-url'
  | 'too-many-redirects'
  /** The server answered with a status other than 200 or a redirect. */
  | 'http-status'
  /** The response carries a content encoding, so its bytes are not the ones sent. */
  | 'content-encoding'
  /** The response is over the bound. */
  | 'too-large'
  /** Content-Length, or the body, is not the signed size. */
  | 'size-mismatch'
  /** The body ended before the signed size. */
  | 'truncated'
  | 'digest-mismatch'
  | 'timeout'
  /** The caller's signal aborted it. */
  | 'cancelled'
  /** The request failed before any response. */
  | 'unreachable'
  /** The file at `dest` could not be created or written. */
  | 'write-failed';

export class RunnerDownloadError extends Error {
  readonly code: RunnerDownloadErrorCode;

  constructor(code: RunnerDownloadErrorCode, message: string) {
    super(message);
    this.name = 'RunnerDownloadError';
    this.code = code;
  }
}

export type DownloadPolicy =
  /** Official releases: the URL is built here, and redirects stay on DOWNLOAD_HOSTS over https. */
  | { kind: 'official' }
  /** A development server: `url` must be on `origin` (http allowed), and it must not redirect. */
  | { kind: 'development'; origin: string };

export interface PackageDownload {
  /** The canonical release version. */
  version: string;
  /** The selected package, from a verified manifest (or a development server's listing). */
  file: string;
  sha256: string;
  size: number;
  /** Development only: the server's URL for the file. Refused under the official policy. */
  url?: string;
  /** Where the bytes go: created with mode 0600, never an existing file. */
  dest: string;
}

export interface DownloadOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Test seams; the exported constants are the contract. */
  headerTimeoutMs?: number;
  bodyTimeoutMs?: number;
}

export interface DownloadedPackage {
  /** The URL that served the bytes. */
  url: string;
  size: number;
  sha256: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE_RE = /[\x00-\x20\x7f]/;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const HEADERS: Record<string, string> = { accept: 'application/octet-stream', 'accept-encoding': 'identity' };

const bad = (message: string): RunnerDownloadError => new RunnerDownloadError('bad-url', message);

function contentEncoding(res: Response): void {
  const encoding = res.headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') throw new RunnerDownloadError('content-encoding', `The response is ${encoding}-encoded; release bytes are read as sent.`);
}

/** Content-Length as a number, or null when absent; anything unreadable is a size mismatch. */
function contentLength(res: Response): number | null {
  const raw = res.headers.get('content-length');
  if (raw === null) return null;
  if (!/^\d{1,15}$/.test(raw.trim())) throw new RunnerDownloadError('size-mismatch', `The response's Content-Length ${JSON.stringify(raw)} is unreadable.`);
  return Number(raw.trim());
}

const cancel = (res: Response): Promise<void> => (res.body ? res.body.cancel().catch(() => undefined) : Promise.resolve());

/**
 * Reads a response's body, at most `maxBytes`. The bound is checked
 * against Content-Length before the read and against the running count
 * during it, and the body is cancelled the moment it is over. A content
 * encoding is refused unless `opts.refuseContentEncoding` is false.
 * Throws RunnerDownloadError.
 */
export async function readBoundedBody(res: Response, maxBytes: number, opts: { refuseContentEncoding?: boolean } = {}): Promise<Uint8Array> {
  try {
    if (opts.refuseContentEncoding !== false) contentEncoding(res);
    const length = contentLength(res);
    if (length !== null && length > maxBytes) throw new RunnerDownloadError('too-large', `The response announces ${length} bytes; at most ${maxBytes} are read.`);
  } catch (err) {
    await cancel(res);
    throw err;
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new RunnerDownloadError('too-large', `The response is over ${maxBytes} bytes.`);
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** A release listing's body: at most MAX_RELEASE_METADATA_BYTES of UTF-8 JSON, returned parsed and as its exact bytes. */
export async function readReleaseListing(res: Response): Promise<{ bytes: Uint8Array; value: unknown }> {
  const bytes = await readBoundedBody(res, MAX_RELEASE_METADATA_BYTES, { refuseContentEncoding: false });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new RunnerReleaseError('malformed', 'The release listing is not UTF-8 JSON.');
  }
  return { bytes, value };
}

export interface VerifiedSignedRelease extends VerifiedRunnerRelease {
  /** runner-release.json exactly as signed. */
  bytes: Uint8Array;
  signature: Uint8Array;
}

/**
 * Reads a listing's signed release records and verifies each one's exact
 * bytes against the trust roots (verify.ts). `keys` defaults to the
 * compiled RELEASE_KEYS; only tests pass others. Throws RunnerReleaseError.
 */
export function verifySignedRunnerReleases(records: unknown, keys: readonly string[] = RELEASE_KEYS): VerifiedSignedRelease[] {
  return readSignedRunnerReleases(records).map(({ manifest, signature }) => ({ ...verifyRunnerRelease(manifest, signature, keys), bytes: manifest, signature }));
}

/** The official URL of a release's package: the release prefix, the version's tag and the package's exact file name. */
export function officialPackageUrl(version: string, file: string): string {
  if (!isReleaseVersion(version)) throw bad(`${JSON.stringify(version)} is not a release version.`);
  if (!RUNNER_TARGETS.some((t) => runnerPackageFile(t, version) === file)) throw bad(`${JSON.stringify(file)} is not a package of runner ${version}.`);
  return `${OFFICIAL_RELEASE_PREFIX}/${runnerReleaseTag(version)}/${file}`;
}

/** Parses `text` (a URL or a Location, resolved against `base`) or throws; control characters and spaces never parse. */
function parseUrl(text: string, base: URL | null, what: string): URL {
  if (CONTROL_OR_SPACE_RE.test(text)) throw bad(`${what} contains a control character or a space.`);
  if (text.includes('#')) throw bad(`${what} has a fragment.`);
  try {
    return base ? new URL(text, base) : new URL(text);
  } catch {
    throw bad(`${what} is not a URL: ${JSON.stringify(text.slice(0, 200))}`);
  }
}

/** Path segments after the leading slash; refuses empty, `.` and `..` segments. */
function pathSegments(url: URL, what: string): string[] {
  const segments = url.pathname.split('/').slice(1);
  if (segments.some((s) => s === '' || s === '.' || s === '..')) throw bad(`${what} has an empty or relative path segment.`);
  return segments;
}

/**
 * Throws unless `url` is one the policy allows: for the first request, or
 * for a redirect (`hop` > 0) that the first request's response chain led
 * to. `expected` is the package the official URL must name.
 */
export function checkDownloadUrl(url: URL, policy: DownloadPolicy, expected: { version: string; file: string }, hop: number): void {
  const what = hop ? `Redirect ${hop}` : 'The download URL';
  if (url.username || url.password) throw bad(`${what} carries credentials.`);
  if (url.hash) throw bad(`${what} has a fragment.`);
  if (policy.kind === 'development') {
    if (hop) throw bad(`${what} is refused: a development server's download must not redirect.`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw bad(`${what} is not http or https.`);
    let origin: string;
    try {
      origin = new URL(policy.origin).origin;
    } catch {
      throw bad(`The development server origin ${JSON.stringify(policy.origin)} is not a URL.`);
    }
    if (origin === 'null' || url.origin !== origin) throw bad(`${what} is not on the development server ${origin}.`);
    pathSegments(url, what);
    return;
  }
  if (url.protocol !== 'https:') throw bad(`${what} is not https.`);
  if (url.port) throw bad(`${what} names a port.`);
  if (!DOWNLOAD_HOSTS.includes(url.hostname)) throw bad(`${what} is on ${url.hostname}, not a release host.`);
  const segments = pathSegments(url, what);
  if (url.hostname === 'github.com') {
    const want = [...RUNNER_RELEASE_PUBLISHER.split('/'), 'releases', 'download', runnerReleaseTag(expected.version), expected.file];
    const same = segments.length === want.length && segments.every((s, i) => s === want[i]);
    if (!same || url.search) throw bad(`${what} is not the release page of ${expected.file}.`);
  }
}

/** The first URL of a download under the policy, checked. */
function initialUrl(req: PackageDownload, policy: DownloadPolicy): URL {
  let url: URL;
  if (policy.kind === 'official') {
    if (req.url !== undefined) throw bad('An official download takes no URL; it is built from the release.');
    url = parseUrl(officialPackageUrl(req.version, req.file), null, 'The download URL');
  } else {
    if (typeof req.url !== 'string') throw bad('A development download needs the server\'s URL for the package.');
    url = parseUrl(req.url, null, 'The download URL');
  }
  checkDownloadUrl(url, policy, req, 0);
  return url;
}

/**
 * Downloads one package to `req.dest` (see the header). Resolves with the
 * URL that served it and the size and digest checked; throws
 * RunnerDownloadError, with nothing left at `req.dest`.
 */
export async function downloadRunnerPackage(req: PackageDownload, policy: DownloadPolicy, opts: DownloadOptions = {}): Promise<DownloadedPackage> {
  const fetchImpl = opts.fetch ?? fetch;
  const headerTimeoutMs = opts.headerTimeoutMs ?? HEADER_TIMEOUT_MS;
  const bodyTimeoutMs = opts.bodyTimeoutMs ?? BODY_TIMEOUT_MS;
  if (!Number.isSafeInteger(req.size) || req.size <= 0) throw new RunnerDownloadError('size-mismatch', `A package's size must be a positive whole number of bytes, not ${String(req.size)}.`);
  if (req.size > MAX_PACKAGE_BYTES) throw new RunnerDownloadError('too-large', `The package is ${req.size} bytes; at most ${MAX_PACKAGE_BYTES} are downloaded.`);
  if (!/^[0-9a-f]{64}$/.test(req.sha256)) throw new RunnerDownloadError('digest-mismatch', 'The expected sha256 is not 64 lowercase hex digits.');
  let url = initialUrl(req, policy);

  // One controller ends everything: a caller's cancel, a header timeout, or the whole-body deadline.
  const controller = new AbortController();
  let why: 'timeout' | 'cancelled' | null = null;
  const abort = (reason: 'timeout' | 'cancelled'): void => {
    if (why) return;
    why = reason;
    controller.abort();
  };
  const onCancel = (): void => abort('cancelled');
  if (opts.signal?.aborted) throw new RunnerDownloadError('cancelled', 'The download was cancelled.');
  opts.signal?.addEventListener('abort', onCancel, { once: true });
  const deadline = setTimeout(() => abort('timeout'), bodyTimeoutMs);
  const failure = (err: unknown, fallback: RunnerDownloadErrorCode, message: string): RunnerDownloadError => {
    // An abort explains whatever it cut short (a closed body reads as truncated).
    if (why === 'cancelled') return new RunnerDownloadError('cancelled', 'The download was cancelled.');
    if (why === 'timeout') return new RunnerDownloadError('timeout', `The download of ${req.file} timed out.`);
    if (err instanceof RunnerDownloadError) return err;
    return new RunnerDownloadError(fallback, `${message}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const request = async (at: URL): Promise<Response> => {
    const timer = setTimeout(() => abort('timeout'), headerTimeoutMs);
    try {
      return await fetchImpl(at.href, { method: 'GET', headers: { ...HEADERS }, redirect: 'manual', credentials: 'omit', signal: controller.signal });
    } catch (err) {
      throw failure(err, 'unreachable', `Cannot reach ${at.origin}`);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res: Response;
    for (let hop = 0; ; hop++) {
      res = await request(url);
      if (REDIRECT_STATUSES.includes(res.status)) {
        await cancel(res);
        if (hop >= MAX_REDIRECTS) throw new RunnerDownloadError('too-many-redirects', `The download redirected more than ${MAX_REDIRECTS} times.`);
        const location = res.headers.get('location');
        if (location === null) throw bad(`Redirect ${hop + 1} names no Location.`);
        const next = parseUrl(location, url, `Redirect ${hop + 1}`);
        checkDownloadUrl(next, policy, req, hop + 1);
        url = next;
        continue;
      }
      if (res.status !== 200) {
        await cancel(res);
        throw new RunnerDownloadError('http-status', `${url.host} answered ${res.status} for ${req.file}.`);
      }
      break;
    }
    try {
      contentEncoding(res);
      const length = contentLength(res);
      if (length !== null && length !== req.size) throw new RunnerDownloadError('size-mismatch', `${url.host} announces ${length} bytes for ${req.file}; the release signed ${req.size}.`);
    } catch (err) {
      await cancel(res);
      throw err;
    }
    const sha256 = await store(res, req, controller.signal, failure);
    return { url: url.href, size: req.size, sha256 };
  } finally {
    clearTimeout(deadline);
    opts.signal?.removeEventListener('abort', onCancel);
  }
}

/** Streams the body to `req.dest`, counting and hashing; on any failure nothing is left there. */
async function store(
  res: Response,
  req: PackageDownload,
  signal: AbortSignal,
  failure: (err: unknown, code: RunnerDownloadErrorCode, message: string) => RunnerDownloadError,
): Promise<string> {
  const hash = createHash('sha256');
  let received = 0;
  const reader = res.body?.getReader() ?? null;
  // The abort ends the body too, whether or not the fetch tied the stream to its signal.
  const onAbort = (): void => {
    if (reader) reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  let file: fs.FileHandle | null;
  try {
    // 'wx': the file is this download's own; an existing one is never touched.
    file = await fs.open(req.dest, 'wx', 0o600);
  } catch (err) {
    signal.removeEventListener('abort', onAbort);
    if (reader) await reader.cancel().catch(() => undefined);
    throw failure(err, 'write-failed', `Cannot create ${req.dest}`);
  }
  try {
    if (reader) {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          throw failure(err, 'truncated', `The download of ${req.file} failed`);
        }
        if (chunk.done) break;
        received += chunk.value.length;
        if (received > req.size) throw new RunnerDownloadError('size-mismatch', `${req.file} is longer than the ${req.size} bytes the release signed.`);
        hash.update(chunk.value);
        try {
          await file.write(chunk.value);
        } catch (err) {
          throw failure(err, 'write-failed', `Cannot write ${req.dest}`);
        }
      }
    }
    if (received !== req.size) throw new RunnerDownloadError('truncated', `${req.file} ended after ${received} of ${req.size} bytes.`);
    const sha256 = hash.digest('hex');
    if (sha256 !== req.sha256) throw new RunnerDownloadError('digest-mismatch', `${req.file} does not match the sha256 the release signed.`);
    await file.close();
    file = null;
    return sha256;
  } catch (err) {
    if (reader) await reader.cancel().catch(() => undefined);
    if (file) await file.close().catch(() => undefined);
    rmSync(req.dest, { force: true });
    throw failure(err, 'truncated', `The download of ${req.file} failed`);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
