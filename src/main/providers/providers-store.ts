/**
 * puck-providers.json: provider configuration that is not a secret - the
 * Docker-over-SSH hosts and the GitHub integration's settings. Tokens never
 * land here (they are encrypted through secrets.ts).
 *
 * Migrate, don't break: every field gets a default at load, so a file
 * written by an older build (or a hand-edited one) still reads.
 */

import * as crypto from 'node:crypto';
import type { GitHubMode } from '../../harness/bridge';
import { defineStore } from '../store';

export interface SshHost {
  id: string;
  label: string;
  /** `ssh://user@host[:port]` or an ssh-config alias (validated at the IPC boundary). */
  host: string;
}

export interface GitHubSettings {
  /** `owner/name`, or null until one is chosen. */
  configRepo: string | null;
  mode: GitHubMode;
}

export interface ProvidersFile {
  v: 1;
  sshHosts: SshHost[];
  github: GitHubSettings;
}

const defaults = (): ProvidersFile => ({ v: 1, sshHosts: [], github: { configRepo: null, mode: 'app' } });

const isStr = (value: unknown): value is string => typeof value === 'string';

/** Lenient load: unknown or malformed entries are dropped, missing fields defaulted. */
export function normalizeProviders(raw: unknown): ProvidersFile {
  const file = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const hosts = Array.isArray(file.sshHosts) ? (file.sshHosts as unknown[]) : [];
  const github = (typeof file.github === 'object' && file.github !== null ? file.github : {}) as Record<
    string,
    unknown
  >;
  return {
    v: 1,
    sshHosts: hosts.flatMap((h) => {
      const host = (typeof h === 'object' && h !== null ? h : {}) as Record<string, unknown>;
      // A leading dash would reach docker argv as a flag; never load one.
      if (!isStr(host.id) || !isStr(host.host) || !host.host || host.host.startsWith('-')) return [];
      return [{ id: host.id, label: isStr(host.label) ? host.label : host.host, host: host.host }];
    }),
    github: {
      configRepo: isStr(github.configRepo) ? github.configRepo : null,
      mode: github.mode === 'pat' ? 'pat' : 'app',
    },
  };
}

const store = defineStore<ProvidersFile>({
  file: 'puck-providers.json',
  defaults,
  migrate: normalizeProviders,
});

export function sshHosts(): SshHost[] {
  return store.read().sshHosts.map((h) => ({ ...h }));
}

export function sshHostById(id: string): SshHost | undefined {
  return store.read().sshHosts.find((h) => h.id === id);
}

export function addSshHost(input: { label: string; host: string }): SshHost {
  const state = store.read();
  if (state.sshHosts.some((h) => h.host === input.host)) {
    throw new Error(`${input.host} is already in the list.`);
  }
  const host: SshHost = { id: crypto.randomUUID(), label: input.label || input.host, host: input.host };
  state.sshHosts.push(host);
  store.persist();
  return host;
}

export function removeSshHost(id: string): void {
  const state = store.read();
  state.sshHosts = state.sshHosts.filter((h) => h.id !== id);
  store.persist();
}

export function githubSettings(): GitHubSettings {
  return { ...store.read().github };
}

export function updateGithubSettings(patch: Partial<GitHubSettings>): GitHubSettings {
  const state = store.read();
  state.github = { ...state.github, ...patch };
  store.persist();
  return { ...state.github };
}
