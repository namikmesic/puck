/**
 * A ticket's references: one list in place of protocol 1's `source` and
 * `pr` (`docs/delivery-workflow-spec.md`, 4.6).
 *
 * - At most one `source` (the GitHub issue the ticket came from) and one
 *   `delivery` (the pull request Puck pushes, watches and merges); at most
 *   20 `related`, one `followup-of` and 50 `followup`.
 * - `sourceIssue` and `deliveryPull` are the only reads of the synced
 *   links, so there is no second copy to drift.
 * - A `related` link is display-only: Puck never pushes, polls or merges it.
 * - `source` comes only from an issue import, `delivery` only from a
 *   publish, and the follow-up roles only from the daemon; users and the
 *   orchestrator add and remove `related` links.
 * - Providers turn text into a reference. GitHub (issues and pull requests,
 *   `owner/name#12` or a github.com URL) and plain https URLs ship; another
 *   tracker adds a provider here.
 */

import type { GithubIssueReference, GithubPullReference, Reference, ReferenceRole, WorkItem } from './daemon-protocol';

export const REFERENCE_LIMITS: Readonly<Record<ReferenceRole, number>> = {
  source: 1,
  delivery: 1,
  related: 20,
  'followup-of': 1,
  followup: 50,
};

/** The longest link text a user or the orchestrator may add. */
export const REFERENCE_TEXT_BYTES = 2048;

type WithoutIdRole<T> = T extends unknown ? Omit<T, 'id' | 'role'> : never;
/** A parsed reference, before it has an id and a role. */
export type ParsedReference = WithoutIdRole<Reference>;

export interface ReferenceProvider {
  kinds: readonly string[];
  parse(text: string): ParsedReference | null;
}

const REPO = '[A-Za-z0-9-]+/[A-Za-z0-9._-]+';

export const githubProvider: ReferenceProvider = {
  kinds: ['github-issue', 'github-pr'],
  parse(text) {
    const t = text.trim();
    const url = new RegExp(`^https://github\\.com/(${REPO})/(issues|pull)/(\\d{1,9})(?:[/?#].*)?$`).exec(t);
    if (url) {
      const repo = url[1] as string;
      const number = Number(url[3]);
      if (url[2] === 'pull') {
        return { kind: 'github-pr', repo, number, url: `https://github.com/${repo}/pull/${number}`, draft: false, lastPushedSha: '' };
      }
      return { kind: 'github-issue', repo, number, url: `https://github.com/${repo}/issues/${number}`, updatedAt: 0 };
    }
    const short = new RegExp(`^(${REPO})\\s*#\\s*(\\d{1,9})$`).exec(t);
    if (short) {
      const repo = short[1] as string;
      const number = Number(short[2]);
      return { kind: 'github-issue', repo, number, url: `https://github.com/${repo}/issues/${number}`, updatedAt: 0 };
    }
    return null;
  },
};

export const urlProvider: ReferenceProvider = {
  kinds: ['url'],
  parse(text) {
    const t = text.trim();
    if (!/^https:\/\/\S+$/.test(t)) return null;
    try {
      const parsed = new URL(t);
      if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
    } catch {
      return null;
    }
    return { kind: 'url', url: t, label: null };
  },
};

export const REFERENCE_PROVIDERS: readonly ReferenceProvider[] = [githubProvider, urlProvider];

/** The first provider's reading of the text, or null when none can read it. */
export function parseReference(text: string): ParsedReference | null {
  if (new TextEncoder().encode(text).length > REFERENCE_TEXT_BYTES) return null;
  for (const provider of REFERENCE_PROVIDERS) {
    const parsed = provider.parse(text);
    if (parsed) return parsed;
  }
  return null;
}

type WithRefs = Pick<WorkItem, 'references'>;

/** The GitHub issue the ticket came from. */
export function sourceIssue(item: WithRefs): GithubIssueReference | null {
  return (item.references.find((r) => r.role === 'source' && r.kind === 'github-issue') as GithubIssueReference | undefined) ?? null;
}

/** The pull request Puck publishes, watches and merges for the ticket. */
export function deliveryPull(item: WithRefs): GithubPullReference | null {
  return (item.references.find((r) => r.role === 'delivery' && r.kind === 'github-pr') as GithubPullReference | undefined) ?? null;
}

export function referencesWith(item: WithRefs, role: ReferenceRole): Reference[] {
  return item.references.filter((r) => r.role === role);
}

/** True when the ticket has room for one more reference of this role. */
export function hasRoom(item: WithRefs, role: ReferenceRole): boolean {
  return referencesWith(item, role).length < REFERENCE_LIMITS[role];
}

/** The same link, whatever its id: a repeated `item.link` adds nothing. */
export function sameTarget(a: ParsedReference | Reference, b: ParsedReference | Reference): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === 'github-issue' || a.kind === 'github-pr') && (b.kind === 'github-issue' || b.kind === 'github-pr')) {
    return a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;
  }
  if (a.kind === 'url' && b.kind === 'url') return a.url === b.url;
  if (a.kind === 'ticket' && b.kind === 'ticket') return a.itemId === b.itemId;
  return false;
}

/** A short label for a reference: `owner/name#12`, `W-12`, or the URL. */
export function referenceLabel(ref: Reference | ParsedReference): string {
  switch (ref.kind) {
    case 'github-issue':
    case 'github-pr':
      return `${ref.repo}#${ref.number}`;
    case 'ticket':
      return `W-${ref.number}`;
    case 'url':
      return ref.label ?? ref.url;
  }
}
