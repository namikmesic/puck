/**
 * Pure provisioning plans derived from the provider registry — kept free of
 * fs/docker so they can be unit-tested exactly as they will execute.
 *
 * Every provider package is PINNED (`PinnedPackage`): the install scripts
 * install exact versions, and `verifyScript` + `verifyPins` check what is
 * actually on disk afterwards, so a container never silently runs an SDK the
 * runner was not written against. The pins are also what a prepared base
 * image (a follow-up) would bake in.
 */

import type { HarnessDescriptor, PinnedPackage } from '../harness/providers';

/** Where the runner's SDKs live inside the container (`npm --prefix`). */
export const SDK_PREFIX = '/opt/puck';

export function pinnedSpec(pkg: PinnedPackage): string {
  return `${pkg.name}@${pkg.version}`;
}

/** Shell helper: prints a package's installed version, or `missing`. */
const VERSION_FN =
  'v() { node -p "require(process.argv[1]+\'/package.json\').version" "$1" 2>/dev/null || echo missing; }';

function checkChain(root: string, pkgs: PinnedPackage[]): string {
  return pkgs.map((p) => `[ "$(v "${root}/${p.name}")" = "${p.version}" ]`).join(' && ');
}

/**
 * One bootstrap step per package group, run with `sh -lc`: interactive CLIs
 * (docker exec -it … codex login) and the SDKs the runner agent imports
 * under /opt/puck. `check` exits 0 when every package is installed at its
 * pinned version, so an already-provisioned container is a no-op; `install`
 * installs the exact pins and runs only when the check fails. Keeping them
 * apart lets the UI say "npm install …" while the install runs instead of
 * pretending it is still checking. Providers without a CLI (API-key-only)
 * simply don't contribute — the plan stays valid for any registry composition.
 */
export interface BootstrapStep {
  kind: 'clis' | 'sdks';
  /** Exit 0 when every pin is installed at its version (read-only). */
  check: string;
  /** Installs the exact pins. */
  install: string;
}

export function bootstrapPlan(list: readonly HarnessDescriptor[]): BootstrapStep[] {
  const steps: BootstrapStep[] = [];
  const clis = list
    .filter((p) => p.packages.cliBin && p.packages.cli.length > 0)
    .flatMap((p) => p.packages.cli);
  if (clis.length) {
    steps.push({
      kind: 'clis',
      check: `${VERSION_FN}; root="$(npm root -g)"; ${checkChain('$root', clis)}`,
      install: `npm install -g ${clis.map(pinnedSpec).join(' ')}`,
    });
  }
  const sdks = list.flatMap((p) => p.packages.sdk);
  if (sdks.length) {
    steps.push({
      kind: 'sdks',
      check: `${VERSION_FN}; ${checkChain(`${SDK_PREFIX}/node_modules`, sdks)}`,
      install: `npm install --prefix ${SDK_PREFIX} ${sdks.map(pinnedSpec).join(' ')}`,
    });
  }
  return steps;
}

export type PackageKind = 'cli' | 'sdk';

export interface ExpectedPackage extends PinnedPackage {
  kind: PackageKind;
}

/** Every pinned package the registry expects inside a container. */
export function expectedPackages(list: readonly HarnessDescriptor[]): ExpectedPackage[] {
  return list.flatMap((p) => [
    ...(p.packages.cliBin ? p.packages.cli : []).map((pkg) => ({ ...pkg, kind: 'cli' as const })),
    ...p.packages.sdk.map((pkg) => ({ ...pkg, kind: 'sdk' as const })),
  ]);
}

/**
 * Prints one `<name> <version|missing>` line per expected package — parsed
 * host-side by `parseInstalledVersions`. Runs read-only (no installs).
 */
export function verifyScript(expected: readonly ExpectedPackage[]): string {
  const lines = expected.map((p) => {
    const root = p.kind === 'cli' ? '$root' : `${SDK_PREFIX}/node_modules`;
    return `echo "${p.name} $(v "${root}/${p.name}")"`;
  });
  return `${VERSION_FN}; root="$(npm root -g 2>/dev/null)"; ${lines.join('; ')}`;
}

export function parseInstalledVersions(stdout: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [name, version] = line.split(/\s+/);
    if (!name) continue;
    out.set(name, version && version !== 'missing' ? version : null);
  }
  return out;
}

export interface PinReport {
  /** Mismatches that must fail setup. */
  errors: string[];
  /** Differences worth showing but not fatal (user-managed images). */
  notes: string[];
}

/**
 * Compare the pins with what is installed. `managed` (auto-install on) means
 * Puck installed these and any drift is a setup failure; otherwise the user
 * provisions the image themselves and only a MISSING SDK is fatal — the
 * runner cannot work without it — while CLI absence and version differences
 * become notes.
 */
export function verifyPins(
  expected: readonly ExpectedPackage[],
  installed: ReadonlyMap<string, string | null>,
  managed: boolean,
): PinReport {
  const errors: string[] = [];
  const notes: string[] = [];
  for (const p of expected) {
    const actual = installed.has(p.name) ? installed.get(p.name) ?? null : null;
    if (actual === p.version) continue;
    const where = p.kind === 'sdk' ? `under ${SDK_PREFIX}` : 'globally';
    const found = actual === null ? 'is not installed' : `is ${actual}`;
    const msg = `${p.name} ${found} ${where}, expected ${p.version}`;
    if (managed) errors.push(msg);
    else if (p.kind === 'sdk' && actual === null) errors.push(msg);
    else notes.push(msg);
  }
  return { errors, notes };
}

export function describePinFailure(report: PinReport, managed: boolean): string {
  const hint = managed
    ? 'The install step did not produce the pinned versions.'
    : 'Auto-install is off for this environment; install the packages in your Dockerfile or enable auto-install.';
  return `Provider package verification failed: ${report.errors.join('; ')}. ${hint}`;
}
