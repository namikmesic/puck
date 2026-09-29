/** A config repo on a fake GitHub, for the config-repo tests and the Docker suite's golden scenario. */

import { createGitHubClient } from '../../src/harness/github';
import { blobSha, type Files } from './definitions-fixtures';
import { fakeGitHub, type Recorded, type Scripted } from './github-fakes';

export interface Commit {
  files: Files;
  /** Tree sizes that differ from the content (to simulate huge files). */
  sizes?: Record<string, number>;
  /** Path → link target. Emitted as a mode 120000 blob whose content is that target. */
  symlinks?: Record<string, string>;
}

/**
 * A fake GitHub serving a config repo: refs, the commits they point at,
 * recursive trees and raw blobs, all built from file maps.
 */
export function fakeConfigRepo(opts: {
  commits: Record<string, Commit>;
  tags?: Record<string, string>;
  branches?: Record<string, string>;
  /** `owner/name`; `acme/config` by default. */
  repo?: string;
}) {
  const API = `https://api.github.com/repos/${opts.repo ?? 'acme/config'}`;
  const tags = opts.tags ?? {};
  const branches = opts.branches ?? {};
  const blobs = new Map<string, string>();
  for (const c of Object.values(opts.commits)) {
    for (const [p, t] of Object.entries(c.files)) blobs.set(blobSha(p + t), t);
    for (const [p, target] of Object.entries(c.symlinks ?? {})) blobs.set(blobSha(p + target), target);
  }

  const handler = (req: Recorded): Scripted => {
    const path = req.url.replace(API, '');
    let m: RegExpExecArray | null;
    if (path === '/tags?per_page=100') {
      return { body: Object.entries(tags).map(([name, sha]) => ({ name, commit: { sha } })) };
    }
    if (path === '/branches?per_page=100') {
      return { body: Object.entries(branches).map(([name, sha]) => ({ name, commit: { sha } })) };
    }
    if ((m = /^\/commits\/(.+)$/.exec(path))) {
      const ref = decodeURIComponent(m[1]);
      const sha = ref.startsWith('tags/')
        ? tags[ref.slice(5)]
        : ref.startsWith('heads/')
          ? branches[ref.slice(6)]
          : Object.keys(opts.commits).find((s) => s.startsWith(ref));
      return sha ? { body: sha } : { status: 404, body: { message: 'No commit found for SHA' } };
    }
    if ((m = /^\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(path))) {
      const c = opts.commits[m[1]];
      if (!c) return { status: 404, body: { message: 'Not Found' } };
      const tree = Object.entries(c.files).map(([p, t]) => ({
        path: p,
        mode: '100644',
        type: 'blob',
        sha: blobSha(p + t),
        size: c.sizes?.[p] ?? Buffer.byteLength(t),
      }));
      for (const [p, target] of Object.entries(c.symlinks ?? {})) {
        tree.push({
          path: p,
          mode: '120000',
          type: 'blob',
          sha: blobSha(p + target),
          size: Buffer.byteLength(target),
        });
      }
      return { body: { tree, truncated: false } };
    }
    if ((m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(path))) {
      const text = blobs.get(m[1]);
      return text === undefined ? { status: 404, body: { message: 'Not Found' } } : { body: text };
    }
    throw new Error(`unexpected request ${req.url}`);
  };
  const gh = fakeGitHub(handler);
  const client = createGitHubClient({ token: async () => 'token', deps: gh.deps });
  /** Pushes a commit with `files` and points `tag` at it, as a release of the config repo would. */
  const tag = (name: string, sha: string, files: Files): void => {
    opts.commits[sha] = { files };
    for (const [p, t] of Object.entries(files)) blobs.set(blobSha(p + t), t);
    tags[name] = sha;
  };
  return { gh, client, tag };
}
