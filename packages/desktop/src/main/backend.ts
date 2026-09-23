/**
 * Backend routing (main process).
 *
 * Turns run through the ACTIVE AGENT (a named provider configuration) inside
 * the ACTIVE ENVIRONMENT's Docker container via the runner agent. This module
 * tracks per-session resume ids and in-flight turns for interruption.
 */

import type { HarnessEvent } from '../harness/types';
import type { HarnessStatus } from '../harness/bridge';
import * as agents from './agents';
import * as envs from './environments';
import * as runner from './runner';
import * as sessions from './session-registry';
import { requireProvider } from './providers';

/** turnId → routing info. `reqId` differs from `turnId` on a stale-resume
 *  retry so the two attempts can never cross-route runner messages. */
const activeTurns = new Map<string, { envId: string; reqId: string }>();

export async function status(): Promise<HarnessStatus> {
  const agent = agents.active();
  const env = envs.activeEnv();
  const environment = env
    ? { id: env.id, name: env.name, status: await envs.runtimeStatus(env.id) }
    : null;
  return {
    connected: environment?.status === 'running' && !!agent,
    agent: agent
      ? { id: agent.id, name: agent.name, provider: agent.provider, model: agent.model }
      : null,
    environment,
  };
}

export async function* runTurn(
  turnId: string,
  agentId: string,
  prompt: string,
): AsyncGenerator<HarnessEvent, void, undefined> {
  const agent = agents.byId(agentId);
  const env = envs.activeEnv();
  const fail = (message: string): HarnessEvent[] => [
    { kind: 'error', message },
    { kind: 'turn-end', stats: { inputTokens: 0, outputTokens: 0, durationMs: 0 } },
  ];

  if (!agent) {
    yield* fail('This agent no longer exists. Open Settings and create one.');
    return;
  }
  if (!env) {
    yield* fail('No environment configured. Open Settings and create one.');
    return;
  }
  if ((await envs.runtimeStatus(env.id)) !== 'running') {
    yield* fail(`Environment "${env.name}" is not running. Start it from Settings.`);
    return;
  }
  if (activeTurns.has(turnId)) {
    yield* fail(`Duplicate turn id ${turnId}.`);
    return;
  }

  const resume = sessions.resumeIdFor(agent.id, env.id);
  // Compiled at turn time so schema/compile changes apply without re-saving
  // the agent. Sparse: untouched agents compile to '{}'. The agent store
  // only persists registry provider ids, so an unknown one is a real fault.
  const settings = JSON.stringify(requireProvider(agent.provider).compileSettings(agent.options));

  try {
    // Attempt 0 resumes; if the provider reports the id no longer resolves
    // (container rebuilt, transcripts gone) BEFORE producing any content,
    // drop the id and transparently retry once with a fresh session.
    const attempts = resume ? [resume, null] : [null];
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      const reqId = i === 0 ? turnId : `${turnId}-r${i}`;
      activeTurns.set(turnId, { envId: env.id, reqId });
      let stale = false;
      let sawContent = false;
      const events = runner.turn(
        env.id,
        {
          id: reqId,
          provider: agent.provider,
          model: agent.model,
          systemPrompt: agent.systemPrompt,
          thinking: agent.effort, // wire field name is frozen until the next rv bump
          settings,
          advanced: agent.advanced,
          resume: attempt,
          prompt,
        },
        (providerSessionId) => {
          // Never persist a rejected id, and never re-persist the id we
          // merely ATTEMPTED — the runner echoes it on done even when the
          // provider refused to resume it.
          if (stale || providerSessionId === attempt) return;
          sessions.remember(agent.id, env.id, providerSessionId);
        },
      );
      for await (const event of events) {
        if (event.kind === 'text-delta' || event.kind === 'tool-start') sawContent = true;
        if (
          attempt !== null &&
          !sawContent &&
          event.kind === 'error' &&
          sessions.isStaleResumeError(event.message)
        ) {
          stale = true;
          sessions.forget(agent.id, env.id);
          break; // abandon this attempt silently; retry fresh
        }
        yield event;
      }
      if (!stale) return;
    }
  } finally {
    activeTurns.delete(turnId);
  }
}

export function interrupt(turnId: string): void {
  const active = activeTurns.get(turnId);
  if (active) runner.interrupt(active.envId, active.reqId);
}

export function answerAsk(
  turnId: string,
  askId: string,
  answers: Record<string, string> | null,
): void {
  const active = activeTurns.get(turnId);
  if (active) runner.answerAsk(active.envId, active.reqId, askId, answers);
}
