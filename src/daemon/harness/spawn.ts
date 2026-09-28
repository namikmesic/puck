/**
 * Launching harness CLIs as the unprivileged puck user.
 *
 * The daemon runs as root; the CLIs it drives (and so every tool call an
 * agent makes) run as uid/gid 10001. Claude: the Agent SDK hands its spawn
 * to `spawnClaudeCodeProcess`, which drops privileges through Node's
 * spawn(uid, gid); the SDK talks to the child over its stdio, so in-process
 * MCP tools still execute in the root daemon. Codex: the SDK runs a wrapper
 * script instead of the CLI, and the wrapper drops privileges with setpriv.
 *
 * The harness environment is an allowlist (see `harnessEnv`); nothing from
 * the daemon's own environment reaches a CLI, and PUCK_* never does.
 */

import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../log';
import { PUCK_GID, PUCK_UID } from '../paths';

export const HARNESS_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** The Codex SDK runs this instead of `codex`; written at provisioning. */
export const CODEX_AS_PUCK = '/opt/puck/bin/codex-as-puck';

export function codexWrapperScript(uid = PUCK_UID, gid = PUCK_GID): string {
  return [
    '#!/bin/sh',
    '# Runs the Codex CLI as the puck user (written by puckd).',
    `exec setpriv --reuid=${uid} --regid=${gid} --init-groups -- "$(command -v codex)" "$@"`,
    '',
  ].join('\n');
}

/**
 * The complete environment of a harness process: PATH, HOME, USER, LANG,
 * the definition's env, then the environment's secrets. PUCK_* keys are
 * dropped wherever they come from.
 */
export function harnessEnv(opts: {
  home: string;
  lang?: string;
  definitionEnv?: Record<string, string>;
  secrets?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: HARNESS_PATH,
    HOME: opts.home,
    USER: 'puck',
    LANG: opts.lang || 'C.UTF-8',
    ...opts.definitionEnv,
    ...opts.secrets,
  };
  for (const key of Object.keys(env)) if (key.startsWith('PUCK_')) delete env[key];
  return env;
}

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: 'pipe' },
) => ChildProcessWithoutNullStreams;

/** Builds the SDK's `spawnClaudeCodeProcess` hook: the Claude CLI as the puck user. */
export function claudeSpawner(
  log: Logger,
  opts: { uid?: number; gid?: number; spawnFn?: SpawnFn } = {},
): (options: SpawnOptions) => SpawnedProcess {
  const spawnFn: SpawnFn = opts.spawnFn ?? ((command, args, options) => spawn(command, args, options));
  return (options) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env)) {
      if (value !== undefined && !key.startsWith('PUCK_')) env[key] = value;
    }
    const child = spawnFn(options.command, options.args, {
      cwd: options.cwd,
      env,
      signal: options.signal,
      uid: opts.uid ?? PUCK_UID,
      gid: opts.gid ?? PUCK_GID,
      stdio: 'pipe',
    });
    // The CLI's stderr is diagnostics; keep a bounded, redacted trace of it.
    let buffered = '';
    child.stderr.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) log.warn('claude.stderr', { line: line.slice(0, 500) });
    });
    child.on('error', (err) => log.error('claude.spawn', err));
    return child;
  };
}
