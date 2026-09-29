/**
 * github.json: what the GitHub workflow remembers per work item, so a
 * restart neither repeats a notice nor misses one that was not delivered.
 * The status comment's id and last text; the pull request's state and head;
 * which comments and reviews were already seen; feedback kept for
 * `pr_read` (and, marked untrusted, for the user only); CI results and
 * their redacted log tails; and the follow-up counters that stop loops.
 * ETags are not stored: after a restart the first poll of each URL is a
 * full request.
 */

import * as path from 'node:path';
import type { ChecksState, PullChecks } from '../../harness/daemon-protocol';
import { JsonStore } from './store';

export interface Feedback {
  /** `r<id>` review, `c<id>` inline review comment, `i<id>` conversation comment. */
  key: string;
  kind: 'review' | 'inline' | 'comment';
  id: number;
  author: string;
  association: string;
  /** From someone with write access: the only feedback agents ever see. */
  trusted: boolean;
  /** Reviews: APPROVED, CHANGES_REQUESTED, COMMENTED. */
  state?: string;
  path?: string;
  line?: number | null;
  diffHunk?: string;
  body: string;
  url: string;
  at: number;
}

export interface CiWatch {
  sha: string;
  state: ChecksState;
  /** When watching this sha began (nothing reported for long enough settles as neutral). */
  since: number;
  failing: PullChecks['failing'];
  /** Redacted log tails of failed jobs. */
  logs: { name: string; text: string }[];
  /** Failed workflow runs, for ci_rerun. */
  failedRuns: number[];
  /** The sha whose success or failure was reported. Neutral is not reported, so a later check still is. */
  notified: string | null;
  /** ci_rerun request time for this sha, or null when none is outstanding. */
  rerunAt: number | null;
  /** Check names that were failing at `rerunAt`. */
  rerunFailing: string[];
}

export interface ItemSync {
  statusCommentId: number | null;
  statusText: string | null;
  /** Hash of the issue's title and body as the item last took them. */
  issueHash: string | null;
  issueClosedNotified: boolean;
  issueSeen: number[];
  prNumber: number | null;
  prState: 'open' | 'closed' | 'merged' | null;
  headSha: string | null;
  seen: string[];
  feedback: Feedback[];
  reviewRounds: number;
  ci: CiWatch | null;
  ciFixAttempts: number;
}

export interface GithubFile {
  items: Record<string, ItemSync>;
}

export function emptySync(): ItemSync {
  return {
    statusCommentId: null,
    statusText: null,
    issueHash: null,
    issueClosedNotified: false,
    issueSeen: [],
    prNumber: null,
    prState: null,
    headSha: null,
    seen: [],
    feedback: [],
    reviewRounds: 0,
    ci: null,
    ciFixAttempts: 0,
  };
}

const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : []);

function normalizeSync(raw: Partial<ItemSync>): ItemSync {
  const base = emptySync();
  return {
    statusCommentId: typeof raw.statusCommentId === 'number' ? raw.statusCommentId : null,
    statusText: typeof raw.statusText === 'string' ? raw.statusText : null,
    issueHash: typeof raw.issueHash === 'string' ? raw.issueHash : null,
    issueClosedNotified: raw.issueClosedNotified === true,
    issueSeen: nums(raw.issueSeen),
    prNumber: typeof raw.prNumber === 'number' ? raw.prNumber : null,
    prState: raw.prState === 'open' || raw.prState === 'closed' || raw.prState === 'merged' ? raw.prState : null,
    headSha: typeof raw.headSha === 'string' ? raw.headSha : null,
    seen: Array.isArray(raw.seen) ? raw.seen.filter((k): k is string => typeof k === 'string') : [],
    feedback: Array.isArray(raw.feedback) ? raw.feedback.filter((f) => f && typeof f.key === 'string') : [],
    reviewRounds: typeof raw.reviewRounds === 'number' ? raw.reviewRounds : 0,
    ci:
      raw.ci && typeof raw.ci.sha === 'string'
        ? {
            ...raw.ci,
            logs: raw.ci.logs ?? [],
            failedRuns: nums(raw.ci.failedRuns),
            rerunAt: typeof raw.ci.rerunAt === 'number' ? raw.ci.rerunAt : null,
            rerunFailing: strs(raw.ci.rerunFailing),
          }
        : base.ci,
    ciFixAttempts: typeof raw.ciFixAttempts === 'number' ? raw.ciFixAttempts : 0,
  };
}

export function githubStore(stateDir: string): JsonStore<GithubFile> {
  return new JsonStore(
    path.join(stateDir, 'github.json'),
    () => ({ items: Object.create(null) as Record<string, ItemSync> }),
    (raw) => {
      const items = Object.create(null) as Record<string, ItemSync>;
      const src = (raw as Partial<GithubFile>)?.items;
      if (src && typeof src === 'object') {
        for (const [id, value] of Object.entries(src)) if (value && typeof value === 'object') items[id] = normalizeSync(value);
      }
      return { items };
    },
  );
}
