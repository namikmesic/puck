/**
 * Pure provisioning plans derived from the provider registry — kept free of
 * fs/docker so they can be unit-tested exactly as they will execute.
 */

import type { Provider } from './providers/types';

/**
 * Shell scripts (run with `sh -lc`) that install what containers need:
 * interactive CLIs (docker exec -it … codex login) and the SDKs the runner
 * agent imports under /opt/puck. Each script is a check-chain with an
 * install fallback, so an already-provisioned container is a no-op.
 * Providers without a CLI (API-key-only) simply don't contribute — the
 * generated script stays valid for any registry composition.
 */
export function bootstrapPlan(list: readonly Provider[]): string[] {
  const scripts: string[] = [];
  const clis = list.filter((p) => p.container.cliBin && p.container.cliPackages.length > 0);
  if (clis.length) {
    scripts.push(
      clis.map((p) => `command -v ${p.container.cliBin} >/dev/null 2>&1`).join(' && ') +
        ' || npm install -g ' +
        clis.flatMap((p) => p.container.cliPackages).join(' '),
    );
  }
  const sdks = list.flatMap((p) => p.container.sdkPackages);
  if (sdks.length) {
    scripts.push(
      sdks.map((pkg) => `[ -d /opt/puck/node_modules/${pkg} ]`).join(' && ') +
        ' || npm install --prefix /opt/puck ' +
        sdks.join(' '),
    );
  }
  return scripts;
}
