import { describe, expect, it } from 'vitest';
import { bootstrapPlan } from '../../src/main/provisioning';
import { providers } from '../../src/main/providers';
import type { Provider } from '../../src/main/providers/types';

function providerStub(container: Partial<Provider['container']>): Provider {
  return { container } as Provider;
}

describe('bootstrapPlan', () => {
  it('produces the check-then-install chains for the real registry', () => {
    const [cli, sdk] = bootstrapPlan(providers);
    expect(cli).toBe(
      'command -v claude >/dev/null 2>&1 && command -v codex >/dev/null 2>&1' +
        ' || npm install -g @anthropic-ai/claude-code @openai/codex',
    );
    expect(sdk).toBe(
      '[ -d /opt/puck/node_modules/@anthropic-ai/claude-agent-sdk ]' +
        ' && [ -d /opt/puck/node_modules/@openai/codex-sdk ]' +
        ' || npm install --prefix /opt/puck @anthropic-ai/claude-agent-sdk @openai/codex-sdk',
    );
  });

  it('stays valid shell for a CLI-less (API-key-only) provider', () => {
    const plan = bootstrapPlan([
      providerStub({ cliBin: '', cliPackages: [], sdkPackages: ['@x/sdk'], forwardedEnvKeys: [], containerEnv: {} }),
    ]);
    // No CLI script at all — never a dangling `|| npm install -g `.
    expect(plan).toHaveLength(1);
    expect(plan[0]).toContain('@x/sdk');
    expect(plan[0]).not.toContain('install -g');
  });

  it('produces nothing for an empty registry', () => {
    expect(bootstrapPlan([])).toEqual([]);
  });
});
