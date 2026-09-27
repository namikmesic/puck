/**
 * Codex's harness descriptor: pure data shared by the app and the code that
 * runs inside environments. Sign-in, the credential mirror, and the
 * PUCK_CODEX_MODELS picker extension live in the host half
 * (src/main/providers/codex.ts).
 */

import type { ProviderOption } from '../options';
import { compileGeneric } from '../options';
import type { HarnessDescriptor } from './index';

// Verified against codex-cli 0.147.0 / config-schema.json. Ids are config.toml
// keys (dots = nesting), passed straight into `new Codex({ config })`.
// Excluded on purpose: history.persistence (resume needs save-all), cwd and
// profiles/CODEX_HOME (container-managed), model_providers (auth is
// Puck-managed), requirements.toml keys (admin-side).
const CODEX_OPTIONS: readonly ProviderOption[] = [
  {
    kind: 'enum',
    id: 'sandbox_mode',
    label: 'Sandbox',
    description:
      "What Codex may touch: 'read-only' blocks writes, 'workspace' allows writes under /workspace, 'full access' lifts sandboxing (the container is still the boundary).",
    group: 'Sandbox',
    values: ['read-only', 'workspace-write', 'danger-full-access'],
    labels: ['read-only', 'workspace', 'full access'],
    default: 'danger-full-access',
  },
  {
    kind: 'boolean',
    id: 'sandbox_workspace_write.network_access',
    label: 'Network access',
    description: 'Allow network access from inside the workspace sandbox.',
    group: 'Sandbox',
    default: false,
    showIf: { optionId: 'sandbox_mode', equals: 'workspace-write' },
  },
  {
    kind: 'string-list',
    id: 'sandbox_workspace_write.writable_roots',
    label: 'Extra writable roots',
    description: 'Additional absolute paths writable in workspace mode, comma-separated.',
    group: 'Sandbox',
    advanced: true,
    default: [],
    placeholder: '/tmp/scratch, /opt/cache',
    showIf: { optionId: 'sandbox_mode', equals: 'workspace-write' },
  },
  {
    kind: 'enum',
    id: 'approval_policy',
    label: 'Approval policy',
    description: 'When Codex asks before running commands.',
    group: 'Sandbox',
    values: ['never', 'on-request', 'untrusted'],
    labels: ['never (auto-run)', 'on request', 'untrusted commands'],
    default: 'never',
    danger:
      'Puck runs Codex non-interactively — approval requests cannot be answered and may stall the turn.',
  },
  {
    kind: 'enum',
    id: 'web_search',
    label: 'Web search',
    description: "'cached' uses an index of common pages; 'live' searches the live web.",
    group: 'Behavior',
    values: ['disabled', 'cached', 'indexed', 'live'],
    default: 'cached',
  },
  {
    kind: 'enum',
    id: 'model_reasoning_summary',
    label: 'Reasoning summary',
    description: 'How the model summarizes its reasoning in the event stream.',
    group: 'Behavior',
    values: ['auto', 'concise', 'detailed', 'none'],
    default: 'auto',
  },
  {
    kind: 'enum',
    id: 'model_verbosity',
    label: 'Verbosity',
    description: 'Length of the final answers (Responses API models).',
    group: 'Behavior',
    values: ['', 'low', 'medium', 'high'],
    labels: ['default', 'low', 'medium', 'high'],
    default: '',
  },
  {
    kind: 'enum',
    id: 'personality',
    label: 'Personality',
    description: 'Tone of the assistant.',
    group: 'Behavior',
    values: ['', 'none', 'friendly', 'pragmatic'],
    labels: ['default', 'none', 'friendly', 'pragmatic'],
    default: '',
  },
  {
    kind: 'boolean',
    id: 'tools.view_image',
    label: 'View images',
    description: 'Let Codex open image files in the workspace.',
    group: 'Behavior',
    default: true,
  },
  {
    kind: 'boolean',
    id: 'agents.enabled',
    label: 'Subagents',
    description: 'Allow Codex to spawn parallel subagent threads.',
    group: 'Behavior',
    default: true,
  },
  {
    kind: 'boolean',
    id: 'hide_agent_reasoning',
    label: 'Hide reasoning',
    description: 'Suppress reasoning events from the stream (quieter transcripts).',
    group: 'Behavior',
    default: false,
  },
  {
    kind: 'enum',
    id: 'service_tier',
    label: 'Service tier',
    description: 'API processing tier.',
    group: 'Behavior',
    advanced: true,
    values: ['', 'priority', 'flex'],
    labels: ['default', 'priority', 'flex'],
    default: '',
  },
  {
    kind: 'enum',
    id: 'shell_environment_policy.inherit',
    label: 'Shell env inheritance',
    description: 'Environment variables passed to spawned commands.',
    group: 'Behavior',
    advanced: true,
    values: ['all', 'core', 'none'],
    default: 'all',
  },
  {
    kind: 'number',
    id: 'model_context_window',
    label: 'Context window (tokens)',
    description: 'Override the assumed model context window (default: model default).',
    group: 'Limits',
    advanced: true,
    min: 32000,
    max: 1000000,
    step: 1000,
    default: null,
  },
  {
    kind: 'number',
    id: 'tool_output_token_limit',
    label: 'Tool output limit (tokens)',
    description: 'Token budget kept per tool output (default: model-derived).',
    group: 'Limits',
    advanced: true,
    min: 1000,
    max: 100000,
    step: 1000,
    default: null,
  },
];

// Codex's model lineup shifts frequently; "auto" defers to the CLI default.
export const codexHarness: HarnessDescriptor = {
  id: 'codex',
  label: 'Codex',
  models: ['auto'],
  thinkingLevels: ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  systemPromptHint: 'delivered as developer instructions on every turn',
  configOptions: CODEX_OPTIONS,
  compileSettings: (settings) => compileGeneric(CODEX_OPTIONS, settings),
  capabilities: {
    supportsAsk: false,
    // codex exec reports the parent's collab tool calls (spawn_agent,
    // send_input, wait, close_agent) with the child thread id and status,
    // but filters out the child thread itself — cards, no transcript.
    subAgents: true,
    subAgentTranscript: false,
    streamsTokens: false,
    reportsCost: false,
  },
  packages: {
    cliBin: 'codex',
    // Pinned: verified by provisioning after install (see provisioning.ts).
    cli: [{ name: '@openai/codex', version: '0.156.1' }],
    sdk: [{ name: '@openai/codex-sdk', version: '0.156.1' }],
  },
  containerEnv: {},
  credentialPath: '/puck/home/.codex/auth.json',
};
