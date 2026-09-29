/**
 * puck-providers.json: provider configuration that is not a secret - the
 * GitHub integration's settings. Tokens never land here (they are encrypted
 * through secrets.ts).
 *
 * Migrate, don't break: every field gets a default at load, so a file
 * written by an older build (or a hand-edited one) still reads, and fields
 * this build does not know are dropped.
 */

import { defineStore } from '../store';

export interface GitHubSettings {
  /** `owner/name`, or null until one is chosen. */
  configRepo: string | null;
}

export interface ProvidersFile {
  v: 1;
  github: GitHubSettings;
}

const defaults = (): ProvidersFile => ({ v: 1, github: { configRepo: null } });

const isStr = (value: unknown): value is string => typeof value === 'string';

/** Lenient load: unknown or malformed entries are dropped, missing fields defaulted. */
export function normalizeProviders(raw: unknown): ProvidersFile {
  const file = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const github = (typeof file.github === 'object' && file.github !== null ? file.github : {}) as Record<
    string,
    unknown
  >;
  return {
    v: 1,
    github: {
      configRepo: isStr(github.configRepo) ? github.configRepo : null,
    },
  };
}

const store = defineStore<ProvidersFile>({
  file: 'puck-providers.json',
  defaults,
  migrate: normalizeProviders,
});

export function githubSettings(): GitHubSettings {
  return { ...store.read().github };
}

export function updateGithubSettings(patch: Partial<GitHubSettings>): GitHubSettings {
  const state = store.read();
  state.github = { ...state.github, ...patch };
  store.persist();
  return { ...state.github };
}
