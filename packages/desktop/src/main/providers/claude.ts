/** Claude Code's Provider implementation. */

import * as os from 'node:os';
import * as path from 'node:path';
import type { ProviderOption, SettingsMap } from '../../harness/options';
import { activeSettings, compileGeneric } from '../../harness/options';
import type { Provider } from './types';
import { providerAuth, providerCredential } from './oauth';
import * as oauth from './claude-oauth';

/** Built-in tools the editor exposes as per-tool toggles (`tool.<Name>` ids). */
const CLAUDE_TOOLS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'Bash', description: 'Run shell commands in the container' },
  { name: 'Read', description: 'Read files' },
  { name: 'Edit', description: 'Edit existing files' },
  { name: 'Write', description: 'Create and overwrite files' },
  { name: 'Glob', description: 'Find files by name pattern' },
  { name: 'Grep', description: 'Search file contents' },
  { name: 'WebFetch', description: 'Fetch web pages' },
  { name: 'WebSearch', description: 'Search the web' },
  { name: 'NotebookEdit', description: 'Edit Jupyter notebooks' },
  { name: 'TodoWrite', description: 'Maintain a task list during turns' },
  { name: 'Agent', description: 'Delegate work to parallel subagents' },
];

// Verified against @anthropic-ai/claude-agent-sdk 0.3.233 typings (Options,
// PermissionMode, ThinkingConfig). Excluded on purpose: cwd (fixed /workspace
// mount), includePartialMessages (Puck streaming requires it), resume/session
// fields (backend-managed), canUseTool (runner-owned Ask bridge), env
// (environment-level config exists), mcpServers/agents/hooks/skills (future).
const CLAUDE_OPTIONS: readonly ProviderOption[] = [
  {
    kind: 'enum',
    id: 'permissionMode',
    label: 'Permission mode',
    description:
      "How tool calls are approved. Puck auto-answers permission prompts, so 'default' and 'accept edits' behave like bypass; 'plan' is read-only; \"don't ask\" denies anything not allow-listed.",
    group: 'Permissions',
    values: ['bypassPermissions', 'acceptEdits', 'default', 'auto', 'plan', 'dontAsk'],
    labels: ['bypass (full access)', 'accept edits', 'default', 'auto (classifier)', 'plan (read-only)', "don't ask (deny)"],
    default: 'bypassPermissions',
    danger: 'Restrictive modes can block tools mid-turn; the container is already the safety boundary.',
    sdkKey: null, // coupled with allowDangerouslySkipPermissions in compileSettings
  },
  ...CLAUDE_TOOLS.map<ProviderOption>((tool) => ({
    kind: 'boolean',
    id: `tool.${tool.name}`,
    label: tool.name === 'Agent' ? 'Subagents (Agent)' : tool.name,
    description: tool.description,
    group: 'Tools',
    default: true,
    sdkKey: null, // toggled-off tools become disallowedTools in compileSettings
  })),
  {
    kind: 'number',
    id: 'maxTurns',
    label: 'Max turns',
    description: 'Stop after this many agentic turns (default: unlimited).',
    group: 'Limits',
    min: 1,
    max: 200,
    step: 1,
    default: null,
  },
  {
    kind: 'number',
    id: 'maxBudgetUsd',
    label: 'Budget cap (USD)',
    description: 'Stop the turn once API spend reaches this amount (default: uncapped).',
    group: 'Limits',
    min: 0.5,
    max: 100,
    step: 0.5,
    default: null,
  },
  {
    kind: 'enum',
    id: 'thinking',
    label: 'Extended thinking',
    description: "'adaptive' lets the model decide; 'enabled' uses a fixed token budget; 'disabled' turns thinking off.",
    group: 'Identity',
    slot: 'identity',
    values: ['adaptive', 'enabled', 'disabled'],
    default: 'adaptive',
    sdkKey: null, // compiled together with thinkingBudget into the SDK thinking shape
  },
  {
    kind: 'number',
    id: 'thinkingBudget',
    label: 'Thinking budget (tokens)',
    description: 'Fixed thinking token budget (default: SDK default).',
    group: 'Identity',
    slot: 'identity',
    min: 1024,
    max: 131072,
    step: 1024,
    default: null,
    showIf: { optionId: 'thinking', equals: 'enabled' },
    sdkKey: null,
  },
  {
    kind: 'enum',
    id: 'fallbackModel',
    label: 'Fallback model',
    description: 'Model to fall back to when the primary model is overloaded or unavailable.',
    group: 'Identity',
    slot: 'identity',
    values: ['', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    labels: ['none', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    default: '',
  },
  {
    kind: 'string-list',
    id: 'betas',
    label: 'Beta features',
    description: 'Anthropic API beta headers to enable, comma-separated.',
    group: 'Identity',
    slot: 'identity',
    advanced: true,
    default: [],
    placeholder: 'context-1m-2025-08-07',
  },
  {
    kind: 'boolean',
    id: 'agentProgressSummaries',
    label: 'Subagent progress summaries',
    description: 'Emit one-line progress updates while subagents run.',
    group: 'Session',
    advanced: true,
    default: false,
  },
  {
    kind: 'boolean',
    id: 'forwardSubagentText',
    label: 'Forward subagent text',
    description: "Include subagents' text output in the parent transcript.",
    group: 'Session',
    advanced: true,
    default: false,
  },
  {
    kind: 'boolean',
    id: 'enableFileCheckpointing',
    label: 'File checkpointing',
    description: 'Back up files before edits so sessions can be rewound.',
    group: 'Session',
    advanced: true,
    default: false,
  },
];

export const claudeProvider: Provider = {
  id: 'claude-code',
  label: 'Claude Code',
  models: ['auto', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  thinkingLevels: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
  systemPromptHint: 'appended to the harness system prompt',
  configOptions: CLAUDE_OPTIONS,
  compileSettings: (settings: SettingsMap): SettingsMap => {
    const out = compileGeneric(CLAUDE_OPTIONS, settings);
    const active = activeSettings(CLAUDE_OPTIONS, settings);
    if (typeof active.permissionMode === 'string') {
      out.permissionMode = active.permissionMode;
      // The SDK requires the explicit opt-in alongside bypassPermissions; the
      // runner base sets both, so a non-bypass override must clear the flag.
      out.allowDangerouslySkipPermissions = active.permissionMode === 'bypassPermissions';
    }
    const off = CLAUDE_TOOLS.filter((tool) => active[`tool.${tool.name}`] === false)
      .flatMap((tool) => (tool.name === 'Agent' ? ['Agent', 'Task'] : [tool.name]));
    if (off.length) out.disallowedTools = off;
    if (active.thinking === 'disabled') {
      out.thinking = { type: 'disabled' };
    } else if (active.thinking === 'enabled') {
      out.thinking =
        typeof active.thinkingBudget === 'number'
          ? { type: 'enabled', budgetTokens: active.thinkingBudget }
          : { type: 'enabled' };
    }
    return out;
  },
  capabilities: {
    supportsAsk: true,
    subAgents: true,
    streamsTokens: true,
    reportsCost: true,
  },

  auth: providerAuth(oauth.account, {
    start: oauth.startLogin,
    signInHint: 'Not connected — sign in with your Claude account',
    connectedDetail: (tokens) =>
      `Connected — token refreshes automatically (expires ${new Date(tokens.expiresAt).toLocaleString()})`,
  }),

  container: {
    cliBin: 'claude',
    cliPackages: ['@anthropic-ai/claude-code'],
    sdkPackages: ['@anthropic-ai/claude-agent-sdk'],
    forwardedEnvKeys: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    // Claude Code refuses --dangerously-skip-permissions as root unless it
    // can tell it's sandboxed; the container is exactly that sandbox.
    containerEnv: { IS_SANDBOX: '1' },
    credential: providerCredential(oauth.account, {
      hostPath: path.join(os.homedir(), '.claude', '.credentials.json'),
      containerPath: '/root/.claude/.credentials.json',
      serialize: oauth.credentialsFileContent,
    }),
  },
};
