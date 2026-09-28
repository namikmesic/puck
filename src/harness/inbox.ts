/**
 * Inbox fields the daemon stores: secret values, harness credential files, and pins.
 */

import type { Pin } from './daemon-protocol';
import { ENV_KEY_RE } from './env-definition';
import { harnessDescriptorById } from './providers';

const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Secret values the daemon will store. Any other shape rejects the whole set. */
export function validSecretValues(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ENV_KEY_RE.test(key) || key.startsWith('PUCK_')) return null;
    if (typeof value !== 'string' || value.length > MAX_SECRET_BYTES) return null;
    out[key] = value;
  }
  return out;
}

/** A harness credential file: JSON for a known harness, at most 64KB. */
export function validHarnessContent(id: string, content: unknown): content is string {
  if (!harnessDescriptorById(id) || typeof content !== 'string') return false;
  if (!content || utf8Bytes(content) > MAX_CREDENTIAL_BYTES) return false;
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

/** A pin the daemon will keep. Anything else is not a pin. */
export function validPin(raw: unknown): Pin | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (p.kind !== 'tag' && p.kind !== 'branch' && p.kind !== 'commit') return null;
  if (typeof p.name !== 'string' || typeof p.sha !== 'string' || !/^[0-9a-f]{7,64}$/.test(p.sha)) return null;
  return { kind: p.kind, name: p.name.slice(0, 200), sha: p.sha };
}
