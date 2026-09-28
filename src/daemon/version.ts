/**
 * The daemon's identity. `build` is the sha256 of the running bundle,
 * computed from the file itself (a bundle cannot contain its own hash);
 * scripts/build-daemon.mjs records the same hash in puckd.meta.json, so the
 * app can compare what it embeds with what a container runs.
 * `daemonVersion` is the app version plus that hash.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { PROTOCOL_VERSION } from '../harness/daemon-protocol';

// Replaced at build time by webpack's DefinePlugin.
declare const __PUCK_APP_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __PUCK_APP_VERSION__ === 'string' ? __PUCK_APP_VERSION__ : '0.0.0-dev';

export interface DaemonIdentity {
  daemonVersion: string;
  protocolVersion: number;
  build: string;
}

export function bundleHash(file: string): string {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return 'unknown';
  }
}

export function daemonIdentity(bundleFile: string): DaemonIdentity {
  const build = bundleHash(bundleFile);
  return { daemonVersion: `${APP_VERSION}+${build.slice(0, 12)}`, protocolVersion: PROTOCOL_VERSION, build };
}
