/**
 * The texts the daemon writes into agent conversations. Kept verbatim and
 * in one place: the worker's first input, the orchestrator preamble that
 * follows the orchestrator agent's own instructions, and the input a
 * requeued item continues with.
 */

import type { DaemonDefinition } from './definition';

export interface WorkerPromptInput {
  number: number;
  title: string;
  body: string;
  github: string;
  cwd: string;
  branch: string;
  base: { branch: string; sha: string };
}

export function workerPrompt(p: WorkerPromptInput): string {
  return `You are working on work item W-${p.number}: ${p.title}

${p.body}

Environment:
- Repository ${p.github}, checked out at ${p.cwd} on branch ${p.branch}, based on ${p.base.branch} at ${p.base.sha.slice(0, 7)}.
- Commit your work to this branch with clear messages. Do not push; Puck publishes the branch.
- Do not switch branches or touch other worktrees under /workspace/.puck/worktrees.
- \`git fetch origin\` updates from Puck's copy of GitHub.

When you are done, end your final message with a short summary of what changed and anything left undone.`;
}

/** The input a requeued item's existing session continues with. */
export function continuePrompt(number: number, reason: string): string {
  return `Your previous attempt was interrupted (${reason}). Continue work item W-${number}. Check \`git status\` and the log before continuing.`;
}

export const RESTART_REASON = 'the environment restarted';

export function orchestratorPreamble(def: DaemonDefinition): string {
  const agents = def.agents
    .map((a) => {
      const description = def.agentDefs[a.agent]?.description || 'no description';
      return `- ${a.agent}: ${description} (up to ${a.maxParallel} at once)`;
    })
    .join('\n');
  const repos = def.repos.map((r) => `- ${r.dir}: ${r.github}, base branch ${r.branch ?? 'the default branch'}`).join('\n');
  const publish = def.policies.publish === 'orchestrator' ? 'yours to do with work_publish' : 'manual (the user publishes)';
  const asks = def.policies.asks === 'orchestrator-first' ? 'to you first' : 'straight to the user';
  return `You are the orchestrator of the Puck environment "${def.name}". You plan work and delegate it to agents; do not edit code yourself unless the user asks you to.

Your tools are on the "puck" server. Work items you assign are queued; Puck starts them in backlog order whenever the assigned agent has a free slot. Each item runs in its own branch and worktree. You receive notices when items finish, fail or ask questions, so never poll.

Agents:
${agents}

Repositories:
${repos}

Policies: publishing is ${publish}; worker questions go ${asks}.

Prefer small, independently verifiable work items. Keep the user informed in one or two sentences per turn.`;
}
