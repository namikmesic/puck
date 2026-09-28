/**
 * Publishing a work item: push its branch to GitHub and open (or update)
 * its pull request.
 *
 *   1. Refuse when the worktree has uncommitted changes or no commits
 *      beyond the base (the message says what to do).
 *   2. As puck: `git bundle create - <base>..<branch>` in the worktree; the
 *      daemon writes stdout to /puck/state/tmp/W-<n>.bundle.
 *   3. As root, hooks off: fetch the branch from the bundle into the mirror.
 *   4. As root: push only that `puck/*` branch, leased on the sha pushed
 *      last time (none the first time), with the owner's installation
 *      token through git-askpass.
 *   5. Find the open pull request for the branch; create it (a draft when
 *      the policy says so) or update its body.
 *
 * An item from a GitHub issue links it in the pull request body:
 * `Closes owner/name#n` when the publish resolves the issue (the default)
 * and the base is the repository's default branch, since GitHub honors
 * closing keywords only there; `Refs owner/name#n` otherwise, saying why
 * merging will not close the issue. Keywords never go in commit messages.
 *
 * Publishing never changes the item's status. The token is the grant the
 * runner supplied for the repository's owner; the daemon never refreshes
 * one, so an expired grant fails with a message and waits for the next.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createGitHubClient, type GitHubDeps } from '../harness/github';
import type { GithubGrant } from '../harness/daemon-protocol';
import type { DaemonDefinition, DaemonRepo } from '../harness/env-definition';
import { type Git, pushable } from './git';
import { itemLabel } from './items';
import type { Logger } from './log';
import type { ItemRecord } from './store/items';

export class PublishError extends Error {}

export interface PublishDeps {
  git: Git;
  /** /puck/state/tmp: root 0700, where bundles are written. */
  tmpDir: string;
  grantFor(owner: string): GithubGrant | null;
  definition(): DaemonDefinition | null;
  envName(): string;
  /** GitHub's REST base (a fake in tests). */
  apiBase?: string;
  fetch?: GitHubDeps['fetch'];
  log: Logger;
  now?: () => number;
}

export interface PublishRequest {
  title?: string;
  body?: string;
  /** For an item from an issue: whether merging resolves it (default true). */
  closesIssue?: boolean;
}

export interface Published {
  pr: NonNullable<ItemRecord['pr']>;
  created: boolean;
  /** The issue link line, for an item from an issue. */
  link?: string;
}

/**
 * The issue link of an item's pull request body. `defaultBranch` is the
 * repository's default branch ('' when unknown, which never closes).
 */
export function issueLink(item: Pick<ItemRecord, 'source' | 'base'>, closesIssue: boolean, defaultBranch: string): string | null {
  const src = item.source;
  if (!src) return null;
  const ref = `${src.repo}#${src.number}`;
  const base = item.base?.branch ?? '';
  if (closesIssue && base && base === defaultBranch) return `Closes ${ref}`;
  if (closesIssue) {
    return `Refs ${ref}\n\nMerging this pull request will not close the issue: it targets \`${base || 'another branch'}\`, not the default branch.`;
  }
  return `Refs ${ref}`;
}

function prBody(item: ItemRecord, envName: string, body: string | undefined, link: string | null): string {
  const parts: string[] = [];
  const summary = body ?? item.result?.summary ?? '';
  if (summary.trim()) parts.push(summary.trim());
  const stat = item.result?.diffStat.text;
  if (stat) parts.push('```\n' + stat + '\n```');
  if (link) parts.push(link);
  parts.push(`Work item ${itemLabel(item)} in Puck environment ${envName}.`);
  return parts.join('\n\n');
}

export class Publisher {
  private readonly now: () => number;

  constructor(private readonly deps: PublishDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** `onPushed` records the pushed sha as soon as GitHub has it (the lease of the next push). */
  async publish(item: ItemRecord, req: PublishRequest = {}, onPushed: (sha: string) => void = () => undefined): Promise<Published> {
    if (item.status !== 'review' && item.status !== 'done') {
      throw new PublishError(`${itemLabel(item)} is ${item.status}; publish it once it is in review.`);
    }
    return this.run(item, req, onPushed);
  }

  private repoOf(item: ItemRecord): DaemonRepo {
    const repo = this.deps.definition()?.repos.find((r) => r.dir === item.repo);
    if (!repo) throw new PublishError(`${itemLabel(item)}'s repository is no longer in this environment.`);
    return repo;
  }

  private grant(repo: DaemonRepo): GithubGrant {
    const owner = repo.github.split('/')[0];
    const grant = this.deps.grantFor(owner);
    if (!grant) throw new PublishError(`This environment has no GitHub access for ${owner} yet; its runner supplies it.`);
    if (grant.expiresAt <= this.now()) {
      throw new PublishError(`The GitHub access for ${owner} expired; publish again once the runner supplies a new token.`);
    }
    if (grant.repos.length && !grant.repos.some((r) => r.toLowerCase() === repo.github.toLowerCase())) {
      throw new PublishError(`The GitHub access for ${owner} does not include ${repo.github}.`);
    }
    return grant;
  }

  private async run(item: ItemRecord, req: PublishRequest, onPushed: (sha: string) => void): Promise<Published> {
    const { git, log } = this.deps;
    const { worktree, branch, base } = item;
    if (!worktree || !branch || !base) throw new PublishError(`${itemLabel(item)} has no branch yet.`);
    if (!pushable(branch)) throw new PublishError(`Refusing to publish ${branch}: only puck/* branches are pushed.`);
    const repo = this.repoOf(item);
    const grant = this.grant(repo);

    fs.mkdirSync(this.deps.tmpDir, { recursive: true, mode: 0o700 });
    const bundle = path.join(this.deps.tmpDir, `W-${item.number}.bundle`);
    const lease = item.pushedSha ?? item.pr?.lastPushedSha ?? null;
    let head: string;
    try {
      head = await git.serial(repo.dir, async () => {
        const state = await git.capture(worktree, base.sha);
        if (state.uncommitted.length) {
          throw new PublishError(
            `${itemLabel(item)} has uncommitted changes (${state.uncommitted.length} file${state.uncommitted.length === 1 ? '' : 's'}); ask its worker to commit or discard them first.`,
          );
        }
        if (state.commits.length === 0) throw new PublishError(`${itemLabel(item)} has no commits beyond ${base.branch}; there is nothing to publish.`);
        await git.bundle(worktree, base.sha, branch, bundle);
        await git.fetchBundle(repo.dir, repo.github, bundle, branch);
        await git.push(repo.dir, repo.github, branch, lease);
        return state.head;
      });
    } finally {
      fs.rmSync(bundle, { force: true });
    }
    onPushed(head);
    log.info('publish.pushed', { itemId: item.id, branch, head });

    const [owner, name] = repo.github.split('/');
    const client = createGitHubClient({
      token: async () => grant.token,
      apiBase: this.deps.apiBase,
      ...(this.deps.fetch ? { deps: { fetch: this.deps.fetch } } : {}),
    });
    let link: string | null = null;
    if (item.source) {
      const defaultBranch = (await client.repo(owner, name)).default_branch ?? '';
      link = issueLink(item, req.closesIssue ?? true, defaultBranch);
    }
    const body = prBody(item, this.deps.envName(), req.body, link);
    const open = await client.pulls(owner, name, { head: `${owner}:${branch}`, state: 'open' });
    const draft = this.deps.definition()?.policies.draftPullRequests !== false;
    let pull;
    let created = false;
    if (open.length === 0) {
      pull = await client.createPull(owner, name, {
        title: req.title ?? `${itemLabel(item)}: ${item.title}`,
        head: branch,
        base: base.branch,
        body,
        draft,
      });
      created = true;
    } else {
      pull = await client.updatePull(owner, name, open[0].number, { body, ...(req.title ? { title: req.title } : {}) });
    }
    log.info('publish.pull-request', { itemId: item.id, number: pull.number, created });
    return {
      pr: { number: pull.number, url: pull.html_url, draft: pull.draft ?? (created ? draft : false), lastPushedSha: head },
      created,
      ...(link ? { link: link.split('\n')[0] } : {}),
    };
  }
}
