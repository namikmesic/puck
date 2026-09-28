/**
 * instance.json: which environment this is and what it runs: the envId,
 * the applied definition (the resolved JSON the app delivered) with its pin
 * and sha, every definition applied so far, and the provisioning
 * fingerprints that let a restart skip work already done on this container.
 */

import * as path from 'node:path';
import type { Pin } from '../../harness/daemon-protocol';
import { JsonStore } from './store';

export interface InstanceRecord {
  envId: string;
  name: string;
  pin: Pin | null;
  sha: string | null;
  /** The resolved definition exactly as delivered (read through definition.ts). */
  definition: unknown;
  history: { sha: string | null; pin: Pin | null; appliedAt: number }[];
  provisioned: {
    fingerprint: string;
    at: number;
    /** Per-stage fingerprints; a stage whose fingerprint is unchanged is skipped. */
    stages?: Record<string, string>;
  } | null;
}

function normalize(raw: unknown): InstanceRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<InstanceRecord>;
  if (typeof r.envId !== 'string') return null;
  return {
    envId: r.envId,
    name: r.name ?? '',
    pin: r.pin ?? null,
    sha: r.sha ?? null,
    definition: r.definition ?? null,
    history: Array.isArray(r.history) ? r.history : [],
    provisioned: r.provisioned ?? null,
  };
}

export function instanceStore(stateDir: string): JsonStore<InstanceRecord | null> {
  return new JsonStore<InstanceRecord | null>(path.join(stateDir, 'instance.json'), () => null, normalize);
}
