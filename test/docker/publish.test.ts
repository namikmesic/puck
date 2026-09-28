import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Snapshot, WorkItem } from '../../src/harness/daemon-protocol';
import { copyIn, exec, FAKE_GITHUB, must, startEnv, untilSnapshot, waitReady, type Env } from './helpers';

// Scenario 4: publish. A grant arrives the way the runner supplies it
// (`github.put` over attach). Publishing lands the item's branch in the
// bare repository standing in for GitHub and opens a pull request on a
// fake API; a second publish after a follow-up moves the branch with
// force-with-lease and updates the same pull request. A branch changed
// behind Puck's back is not overwritten.

const BARE = '/srv/git/octo/app.git';
let env: Env;
let client: Awaited<ReturnType<typeof waitReady>>;

beforeAll(async () => {
  env = await startEnv({}, { env: { PUCK_TEST_GITHUB_API: 'http://127.0.0.1:8787' } });
  client = await waitReady(env.container);
  await copyIn(env.container, FAKE_GITHUB, '/srv/fake-github.js');
  await must(['exec', '-d', env.container, 'node', '/srv/fake-github.js']);
});
afterAll(async () => {
  client?.close();
  await env?.remove();
});

async function remoteSha(branch: string): Promise<string> {
  return (await exec(env.container, ['git', '-C', BARE, 'rev-parse', `refs/heads/${branch}`])).stdout.trim();
}

/** The publish calls (finding, opening and updating the pull request), without the GitHub workflow's background polls. */
async function githubLog(): Promise<Array<{ method: string; url: string; auth: string | null; body: Record<string, unknown> | null }>> {
  const out = await exec(env.container, ['cat', '/srv/github.log']);
  return out.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.method !== 'GET' || r.url.includes('/pulls?'));
}

const commit = (file: string): string =>
  `!exec printf '${file}\\n' > ${file}.txt && git add ${file}.txt && git commit -qm "Add ${file}" && echo ok`;

describe('Docker scenario 4: publish', () => {
  it('pushes the branch to the bare repo and opens, then updates, the pull request', async () => {
    // The runner's token pump: one installation token for the repository's owner.
    const grant = { owner: 'octo', installationId: 42, repos: ['octo/app'], token: 'ghs_runnersupplied', expiresAt: Date.now() + 3_600_000 };
    await client.cmd('github.put', { grants: [grant] });
    await client.untilEvent('github.auth', (ev) => ev.state === 'ok');

    const created = await client.cmd<WorkItem>('item.create', { title: 'Add docs', body: commit('docs'), agent: 'implementer' });
    const reviewed = (await untilSnapshot(client, (s) => s.items[0]?.status === 'review', 90_000)).items[0];
    const branch = reviewed.branch as string;
    expect(branch).toBe('puck/W-1-add-docs');
    const head1 = reviewed.result?.commits[0].sha as string;

    const first = await client.cmd<{ prUrl: string }>('item.publish', { itemId: created.id });
    expect(first.prUrl).toBe('https://github.com/octo/app/pull/1');
    expect(await remoteSha(branch)).toBe(head1);
    const afterFirst = (await client.cmd<Snapshot>('snapshot.get')).items[0];
    expect(afterFirst.status).toBe('review'); // publishing never changes status
    expect(afterFirst.pr).toMatchObject({ number: 1, url: first.prUrl, draft: true, lastPushedSha: head1 });

    let log = await githubLog();
    expect(log.map((r) => r.method)).toEqual(['GET', 'POST']);
    expect(log.every((r) => r.auth === 'Bearer ghs_runnersupplied')).toBe(true);
    expect(log[1].body).toMatchObject({ title: 'W-1: Add docs', head: branch, base: 'main', draft: true });
    expect(String(log[1].body?.body)).toContain('Work item W-1 in Puck environment Example.');

    // A follow-up adds a commit; the second publish moves the branch and updates the same pull request.
    await client.cmd('chat.send', { sessionId: reviewed.sessionId, text: commit('more') });
    const again = (
      await untilSnapshot(client, (s) => s.items[0]?.status === 'review' && (s.items[0].result?.commits.length ?? 0) === 2, 90_000)
    ).items[0];
    const head2 = again.result?.commits[0].sha as string;
    const second = await client.cmd<{ prUrl: string }>('item.publish', { itemId: created.id });
    expect(second.prUrl).toBe(first.prUrl);
    expect(await remoteSha(branch)).toBe(head2);
    log = await githubLog();
    expect(log.map((r) => r.method)).toEqual(['GET', 'POST', 'GET', 'PATCH']);
    expect(log[3].url).toBe('/repos/octo/app/pulls/1');

    // Someone else moves the branch on "GitHub": the lease refuses to overwrite it.
    await exec(env.container, [
      'sh',
      '-c',
      `set -e; rm -rf /tmp/rogue; git clone -q --branch ${branch} ${BARE} /tmp/rogue; cd /tmp/rogue; ` +
        `git -c user.name=r -c user.email=r@example.com commit -q --allow-empty -m rogue; git push -q origin ${branch}`,
    ]);
    const rogue = await remoteSha(branch);
    await client.cmd('chat.send', { sessionId: reviewed.sessionId, text: commit('third') });
    await untilSnapshot(client, (s) => s.items[0]?.status === 'review' && (s.items[0].result?.commits.length ?? 0) === 3, 90_000);
    await expect(client.cmd('item.publish', { itemId: created.id })).rejects.toThrow(
      /invalid-state: GitHub refused the push of puck\/W-1-add-docs \(stale info\)/,
    );
    expect(await remoteSha(branch)).toBe(rogue);

    // Only puck/* ever reached GitHub; the base branch is untouched.
    const heads = (await exec(env.container, ['git', '-C', BARE, 'for-each-ref', '--format=%(refname)', 'refs/heads'])).stdout.trim().split('\n');
    expect(heads.sort()).toEqual(['refs/heads/main', `refs/heads/${branch}`]);
  });
});
