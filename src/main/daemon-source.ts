/**
 * The environment daemon (puckd), embedded as a raw string through the
 * `raw-daemon` alias (webpack `asset/source`), plus the metadata
 * scripts/build-daemon.mjs wrote beside it: the app version and the
 * bundle's sha256, which a running daemon reports as its `build`.
 * Environments get this bundle through their runner's cache (`bundle.put`).
 */

import daemonSource from 'raw-daemon';
import daemonMeta from 'raw-daemon-meta';

export const DAEMON_SOURCE: string = daemonSource;
export const DAEMON_META: { version: string; build: string } = daemonMeta;
