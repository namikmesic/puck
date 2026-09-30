/**
 * delivery/tables.json: every ticket's workflow (rounds and steps, Done
 * tickets included), the facts that outlive a ticket, and the merges
 * observed on GitHub. A checkpoint of the delivery journal like items.json:
 * it holds nothing the journal does not, records `journalSeq`, and is
 * rebuilt from the first journal line when it is missing or unreadable.
 * Later phases add the review, finding and decision tables beside these.
 */

import * as path from 'node:path';
import type { ItemOutcome, MergeObserved, RoundInfo, Step } from '../../harness/daemon-protocol';
import { readJsonFile } from './jsonfile';
import { JsonStore } from './store';

/** What metrics need of a ticket after it is deleted or the event log pruned. */
export interface TicketFacts {
  itemId: string;
  number: number;
  title: string;
  agent: string | null;
  createdBy: 'user' | 'orchestrator' | 'pipeline';
  createdAt: number;
  closedAt: number | null;
  outcome: ItemOutcome | null;
  removed: boolean;
}

/** A ticket's workflow: its rounds and every attempt of every step, in creation order. */
export interface WorkflowRecord {
  id: string;
  itemId: string;
  rounds: RoundInfo[];
  steps: Step[];
  /** 0: unlimited (an environment without delivery). */
  roundsAllowed: number;
  extensions: { by: 'orchestrator' | 'user'; at: number }[];
}

export interface MergeRow extends MergeObserved {
  /** When it was journaled. */
  at: number;
}

export interface TablesFile {
  formatVersion: 1;
  journalSeq: number;
  tickets: Record<string, TicketFacts>;
  /** Keyed by ticket id. */
  workflows: Record<string, WorkflowRecord>;
  /** Keyed by `owner/name#n`, lowercased: one row per pull request. */
  merges: Record<string, MergeRow>;
  /** Set by the format-2 bootstrap's last transaction. */
  bootstrap: { format: 2; tickets: number; at: number } | null;
}

export function mergeKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

export function emptyTables(): TablesFile {
  return {
    formatVersion: 1,
    journalSeq: 0,
    tickets: Object.create(null) as Record<string, TicketFacts>,
    workflows: Object.create(null) as Record<string, WorkflowRecord>,
    merges: Object.create(null) as Record<string, MergeRow>,
    bootstrap: null,
  };
}

function table<T>(raw: unknown): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) if (v && typeof v === 'object') out[k] = v as T;
  return out;
}

function normalize(raw: unknown): TablesFile {
  const file = raw && typeof raw === 'object' ? (raw as Partial<TablesFile>) : {};
  const workflows = table<WorkflowRecord>(file.workflows);
  for (const wf of Object.values(workflows)) {
    wf.rounds = Array.isArray(wf.rounds) ? wf.rounds : [];
    wf.steps = Array.isArray(wf.steps) ? wf.steps : [];
    wf.roundsAllowed = typeof wf.roundsAllowed === 'number' ? wf.roundsAllowed : 0;
    wf.extensions = Array.isArray(wf.extensions) ? wf.extensions : [];
  }
  return {
    formatVersion: 1,
    journalSeq: typeof file.journalSeq === 'number' && file.journalSeq >= 0 ? file.journalSeq : 0,
    tickets: table<TicketFacts>(file.tickets),
    workflows,
    merges: table<MergeRow>(file.merges),
    bootstrap: file.bootstrap && typeof file.bootstrap === 'object' ? file.bootstrap : null,
  };
}

export const TABLES_FILE = path.join('delivery', 'tables.json');

/** The tables; an unreadable file starts empty at journalSeq 0, so boot rebuilds it from the journal. */
export function deliveryStore(stateDir: string): JsonStore<TablesFile> {
  const file = path.join(stateDir, TABLES_FILE);
  let readable = true;
  try {
    readJsonFile<unknown>(file);
  } catch {
    readable = false;
  }
  if (!readable) return new JsonStore(file, emptyTables, () => emptyTables(), { skipRead: true });
  return new JsonStore(file, emptyTables, normalize);
}
