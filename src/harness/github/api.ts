/**
 * Typed GitHub REST endpoints over the shared transport (http.ts): the
 * user, App installations, repositories, refs, trees, blobs, and pull
 * requests. Only the fields Puck reads are typed.
 */

import { createHttpClient, type HttpClient, type HttpClientOptions } from './http';

export interface GhUser {
  login: string;
  id: number;
}

export interface GhInstallation {
  id: number;
  account: { login: string; type: string } | null;
  html_url: string;
  repository_selection: string;
}

export interface GhRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
}

export interface GhRef {
  name: string;
  commit: { sha: string };
}

export interface GhTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface GhPull {
  number: number;
  html_url: string;
  state: string;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
}

/** Path segments are encoded; refs keep their slashes (branch `feature/x`). */
const seg = (s: string): string => encodeURIComponent(s);
const refPath = (ref: string): string => ref.split('/').map(seg).join('/');
const repoPath = (owner: string, repo: string): string => `/repos/${seg(owner)}/${seg(repo)}`;

export interface GitHubClient {
  http: HttpClient;
  user(): Promise<GhUser>;
  installations(): Promise<GhInstallation[]>;
  installationRepos(installationId: number): Promise<GhRepo[]>;
  repo(owner: string, repo: string): Promise<GhRepo>;
  tags(owner: string, repo: string): Promise<GhRef[]>;
  branches(owner: string, repo: string): Promise<GhRef[]>;
  /** The commit sha a branch, tag, or sha resolves to. */
  commitSha(owner: string, repo: string, ref: string): Promise<string>;
  /** Every entry under a tree; a truncated recursive listing is walked level by level. */
  tree(owner: string, repo: string, sha: string): Promise<GhTreeEntry[]>;
  /** A blob's raw content. */
  blob(owner: string, repo: string, sha: string): Promise<string>;
  pulls(owner: string, repo: string, query?: { head?: string; state?: 'open' | 'closed' | 'all' }): Promise<GhPull[]>;
  createPull(
    owner: string,
    repo: string,
    pr: { title: string; head: string; base: string; body?: string; draft?: boolean },
  ): Promise<GhPull>;
  updatePull(
    owner: string,
    repo: string,
    number: number,
    patch: { title?: string; body?: string; base?: string; state?: 'open' | 'closed' },
  ): Promise<GhPull>;
}

export function createGitHubClient(opts: HttpClientOptions): GitHubClient {
  const http = createHttpClient(opts);
  const get = async <T>(path: string, accept?: string): Promise<T> => (await http.request<T>(path, { accept })).data;

  async function walkTree(owner: string, repo: string, sha: string, prefix: string): Promise<GhTreeEntry[]> {
    const level = await get<{ tree: GhTreeEntry[] }>(`${repoPath(owner, repo)}/git/trees/${seg(sha)}`);
    const out: GhTreeEntry[] = [];
    for (const entry of level.tree ?? []) {
      const full = { ...entry, path: prefix + entry.path };
      out.push(full);
      if (entry.type === 'tree') out.push(...(await walkTree(owner, repo, entry.sha, `${full.path}/`)));
    }
    return out;
  }

  return {
    http,
    user: () => get<GhUser>('/user'),
    installations: () =>
      http.paginate<GhInstallation>('/user/installations', (page) =>
        (page as { installations?: GhInstallation[] } | null)?.installations ?? [],
      ),
    installationRepos: (installationId) =>
      http.paginate<GhRepo>(`/user/installations/${installationId}/repositories`, (page) =>
        (page as { repositories?: GhRepo[] } | null)?.repositories ?? [],
      ),
    repo: (owner, repo) => get<GhRepo>(repoPath(owner, repo)),
    tags: (owner, repo) => http.paginate<GhRef>(`${repoPath(owner, repo)}/tags`),
    branches: (owner, repo) => http.paginate<GhRef>(`${repoPath(owner, repo)}/branches`),
    commitSha: async (owner, repo, ref) =>
      (await get<string>(`${repoPath(owner, repo)}/commits/${refPath(ref)}`, 'application/vnd.github.sha')).trim(),
    tree: async (owner, repo, sha) => {
      const full = await get<{ tree: GhTreeEntry[]; truncated: boolean }>(
        `${repoPath(owner, repo)}/git/trees/${seg(sha)}?recursive=1`,
      );
      return full.truncated ? walkTree(owner, repo, sha, '') : full.tree;
    },
    blob: (owner, repo, sha) =>
      get<string>(`${repoPath(owner, repo)}/git/blobs/${seg(sha)}`, 'application/vnd.github.raw+json'),
    pulls: (owner, repo, query = {}) => {
      const params = new URLSearchParams();
      if (query.head) params.set('head', query.head);
      if (query.state) params.set('state', query.state);
      const qs = params.toString();
      return http.paginate<GhPull>(`${repoPath(owner, repo)}/pulls${qs ? `?${qs}` : ''}`);
    },
    createPull: async (owner, repo, pr) =>
      (await http.request<GhPull>(`${repoPath(owner, repo)}/pulls`, { method: 'POST', body: pr })).data,
    updatePull: async (owner, repo, number, patch) =>
      (await http.request<GhPull>(`${repoPath(owner, repo)}/pulls/${number}`, { method: 'PATCH', body: patch })).data,
  };
}
