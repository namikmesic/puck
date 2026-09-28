import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Snapshot } from '../../src/harness/daemon-protocol';
import { startEnv, turnEvents, waitReady, type Env } from './helpers';

// Scenario 6: isolation. The fake harness runs its commands exactly the way
// the Claude CLI is launched (uid 10001, allowlisted environment). As that
// user it cannot read the GitHub credential or the daemon's state, and it
// cannot open the control socket.

let env: Env;
let client: Awaited<ReturnType<typeof waitReady>>;

beforeAll(async () => {
  env = await startEnv({
    'github.json': { accessToken: 'ghu_isolationtoken', refreshToken: 'ghr_isolationtoken', expiresAt: 4102444800000, login: 'octo' },
    'secrets.json': { values: { NPM_TOKEN: 'npm-visible-by-design' } },
  });
  client = await waitReady(env.container);
});
afterAll(async () => {
  client?.close();
  await env?.remove();
});

async function asAgent(command: string): Promise<string> {
  const sent = await client.cmd<{ turnId: string }>('chat.send', { text: `!exec ${command}` });
  await client.untilEvent('turn.end', (ev) => ev.turnId === sent.turnId);
  const end = turnEvents(client.events(), sent.turnId).find((e) => e.kind === 'tool-end');
  return (end as { output: string }).output;
}

describe('Docker scenario 6: isolation', () => {
  it('runs agent commands as uid 10001 in the session cwd', async () => {
    const out = await asAgent('id -u; id -g; pwd; echo "HOME=$HOME USER=$USER"');
    expect(out.split('\n').slice(0, 4)).toEqual(['10001', '10001', '/workspace', 'HOME=/puck/home USER=puck']);
  });

  it('cannot read the GitHub credential or list the daemon state', async () => {
    const out = await asAgent('cat /puck/state/secrets/github.json; ls /puck/state');
    expect(out).toContain('Permission denied');
    expect(out).not.toContain('ghu_isolationtoken');
  });

  it('cannot connect to the control socket', async () => {
    const out = await asAgent(
      `node -e 'require("net").connect("/run/puck/puckd.sock").on("connect",()=>{console.log("socket: connected");process.exit(0)}).on("error",e=>{console.log("socket:",e.code);process.exit(0)})'`,
    );
    expect(out).toContain('socket: EACCES');
  });

  it('sees only the allowlisted environment: secrets by design, never the token or PUCK_*', async () => {
    const out = await asAgent('env');
    expect(out).toContain('NPM_TOKEN=npm-visible-by-design');
    expect(out).toContain('NODE_ENV=test');
    expect(out).not.toMatch(/PUCK_/);
    expect(out).not.toContain('ghu_isolationtoken');
  });

  it('cannot escalate: no sudo, no setuid way back to root', async () => {
    const out = await asAgent('command -v sudo || echo "no sudo"; grep NoNewPrivs /proc/self/status');
    expect(out).toContain('no sudo');
    expect(out).toMatch(/NoNewPrivs:\s+1/);
    const snap = await client.cmd<Snapshot>('snapshot.get');
    expect(snap.instance.status).toBe('ready');
  });
});
