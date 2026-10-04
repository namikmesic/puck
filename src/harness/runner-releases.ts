/**
 * The signed runner-release format: what production Puck servers, the app
 * and runners check before they install a runner package. This module is
 * the pure half, shared by every side: wire types, names, and shape checks.
 * The signature check and the compiled trust roots are src/runner-release
 * (Node crypto); scripts/package-runner.mjs writes the manifest and
 * scripts/runner-release.mjs signs and verifies a release directory.
 *
 * A release is a GitHub Release of the Puck repository with ten assets:
 *
 *   puck-runner-<os>-<arch>-<version>.tar.gz      linux-x64, linux-arm64, macos-arm64
 *   puck-runner-<os>-<arch>-<version>.tar.gz.sha256
 *   SHA256SUMS            SHA256SUMS.sig
 *   runner-release.json   runner-release.json.sig
 *
 * `runner-release.json` describes exactly those three packages. Its `.sig`
 * is a 64-byte detached Ed25519 signature over the file's exact bytes, and
 * `SHA256SUMS.sig` signs SHA256SUMS the same way for standalone checks. A
 * reader verifies the bytes it received before it trusts any field and
 * never re-serialises a manifest to check it. The manifest names SHA256SUMS
 * by digest, so the two agree or the release is refused.
 *
 * A signed release travels through other documents (a server's listing)
 * as a record carrying the manifest's exact bytes and its signature, both
 * in standard base64 (`SignedRunnerRelease`). The reader here checks the
 * encoding and its bounds; the bytes go to the verifier unchanged.
 *
 * A server lists the packages it offers (`GET /v1/runner/releases`) as a
 * `RunnerReleaseListing`, each package the manifest's asset record with
 * its version and download URL (`ListedRunnerAsset`). The server writes
 * that shape, and the app and the runner read it through
 * `readRunnerReleaseListing`, the one lenient reader.
 *
 * Each package unpacks into the fixed layout `RUNNER_PACKAGE_ENTRIES`, as
 * scripts/package-runner.mjs writes it; src/runner-release/archive.ts
 * accepts nothing else.
 *
 * Only erasable TypeScript here: the build scripts load this file with
 * Node's type stripping.
 */

export const RUNNER_RELEASE_SCHEMA_VERSION = 1;
export const RUNNER_RELEASE_PRODUCT = 'puck-runner';
/** The GitHub repository whose releases carry the runner packages. */
export const RUNNER_RELEASE_PUBLISHER = 'namikmesic/puck';

export const RUNNER_RELEASE_MANIFEST = 'runner-release.json';
export const RUNNER_RELEASE_SUMS = 'SHA256SUMS';
/** A detached signature's file is the signed file's name plus this. */
export const SIGNATURE_SUFFIX = '.sig';
export const ED25519_SIGNATURE_BYTES = 64;

/** Most bytes a manifest may have; readers refuse larger ones unread. */
export const MAX_MANIFEST_BYTES = 256 * 1024;
/** Most bytes a SHA256SUMS file may have. */
export const MAX_SUMS_BYTES = 16 * 1024;
/** Most signed releases one listing carries. */
export const MAX_RELEASE_RECORDS = 16;
/** Most bytes a whole release listing may have on the wire; readers refuse a larger body before parsing it. */
export const MAX_RELEASE_METADATA_BYTES = 4 * 1024 * 1024;

/**
 * How a runner build treats packages, compiled in by scripts/build-runner.mjs.
 * `production` accepts only releases signed by a compiled trust root;
 * `development` is the local, unsigned, checksum-based flow of a
 * development server.
 */
export type RunnerTrustMode = 'development' | 'production';
export const RUNNER_TRUST_MODES: readonly RunnerTrustMode[] = ['development', 'production'];

export const isRunnerTrustMode = (v: unknown): v is RunnerTrustMode => (RUNNER_TRUST_MODES as readonly unknown[]).includes(v);

export type RunnerOs = 'linux' | 'macos';
export type RunnerArch = 'x64' | 'arm64';

export interface RunnerTarget {
  os: RunnerOs;
  arch: RunnerArch;
}

/** The supported packages, in the order manifests and SHA256SUMS list them. */
export const RUNNER_TARGETS: readonly RunnerTarget[] = [
  { os: 'linux', arch: 'x64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'macos', arch: 'arm64' },
];

/** `linux-x64`: a target as the packaging scripts name it. */
export const targetName = (target: RunnerTarget): string => `${target.os}-${target.arch}`;

/** A package's exact file name. */
export function runnerPackageFile(target: RunnerTarget, version: string): string {
  return `puck-runner-${target.os}-${target.arch}-${version}.tar.gz`;
}

/** The Git tag of a release, and so the GitHub Release its assets hang off (RELEASE.md). */
export const runnerReleaseTag = (version: string): string => `v${version}`;

/**
 * The one mapping from Node's platform and architecture names to the
 * manifest's: `darwin` is `macos` in package names. Null for anything
 * runners do not run on.
 */
export function runnerTargetFor(platform: string, arch: string): RunnerTarget | null {
  const os: RunnerOs | null = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'macos' : null;
  const a: RunnerArch | null = arch === 'x64' || arch === 'arm64' ? arch : null;
  return os && a ? { os, arch: a } : null;
}

export interface RunnerPackageEntry {
  /** Relative path; a directory's ends with '/'. */
  name: string;
  type: 'file' | 'dir';
  /** The permission bits the packager writes and the archive reader restores; never setuid, setgid or sticky. */
  mode: number;
}

/**
 * What a package holds, in the order scripts/package-runner.mjs writes it:
 * nine regular files and `bin/`, nothing else, with these exact modes.
 */
export const RUNNER_PACKAGE_ENTRIES: readonly RunnerPackageEntry[] = [
  { name: 'config.sh', type: 'file', mode: 0o755 },
  { name: 'run.sh', type: 'file', mode: 0o755 },
  { name: 'svc.sh', type: 'file', mode: 0o755 },
  { name: 'VERSION', type: 'file', mode: 0o644 },
  { name: 'README.md', type: 'file', mode: 0o644 },
  { name: 'LICENSE', type: 'file', mode: 0o644 },
  { name: 'bin/', type: 'dir', mode: 0o755 },
  { name: 'bin/node', type: 'file', mode: 0o755 },
  { name: 'bin/node.LICENSE', type: 'file', mode: 0o644 },
  { name: 'bin/puck-runner.cjs', type: 'file', mode: 0o644 },
];

export interface RunnerReleaseAsset {
  os: RunnerOs;
  arch: RunnerArch;
  file: string;
  /** Lowercase hex SHA-256 of the file. */
  sha256: string;
  /** Bytes. */
  size: number;
}

/**
 * A release asset as a server's listing carries it: the manifest's record
 * plus the release version it belongs to and the URL that serves it.
 */
export interface ListedRunnerAsset extends RunnerReleaseAsset {
  version: string;
  url: string;
}

/** `GET /v1/runner/releases`: the newest release a server offers, the oldest runner version it accepts, and the newest release's assets. */
export interface RunnerReleaseListing {
  latest: string | null;
  minVersion: string | null;
  assets: ListedRunnerAsset[];
}

export interface RunnerReleaseManifest {
  schemaVersion: 1;
  product: 'puck-runner';
  publisher: string;
  version: string;
  /** The Puck commit the packages were built from. */
  sourceCommit: string;
  /** RUNNER_PROTOCOL_VERSION of the packaged runner. */
  runnerProtocol: number;
  /** The id of the key that signs this manifest (a release key id, see src/runner-release/verify.ts). */
  signingKeyId: string;
  /** SHA-256 of the release's SHA256SUMS file. */
  sha256sumsSha256: string;
  assets: RunnerReleaseAsset[];
}

/** What a runner's `version --json` prints, one line of JSON. */
export interface RunnerVersionProbe {
  version: string;
  trustMode: RunnerTrustMode;
  runnerProtocol: number;
}

export type RunnerReleaseErrorCode =
  /** The build trusts no release key. */
  | 'no-trusted-key'
  /** A trust root is not a usable Ed25519 public key, or there are too many. */
  | 'bad-key'
  /** No trusted key verifies the bytes. */
  | 'bad-signature'
  /** The manifest names a key other than the one that verified it. */
  | 'key-id-mismatch'
  /** Bytes, encoding, JSON or shape are wrong. */
  | 'malformed'
  | 'unsupported-schema'
  | 'wrong-product'
  | 'wrong-publisher'
  /** The manifest is for another version than the one selected. */
  | 'version-mismatch'
  /** A target the release must carry, or the one selected, is absent. */
  | 'missing-target'
  /** SHA256SUMS disagrees with the manifest. */
  | 'sums-mismatch';

export class RunnerReleaseError extends Error {
  readonly code: RunnerReleaseErrorCode;

  constructor(code: RunnerReleaseErrorCode, message: string) {
    super(message);
    this.name = 'RunnerReleaseError';
    this.code = code;
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
/** A release key id: the lowercase hex SHA-256 of the key's DER SPKI. */
export const RELEASE_KEY_ID_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A canonical MAJOR.MINOR.PATCH with safe-integer parts: no sign, no leading zeros, no suffix. */
export function isReleaseVersion(v: unknown): v is string {
  const m = typeof v === 'string' ? VERSION_RE.exec(v) : null;
  return !!m && [m[1], m[2], m[3]].every((part) => Number.isSafeInteger(Number(part)));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPositiveSafeInteger = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

const MANIFEST_KEYS = ['schemaVersion', 'product', 'publisher', 'version', 'sourceCommit', 'runnerProtocol', 'signingKeyId', 'sha256sumsSha256', 'assets'] as const;
const ASSET_KEYS = ['os', 'arch', 'file', 'sha256', 'size'] as const;

const malformed = (message: string): RunnerReleaseError => new RunnerReleaseError('malformed', message);

function exactKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw malformed(`${what} has an unexpected field "${key}".`);
  for (const key of keys) if (!(key in value)) throw malformed(`${what} lacks "${key}".`);
}

function readAsset(value: unknown, version: string): RunnerReleaseAsset {
  if (!isObject(value)) throw malformed('Each runner-release asset must be an object.');
  const target = RUNNER_TARGETS.find((t) => t.os === value.os && t.arch === value.arch);
  if (!target) throw malformed(`runner-release.json lists an unsupported target ${JSON.stringify(`${String(value.os)}-${String(value.arch)}`)}.`);
  const name = targetName(target);
  exactKeys(value, ASSET_KEYS, `The ${name} asset`);
  const file = runnerPackageFile(target, version);
  if (value.file !== file) throw malformed(`The ${name} asset is ${JSON.stringify(value.file)}, not ${file}.`);
  if (typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)) throw malformed(`The ${name} asset's sha256 is not 64 lowercase hex digits.`);
  if (!isPositiveSafeInteger(value.size)) throw malformed(`The ${name} asset's size must be a positive whole number of bytes.`);
  return { os: target.os, arch: target.arch, file, sha256: value.sha256, size: value.size };
}

/**
 * Reads a manifest's text strictly: exactly the schema-1 fields, exactly
 * the three supported targets once each, file names that match the
 * version. Throws RunnerReleaseError. Only verified bytes may reach this in
 * a consumer (src/runner-release/verify.ts).
 */
export function readRunnerRelease(text: string): RunnerReleaseManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw malformed('runner-release.json is not JSON.');
  }
  if (!isObject(value)) throw malformed('runner-release.json must be a JSON object.');
  if (value.schemaVersion !== RUNNER_RELEASE_SCHEMA_VERSION) {
    throw new RunnerReleaseError('unsupported-schema', `runner-release.json has schema version ${JSON.stringify(value.schemaVersion)}; this build reads ${RUNNER_RELEASE_SCHEMA_VERSION}.`);
  }
  if (value.product !== RUNNER_RELEASE_PRODUCT) throw new RunnerReleaseError('wrong-product', `runner-release.json is for ${JSON.stringify(value.product)}, not ${RUNNER_RELEASE_PRODUCT}.`);
  if (value.publisher !== RUNNER_RELEASE_PUBLISHER) {
    throw new RunnerReleaseError('wrong-publisher', `runner-release.json is published by ${JSON.stringify(value.publisher)}, not ${RUNNER_RELEASE_PUBLISHER}.`);
  }
  exactKeys(value, MANIFEST_KEYS, 'runner-release.json');
  const { version, sourceCommit, runnerProtocol, signingKeyId, sha256sumsSha256, assets } = value;
  if (!isReleaseVersion(version)) throw malformed(`runner-release.json has version ${JSON.stringify(version)}, not MAJOR.MINOR.PATCH.`);
  if (typeof sourceCommit !== 'string' || !COMMIT_RE.test(sourceCommit)) throw malformed('runner-release.json sourceCommit is not a 40-digit lowercase hex commit.');
  if (!isPositiveSafeInteger(runnerProtocol)) throw malformed('runner-release.json runnerProtocol must be a positive whole number.');
  if (typeof signingKeyId !== 'string' || !RELEASE_KEY_ID_RE.test(signingKeyId)) throw malformed('runner-release.json signingKeyId is not a release key id.');
  if (typeof sha256sumsSha256 !== 'string' || !SHA256_RE.test(sha256sumsSha256)) throw malformed('runner-release.json sha256sumsSha256 is not 64 lowercase hex digits.');
  if (!Array.isArray(assets)) throw malformed('runner-release.json assets must be an array.');
  const read = assets.map((a) => readAsset(a, version));
  for (const target of RUNNER_TARGETS) {
    const count = read.filter((a) => a.os === target.os && a.arch === target.arch).length;
    if (count > 1) throw malformed(`runner-release.json lists ${targetName(target)} more than once.`);
    if (count === 0) throw new RunnerReleaseError('missing-target', `runner-release.json has no ${targetName(target)} package.`);
  }
  return {
    schemaVersion: RUNNER_RELEASE_SCHEMA_VERSION,
    product: RUNNER_RELEASE_PRODUCT,
    publisher: RUNNER_RELEASE_PUBLISHER,
    version,
    sourceCommit,
    runnerProtocol,
    signingKeyId,
    sha256sumsSha256,
    assets: read,
  };
}

/**
 * A manifest's file text, for the packaging script: fixed key order, two
 * spaces, a final newline. Readers never call this; they check the bytes
 * that were signed.
 */
export function formatRunnerRelease(manifest: RunnerReleaseManifest): string {
  const ordered = {
    schemaVersion: manifest.schemaVersion,
    product: manifest.product,
    publisher: manifest.publisher,
    version: manifest.version,
    sourceCommit: manifest.sourceCommit,
    runnerProtocol: manifest.runnerProtocol,
    signingKeyId: manifest.signingKeyId,
    sha256sumsSha256: manifest.sha256sumsSha256,
    assets: manifest.assets.map((a) => ({ os: a.os, arch: a.arch, file: a.file, sha256: a.sha256, size: a.size })),
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}

/**
 * The package a caller selected, from a verified manifest: the manifest
 * must be the selected version, and carry the selected platform under its
 * exact file name.
 */
export function selectRunnerAsset(manifest: RunnerReleaseManifest, want: { version: string; os: string; arch: string }): RunnerReleaseAsset {
  if (manifest.version !== want.version) {
    throw new RunnerReleaseError('version-mismatch', `The signed release is version ${manifest.version}, not the selected ${want.version}.`);
  }
  const asset = manifest.assets.find((a) => a.os === want.os && a.arch === want.arch);
  if (!asset) throw new RunnerReleaseError('missing-target', `Runner ${want.version} has no package for ${want.os}-${want.arch}.`);
  if (asset.file !== runnerPackageFile(asset, want.version)) throw malformed(`The ${want.os}-${want.arch} package is ${asset.file}, not ${runnerPackageFile(asset, want.version)}.`);
  return asset;
}

/** SHA256SUMS text: `<sha256>  <file>` per asset, in order, each line ending in a newline. */
export function formatSha256Sums(assets: readonly { file: string; sha256: string }[]): string {
  return assets.map((a) => `${a.sha256}  ${a.file}\n`).join('');
}

/** Reads SHA256SUMS strictly: that exact line format, no blank lines, each file once. */
export function readSha256Sums(text: string): { file: string; sha256: string }[] {
  if (!text.endsWith('\n')) throw new RunnerReleaseError('sums-mismatch', 'SHA256SUMS must end with a newline.');
  const out: { file: string; sha256: string }[] = [];
  for (const line of text.slice(0, -1).split('\n')) {
    const m = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line);
    if (!m) throw new RunnerReleaseError('sums-mismatch', `SHA256SUMS has an unreadable line ${JSON.stringify(line)}.`);
    if (out.some((e) => e.file === m[2])) throw new RunnerReleaseError('sums-mismatch', `SHA256SUMS lists ${m[2]} more than once.`);
    out.push({ file: m[2], sha256: m[1] });
  }
  return out;
}

/**
 * Checks that a release's SHA256SUMS (its text and SHA-256) is the one the
 * manifest names and lists exactly the manifest's packages with the same
 * digests.
 */
export function checkSha256Sums(manifest: RunnerReleaseManifest, text: string, sha256: string): void {
  if (sha256 !== manifest.sha256sumsSha256) throw new RunnerReleaseError('sums-mismatch', 'SHA256SUMS is not the file runner-release.json names.');
  const sums = readSha256Sums(text);
  if (sums.length !== manifest.assets.length) throw new RunnerReleaseError('sums-mismatch', `SHA256SUMS lists ${sums.length} files; runner-release.json lists ${manifest.assets.length}.`);
  for (const asset of manifest.assets) {
    const line = sums.find((s) => s.file === asset.file);
    if (!line) throw new RunnerReleaseError('sums-mismatch', `SHA256SUMS does not list ${asset.file}.`);
    if (line.sha256 !== asset.sha256) throw new RunnerReleaseError('sums-mismatch', `SHA256SUMS and runner-release.json disagree about ${asset.file}.`);
  }
}

/** The line a runner's `version --json` prints. */
export function formatVersionProbe(probe: RunnerVersionProbe): string {
  return JSON.stringify({ version: probe.version, trustMode: probe.trustMode, runnerProtocol: probe.runnerProtocol }) + '\n';
}

/** Reads `version --json` output. Fields added later are ignored; the three here are required. */
export function readVersionProbe(text: string): RunnerVersionProbe {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw malformed(`The runner's version --json output is not JSON: ${JSON.stringify(text.slice(0, 200))}`);
  }
  if (!isObject(value)) throw malformed("The runner's version --json output is not an object.");
  const { version, trustMode, runnerProtocol } = value;
  if (!isReleaseVersion(version)) throw malformed(`The runner reports version ${JSON.stringify(version)}.`);
  if (!isRunnerTrustMode(trustMode)) throw malformed(`The runner reports trust mode ${JSON.stringify(trustMode)}.`);
  if (!isPositiveSafeInteger(runnerProtocol)) throw malformed(`The runner reports protocol ${JSON.stringify(runnerProtocol)}.`);
  return { version, trustMode, runnerProtocol };
}

/**
 * A signed release as a listing carries it: runner-release.json's exact
 * bytes and its detached signature, each standard base64 with padding.
 */
export interface SignedRunnerRelease {
  manifest: string;
  signature: string;
}

/** Base64 text of a maximal manifest: the byte bound, accounting for the encoding. */
export const MAX_MANIFEST_BASE64_CHARS = Math.ceil(MAX_MANIFEST_BYTES / 3) * 4;
const SIGNATURE_BASE64_CHARS = Math.ceil(ED25519_SIGNATURE_BYTES / 3) * 4;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const RECORD_KEYS = ['manifest', 'signature'] as const;

/**
 * Decodes canonical base64: the standard alphabet with padding, no
 * whitespace, and exactly one encoding of the bytes (a re-encoding must
 * give the text back). `maxChars` bounds the text before it is decoded.
 */
function decodeBase64(value: unknown, maxChars: number, what: string): Uint8Array {
  if (typeof value !== 'string') throw malformed(`${what} must be a base64 string.`);
  if (value.length > maxChars) throw malformed(`${what} is over ${maxChars} characters of base64.`);
  if (!BASE64_RE.test(value)) throw malformed(`${what} is not standard base64.`);
  const binary = atob(value);
  if (btoa(binary) !== value) throw malformed(`${what} is not canonical base64.`);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Standard base64 with padding, the encoding readSignedRunnerRelease accepts. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(binary);
}

/**
 * Reads one signed release record strictly: exactly its two fields, the
 * manifest at most MAX_MANIFEST_BYTES once decoded and the signature
 * exactly ED25519_SIGNATURE_BYTES. The bytes come back as sent, for the
 * verifier (src/runner-release/verify.ts); nothing here trusts them.
 */
export function readSignedRunnerRelease(value: unknown): { manifest: Uint8Array; signature: Uint8Array } {
  if (!isObject(value)) throw malformed('A signed release record must be an object.');
  exactKeys(value, RECORD_KEYS, 'A signed release record');
  const manifest = decodeBase64(value.manifest, MAX_MANIFEST_BASE64_CHARS, "A signed release record's manifest");
  if (manifest.length > MAX_MANIFEST_BYTES) throw malformed(`A signed release record's manifest is over ${MAX_MANIFEST_BYTES} bytes.`);
  const signature = decodeBase64(value.signature, SIGNATURE_BASE64_CHARS, "A signed release record's signature");
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw malformed(`A signed release record's signature is ${signature.length} bytes, not ${ED25519_SIGNATURE_BYTES}.`);
  }
  return { manifest, signature };
}

/** Reads a listing's records: an array of at most MAX_RELEASE_RECORDS, each read strictly. */
export function readSignedRunnerReleases(value: unknown): { manifest: Uint8Array; signature: Uint8Array }[] {
  if (!Array.isArray(value)) throw malformed('Signed release records must be an array.');
  if (value.length > MAX_RELEASE_RECORDS) throw malformed(`A listing carries at most ${MAX_RELEASE_RECORDS} signed releases; this one has ${value.length}.`);
  return value.map(readSignedRunnerRelease);
}

/** The record for a manifest's exact bytes and its signature. */
export function formatSignedRunnerRelease(manifest: Uint8Array, signature: Uint8Array): SignedRunnerRelease {
  return { manifest: encodeBase64(manifest), signature: encodeBase64(signature) };
}

const isRunnerOs = (v: unknown): v is RunnerOs => v === 'linux' || v === 'macos';
const isRunnerArch = (v: unknown): v is RunnerArch => v === 'x64' || v === 'arm64';
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Reads a release listing leniently, so a newer server that adds fields
 * keeps working: a field that is absent or of another type reads as empty,
 * and an asset is dropped unless it names a runner os and arch, a URL, and
 * a lowercase hex sha256. Nothing here is verified: whoever downloads an
 * asset checks it against the listed sha256 before unpacking it.
 */
export function readRunnerReleaseListing(value: unknown): RunnerReleaseListing {
  const o = isObject(value) ? value : {};
  const assets = Array.isArray(o.assets)
    ? o.assets.flatMap((a): ListedRunnerAsset[] =>
        isObject(a) && isRunnerOs(a.os) && isRunnerArch(a.arch) && str(a.url) && SHA256_RE.test(str(a.sha256))
          ? [{ os: a.os, arch: a.arch, version: str(a.version), file: str(a.file), url: str(a.url), sha256: str(a.sha256), size: typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : 0 }]
          : [],
      )
    : [];
  return { latest: typeof o.latest === 'string' ? o.latest : null, minVersion: typeof o.minVersion === 'string' ? o.minVersion : null, assets };
}
