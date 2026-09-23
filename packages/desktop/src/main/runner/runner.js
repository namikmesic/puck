'use strict';
// Puck runner agent - deployed to /opt/puck/runner.js inside the container.

const readline = require('node:readline');

// Wire contract with the host (src/main/runner.ts WIRE) — the sync is
// enforced by test/unit/runner-source.test.ts, which extracts this block.
// RV is the protocol revision the ready handshake reports; bump it whenever
// the turn-request wire format grows so old hosts can detect new runners
// and new hosts can warn about stale ones.
const OP = { turn: 'turn', interrupt: 'interrupt', answer: 'answer' };
const RV = 2;

const CWD = '/workspace';
// Claude Code refuses bypassPermissions as root unless it knows it's sandboxed.
process.env.IS_SANDBOX = '1';

// Environment secrets arrive as a root-only file (never in docker argv or
// container config, where docker inspect would expose them). Applied before
// any SDK loads so agent subprocesses inherit them.
try {
  const secretEnv = JSON.parse(require('node:fs').readFileSync('/opt/puck/secrets.json', 'utf8'));
  for (const key in secretEnv) process.env[key] = String(secretEnv[key]);
} catch (err) { /* no secrets configured */ }

const active = new Map(); // request id -> interrupt fn

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function emit(id, event) {
  send({ id: id, event: event });
}
/** Compiled schema settings (host-side), then the advanced passthrough LAST —
 *  base < settings < advanced. Both are validated host-side; garbage is skipped. */
function applyOverrides(target, req) {
  for (const json of [req.settings, req.advanced]) {
    if (json) {
      try { Object.assign(target, JSON.parse(json)); } catch (err) { /* validated host-side */ }
    }
  }
}
function errText(err) {
  return err && err.message ? String(err.message) : String(err);
}
function memo(load) {
  let p = null;
  return function () { if (!p) p = load(); return p; };
}

// ---------- Mid-turn questions (AskUserQuestion -> UI and back) ----------

let askSeq = 0;
const pendingAsks = new Map(); // askId -> resolve(answers | null)
const asksByReq = new Map(); // request id -> Set<askId>

/** Emits an 'ask' event and waits for the host to send an 'answer' op. */
function askUser(reqId, questions) {
  const askId = reqId + '-ask-' + ++askSeq;
  return new Promise(function (resolve) {
    pendingAsks.set(askId, resolve);
    let ids = asksByReq.get(reqId);
    if (!ids) asksByReq.set(reqId, (ids = new Set()));
    ids.add(askId);
    emit(reqId, {
      kind: 'ask',
      askId: askId,
      questions: (questions || []).map(function (q) {
        return {
          question: String(q.question || ''),
          header: String(q.header || ''),
          multiSelect: q.multiSelect === true,
          options: (q.options || []).map(function (o) {
            return { label: String(o.label || ''), description: String(o.description || '') };
          }),
        };
      }),
    });
  }).finally(function () {
    pendingAsks.delete(askId);
    const ids = asksByReq.get(reqId);
    if (ids) ids.delete(askId);
  });
}

/** Resolve every open question for a request (used on interrupt). */
function cancelAsks(reqId) {
  const ids = asksByReq.get(reqId);
  if (!ids) return;
  for (const askId of ids) {
    const resolve = pendingAsks.get(askId);
    if (resolve) resolve(null);
  }
}

// ---------- Provider table ----------
// Container-side mirror of the host Provider interface. Each entry:
//   loadSdk: () -> Promise<sdk module>   (memoized; only the needed SDK loads)
//   run: (req, sdk, ctx) -> Promise      (provider-specific turn body)
// ctx is the shared turn scaffolding built in runTurn (see below).

const PROVIDERS = {
  'claude-code': {
    loadSdk: memo(function () { return import('@anthropic-ai/claude-agent-sdk'); }),
    run: runClaude,
  },
  codex: {
    loadSdk: memo(function () { return import('@openai/codex-sdk'); }),
    run: runCodex,
  },
};

/**
 * Shared turn lifecycle: turn-start, thinking dedup, eager session reporting,
 * error surfacing, guaranteed turn-end, and the final done message.
 */
async function runTurn(req) {
  const p = PROVIDERS[req.provider];
  if (!p) {
    // A provider this runner predates must fail loudly — falling back to
    // another provider would run the wrong model with the wrong settings.
    throw new Error('This environment\'s runner does not know provider "' + req.provider + '". Restart the environment to update it.');
  }
  const sdk = await p.loadSdk(); // before turn-start: import failures use the dispatch error path
  const started = Date.now();
  const state = { thinking: false, ended: false, session: req.resume || null };
  const ctx = {
    emit: function (event) { emit(req.id, event); },
    thinkingOn: function () {
      if (!state.thinking) { state.thinking = true; emit(req.id, { kind: 'thinking', active: true }); }
    },
    thinkingOff: function () {
      if (state.thinking) { state.thinking = false; emit(req.id, { kind: 'thinking', active: false }); }
    },
    // Report eagerly: the host must know the resume id before turn-end,
    // or a quick follow-up message starts a fresh conversation.
    session: function (id) { state.session = id; send({ id: req.id, session: id }); },
    setSession: function (id) { state.session = id; },
    sessionId: function () { return state.session; },
    endTurn: function (stats) { state.ended = true; emit(req.id, { kind: 'turn-end', stats: stats }); },
    onInterrupt: function (fn) { active.set(req.id, fn); },
    askUser: function (questions) { return askUser(req.id, questions); },
    cancelAsks: function () { cancelAsks(req.id); },
  };

  emit(req.id, { kind: 'turn-start', turnId: req.id });
  try {
    await p.run(req, sdk, ctx);
  } catch (err) {
    emit(req.id, { kind: 'error', message: errText(err) });
  }
  if (!state.ended) {
    ctx.thinkingOff();
    emit(req.id, { kind: 'turn-end', stats: { inputTokens: 0, outputTokens: 0, durationMs: Date.now() - started } });
  }
  send({ id: req.id, done: true, providerSessionId: state.session });
}

// ---------- Claude Code (Agent SDK) ----------

function ccToolSummary(name, input) {
  function str(v) { return typeof v === 'string' ? v : ''; }
  switch (name) {
    case 'Bash': return str(input.command);
    case 'Read':
    case 'Edit':
    case 'Write': return str(input.file_path);
    case 'Glob':
    case 'Grep': return str(input.pattern);
    case 'WebFetch': return str(input.url);
    case 'WebSearch': return str(input.query);
    case 'Task': return str(input.description);
    default: return JSON.stringify(input).slice(0, 80);
  }
}

function ccResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(function (b) { return b && typeof b === 'object' && 'text' in b ? String(b.text) : ''; })
      .join('\n');
  }
  return '';
}

async function runClaude(req, sdk, ctx) {
  const started = Date.now();
  // The Docker container is the safety boundary — run with full tool access.
  // Interactive tools (AskUserQuestion) still route through canUseTool even
  // under bypassPermissions; we forward them to the Puck UI and wait.
  const options = {
    cwd: CWD,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    canUseTool: async function (toolName, input) {
      if (toolName === 'AskUserQuestion') {
        const answers = await ctx.askUser(input.questions);
        if (!answers) {
          return { behavior: 'deny', message: 'The user dismissed the question. Continue with your best judgment.' };
        }
        return { behavior: 'allow', updatedInput: { questions: input.questions, answers: answers } };
      }
      return { behavior: 'allow', updatedInput: input };
    },
  };
  if (req.model && req.model !== 'auto') options.model = req.model;
  if (req.resume) options.resume = req.resume;
  if (req.systemPrompt) {
    options.systemPrompt = { type: 'preset', preset: 'claude_code', append: req.systemPrompt };
  }
  if (req.thinking && req.thinking !== 'auto') options.effort = req.thinking;
  applyOverrides(options, req);

  let sawText = false;
  // AskUserQuestion renders as a question card via the 'ask' event — suppress
  // its raw tool_use/tool_result cards.
  const hiddenToolIds = new Set();
  // Task/Agent calls render as sub-agent cards; their results carry SDK
  // plumbing (agentId hints) that the UI should never show.
  const agentToolIds = new Set();

  const q = sdk.query({ prompt: req.prompt, options: options });
  ctx.onInterrupt(function () {
    ctx.cancelAsks(); // unblock canUseTool so the SDK can wind down
    try { q.interrupt(); } catch (err) { /* best effort */ }
  });
  for await (const msg of q) {
    if (msg.parent_tool_use_id) {
      // Sub-agent activity: mirror nested tool calls into the parent's card.
      const parentId = String(msg.parent_tool_use_id);
      if (msg.type === 'assistant' && msg.message && msg.message.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            ctx.emit({ kind: 'text-delta', text: block.text + '\n\n', parentId: parentId });
            continue;
          }
          if (block.type !== 'tool_use') continue;
          ctx.emit({
            kind: 'tool-start',
            toolId: String(block.id),
            tool: String(block.name),
            summary: ccToolSummary(String(block.name), block.input || {}),
            input: JSON.stringify(block.input || {}, null, 2).slice(0, 2000),
            parentId: parentId,
          });
        }
      } else if (msg.type === 'user' && msg.message && msg.message.content) {
        for (const block of msg.message.content) {
          if (block.type !== 'tool_result') continue;
          ctx.emit({
            kind: 'tool-end',
            toolId: String(block.tool_use_id),
            ok: block.is_error !== true,
            output: ccResultText(block.content).slice(0, 4000) || '(no output)',
          });
        }
      }
      continue;
    }
    if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
      ctx.session(msg.session_id);
    } else if (msg.type === 'stream_event' && msg.event) {
      const ev = msg.event;
      const startedThinking =
        (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'thinking') ||
        (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'thinking_delta');
      if (startedThinking) ctx.thinkingOn();
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) {
        ctx.thinkingOff();
        sawText = true;
        ctx.emit({ kind: 'text-delta', text: ev.delta.text });
      }
    } else if (msg.type === 'assistant' && msg.message && msg.message.content) {
      for (const block of msg.message.content) {
        if (block.type !== 'tool_use') continue;
        ctx.thinkingOff();
        if (block.name === 'AskUserQuestion') {
          hiddenToolIds.add(String(block.id));
          continue;
        }
        const input = block.input || {};
        if (block.name === 'Task' || block.name === 'Agent') {
          agentToolIds.add(String(block.id));
          const kind = typeof input.subagent_type === 'string' ? input.subagent_type : '';
          ctx.emit({
            kind: 'tool-start',
            toolId: String(block.id),
            tool: 'Agent',
            summary:
              (typeof input.description === 'string' ? input.description : 'sub-agent') +
              (kind ? ' - ' + kind : ''),
            input: (typeof input.prompt === 'string' ? input.prompt : '').slice(0, 4000),
            agent: true,
          });
          continue;
        }
        ctx.emit({
          kind: 'tool-start',
          toolId: String(block.id),
          tool: String(block.name),
          summary: ccToolSummary(String(block.name), input),
          input: JSON.stringify(input, null, 2).slice(0, 2000),
        });
      }
    } else if (msg.type === 'user' && msg.message && msg.message.content) {
      for (const block of msg.message.content) {
        if (block.type !== 'tool_result') continue;
        if (hiddenToolIds.has(String(block.tool_use_id))) continue;
        let output = ccResultText(block.content);
        if (agentToolIds.has(String(block.tool_use_id))) {
          // Strip SDK plumbing: <usage>...</usage> metadata blocks and
          // "agentId: ..." resume hints.
          output = output
            .replace(/<usage>[\s\S]*?<\/usage>/g, '')
            .split('\n')
            .filter(function (line) { return !/^agentId:/.test(line.trim()); })
            .join('\n')
            .trim();
        }
        ctx.emit({
          kind: 'tool-end',
          toolId: String(block.tool_use_id),
          ok: block.is_error !== true,
          output: output.slice(0, 4000) || '(no output)',
        });
      }
    } else if (msg.type === 'result') {
      ctx.thinkingOff();
      if (msg.session_id && msg.session_id !== ctx.sessionId()) {
        ctx.session(msg.session_id);
      }
      if (msg.subtype && msg.subtype !== 'success') {
        ctx.emit({
          kind: 'error',
          message: 'Claude Code turn ended early: ' + msg.subtype +
            (msg.result ? ' - ' + String(msg.result).slice(0, 500) : ''),
        });
      } else if (!sawText && msg.result) {
        ctx.emit({ kind: 'text-delta', text: String(msg.result) });
      }
      const usage = msg.usage || {};
      ctx.endTurn({
        inputTokens: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
        outputTokens: usage.output_tokens || 0,
        durationMs: Date.now() - started,
        costUsd: msg.total_cost_usd,
      });
    }
  }
}

// ---------- Codex (Codex SDK) ----------

function cxToolCard(item) {
  switch (item.type) {
    case 'command_execution':
      return { tool: 'Shell', summary: item.command || '', input: item.command || '' };
    case 'file_change': {
      const files = (item.changes || [])
        .map(function (c) { return ((c.kind || 'edit') + ' ' + (c.path || '')).trim(); })
        .join(', ');
      return { tool: 'Edit', summary: files || 'file changes', input: files };
    }
    case 'mcp_tool_call':
      return {
        tool: 'MCP',
        summary: [item.server, item.tool].filter(Boolean).join(' - '),
        input: JSON.stringify(item).slice(0, 1000),
      };
    case 'web_search':
      return { tool: 'WebSearch', summary: item.query || '', input: item.query || '' };
    case 'todo_list': {
      const todos = (item.items || [])
        .map(function (t) { return (t.completed ? '[x] ' : '[ ] ') + (t.text || ''); });
      return {
        tool: 'Plan',
        summary: todos.length + ' step' + (todos.length === 1 ? '' : 's'),
        input: todos.join('\n'),
      };
    }
    // Non-tool items (agent_message, reasoning, error) are handled by the
    // event loop; anything new the SDK adds gets a generic card, not silence.
    case 'agent_message':
    case 'reasoning':
    case 'error':
      return null;
    default:
      return {
        tool: String(item.type || 'unknown'),
        summary: JSON.stringify(item).slice(0, 80),
        input: JSON.stringify(item, null, 2).slice(0, 2000),
      };
  }
}

async function runCodex(req, sdk, ctx) {
  const started = Date.now();
  const config = { sandbox_mode: 'danger-full-access', approval_policy: 'never' };
  if (req.model && req.model !== 'auto') config.model = req.model;
  if (req.thinking && req.thinking !== 'auto') config.model_reasoning_effort = req.thinking;
  // System instructions ride the developer-instructions config channel, so
  // they apply on every turn (resumes included), not just the first message.
  if (req.systemPrompt) config.developer_instructions = req.systemPrompt;
  applyOverrides(config, req);
  const client = new sdk.Codex({ config: config });
  const threadOptions = { workingDirectory: CWD, skipGitRepoCheck: true };
  const thread = req.resume
    ? client.resumeThread(req.resume, threadOptions)
    : client.startThread(threadOptions);

  const aborter = new AbortController();
  const openTools = new Set();
  ctx.onInterrupt(function () { aborter.abort(); });

  try {
    const streamed = await thread.runStreamed(req.prompt, { signal: aborter.signal });
    for await (const ev of streamed.events) {
      if (ev.type === 'thread.started') {
        if (ev.thread_id) ctx.session(ev.thread_id);
      } else if (ev.type === 'item.started' && ev.item) {
        if (ev.item.type === 'reasoning') ctx.thinkingOn();
        const card = cxToolCard(ev.item);
        if (card && ev.item.id) {
          ctx.thinkingOff();
          openTools.add(ev.item.id);
          ctx.emit({ kind: 'tool-start', toolId: ev.item.id, tool: card.tool, summary: card.summary, input: card.input });
        }
      } else if (ev.type === 'item.completed' && ev.item) {
        const item = ev.item;
        if (item.type === 'agent_message' && item.text) {
          ctx.thinkingOff();
          ctx.emit({ kind: 'text-delta', text: item.text });
        } else if (item.type === 'error') {
          ctx.thinkingOff();
          ctx.emit({ kind: 'error', message: item.message || 'Codex reported an error.' });
        } else {
          const card = cxToolCard(item);
          if (card && item.id) {
            if (!openTools.has(item.id)) {
              ctx.thinkingOff();
              ctx.emit({ kind: 'tool-start', toolId: item.id, tool: card.tool, summary: card.summary, input: card.input });
            }
            openTools.delete(item.id);
            ctx.emit({
              kind: 'tool-end',
              toolId: item.id,
              ok: item.status !== 'failed' && (item.exit_code == null || item.exit_code === 0),
              output: (item.aggregated_output || item.text || item.status || '(done)').slice(0, 4000),
            });
          }
        }
      } else if (ev.type === 'turn.completed') {
        ctx.thinkingOff();
        const usage = ev.usage || {};
        ctx.endTurn({
          inputTokens: (usage.input_tokens || 0) + (usage.cached_input_tokens || 0),
          outputTokens: (usage.output_tokens || 0) + (usage.reasoning_output_tokens || 0),
          durationMs: Date.now() - started,
        });
      } else if (ev.type === 'turn.failed' || ev.type === 'error') {
        ctx.thinkingOff();
        ctx.emit({ kind: 'error', message: ev.message || ('Codex ' + ev.type) });
      }
    }
  } catch (err) {
    if (!aborter.signal.aborted) throw err; // user stop ends the turn quietly
  } finally {
    if (thread && thread.id) ctx.setSession(thread.id);
  }
}

// ---------- Dispatch ----------

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function (line) {
  let req;
  try { req = JSON.parse(line); } catch (err) { return; }
  if (req.op === OP.interrupt) {
    const fn = active.get(req.id);
    if (fn) fn();
  } else if (req.op === OP.answer) {
    const resolve = pendingAsks.get(req.askId);
    if (resolve) resolve(req.answers || null);
  } else if (req.op === OP.turn) {
    runTurn(req)
      .catch(function (err) {
        // Failures before/around the turn body (unknown provider, SDK import)
        // must still terminate the stream: turn-end is the protocol's only
        // terminal event, and the host UI waits for it.
        emit(req.id, { kind: 'error', message: errText(err) });
        emit(req.id, { kind: 'turn-end', stats: { inputTokens: 0, outputTokens: 0, durationMs: 0 } });
        send({ id: req.id, done: true, providerSessionId: null });
      })
      .then(function () {
        active.delete(req.id);
        asksByReq.delete(req.id);
      });
  }
});
rl.on('close', function () { process.exit(0); });

send({ ready: true, rv: RV });
