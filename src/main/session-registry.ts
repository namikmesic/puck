/**
 * Provider-native resume ids (Claude session ids / Codex thread ids), keyed
 * `agentId@envId` and persisted so long-lived conversations survive app
 * restarts. Scoped to the environment because a rebuilt container has no
 * transcripts — its ids must die with it. Re-exports the shared policy for
 * recognizing "this resume id no longer resolves" provider errors.
 */

import { defineStore } from './store';

// The stale-resume policy is shared with the environment daemon.
export { isStaleResumeError } from '../harness/resume';

// Null-prototype records: agent ids are arbitrary slugs, and a key like
// `constructor` must never resolve to something inherited from Object.
const store = defineStore<Record<string, string>>({
  file: 'puck-resume.json',
  defaults: () => Object.create(null) as Record<string, string>,
  migrate: (raw) => Object.assign(Object.create(null) as Record<string, string>, raw),
});

const keyOf = (agentId: string, envId: string): string => `${agentId}@${envId}`;

/** The id to resume with, or null for a fresh conversation. */
export function resumeIdFor(agentId: string, envId: string): string | null {
  const m = store.read();
  // Legacy fallback: pre-env-scoping maps were keyed by agent id alone.
  return m[keyOf(agentId, envId)] ?? m[agentId] ?? null;
}

export function remember(agentId: string, envId: string, providerSessionId: string): void {
  const m = store.read();
  m[keyOf(agentId, envId)] = providerSessionId;
  delete m[agentId]; // retire the legacy un-scoped key
  store.persist();
}

/** Drop a resume id the provider refused (conversation restarts fresh). */
export function forget(agentId: string, envId: string): void {
  const m = store.read();
  delete m[keyOf(agentId, envId)];
  delete m[agentId];
  store.persist();
}

/** An environment was rebuilt/reset: every id scoped to it is now dead.
 *  Legacy un-scoped keys can't be attributed to an env, so they die too —
 *  safer to lose a resume than to wedge a conversation on a stale id. */
export function forgetEnvironment(envId: string): void {
  const m = store.read();
  let changed = false;
  for (const key of Object.keys(m)) {
    if (key.endsWith(`@${envId}`) || !key.includes('@')) {
      delete m[key];
      changed = true;
    }
  }
  if (changed) store.persist();
}
