/**
 * Where everything lives inside an environment container. One table so the
 * boot sequence, provisioning and the tests agree; tests build the same
 * layout under a temporary root.
 *
 *   /opt/puck        container layer: the bundle, SDKs, wrapper scripts
 *   /puck            data volume: state (root 0700), inbox (root 0700),
 *                    mirrors (root, readable), home (the puck user's HOME)
 *   /workspace       workspace volume: working clones, owned by puck
 *   /run/puck        the control socket (root 0600)
 */

import * as path from 'node:path';

/** The unprivileged user every harness CLI (and so every agent) runs as. */
export const PUCK_UID = 10001;
export const PUCK_GID = 10001;
export const PUCK_USER = 'puck';

export interface DaemonPaths {
  opt: string;
  /** The running bundle and the staged upgrade next to it. */
  bundle: string;
  nextBundle: string;
  bin: string;
  /** Marks this container layer; changes when the container is rebuilt. */
  layerId: string;
  data: string;
  state: string;
  inbox: string;
  mirrors: string;
  home: string;
  workspace: string;
  run: string;
  socket: string;
  lock: string;
  logs: string;
  events: string;
  transcripts: string;
  secrets: string;
  /** Harness credential files received before the puck user existed. */
  stagedCredentials: string;
}

export function daemonPaths(root = '/'): DaemonPaths {
  const at = (...parts: string[]): string => path.join(root, ...parts);
  const state = at('puck', 'state');
  return {
    opt: at('opt', 'puck'),
    bundle: at('opt', 'puck', 'puckd.js'),
    nextBundle: at('opt', 'puck', 'puckd.next.js'),
    bin: at('opt', 'puck', 'bin'),
    layerId: at('opt', 'puck', 'layer-id'),
    data: at('puck'),
    state,
    inbox: at('puck', 'inbox'),
    mirrors: at('puck', 'mirrors'),
    home: at('puck', 'home'),
    workspace: at('workspace'),
    run: at('run', 'puck'),
    socket: at('run', 'puck', 'puckd.sock'),
    lock: path.join(state, 'puckd.lock'),
    logs: path.join(state, 'logs'),
    events: path.join(state, 'events'),
    transcripts: path.join(state, 'transcripts'),
    secrets: path.join(state, 'secrets'),
    stagedCredentials: path.join(state, 'credentials'),
  };
}
