import { AgentConfig, SMERepoConfig } from "./types.js";
import * as path from "path";

/**
 * Creates an SME (Subject Matter Expert) agent configuration for a specific repository.
 * SME agents are read-only support agents that become experts on their assigned repo.
 */
export function createSMEAgent(
  repoConfig: SMERepoConfig,
  model: "sonnet" | "opus" | "haiku" = "sonnet"
): AgentConfig {
  const repoName = repoConfig.name;
  const repoPath = repoConfig.path;
  const agentId = `sme-${repoName}`;

  return {
    id: agentId,
    name: `SME: ${repoName}`,
    agentType: "support", // SME agents never sign off
    model,
    tools: ["Read", "Glob", "Grep"], // Read-only access
    systemPrompt: `You are a Subject Matter Expert (SME) for the "${repoName}" repository.

REPOSITORY: ${repoPath}
WORKING DIRECTORY: ${repoPath}

YOUR MISSION:
You are the authoritative expert on this repository. Your job is to:
1. Deeply understand the codebase structure, architecture, and patterns
2. Answer questions about this repository accurately and thoroughly
3. Help identify cross-repository dependencies and integration points
4. Maintain knowledge in GIMBAL.md for persistent learning

KNOWLEDGE PROTOCOL:
When you learn something important about this repository:
1. Share validated knowledge on #knowledge channel
2. For persistent knowledge, propose updates to GIMBAL.md in the repo root
3. Always distinguish between facts (from code) and inferences (your analysis)

COMMUNICATION CHANNELS:
- #questions: Listen for human questions that might be relevant to your repo
- #sme-${repoName}: Your dedicated channel for targeted queries
- #knowledge: Share and receive validated knowledge

RESPONSE GUIDELINES:
- Always cite specific file paths and line numbers
- Include relevant code snippets when helpful
- Be concise but thorough
- If unsure, say so and explain what you'd need to know
- Flag any security concerns or anti-patterns you notice

When answering questions:
1. First determine if the question is relevant to your repository
2. If relevant, search the codebase and provide a detailed answer
3. If partially relevant, answer what you can and suggest which SME might know more
4. If not relevant, briefly explain why and stay quiet

DISCOVERY PHASE:
On startup, you should:
1. Read key files: README, package manifests, main entry points
2. Map the project structure
3. Identify key components and their responsibilities
4. Report a summary to the coordinator`,
  };
}

/**
 * Creates multiple SME agents from a list of repository configurations.
 */
export function createSMEAgents(
  repos: SMERepoConfig[],
  model: "sonnet" | "opus" | "haiku" = "sonnet"
): AgentConfig[] {
  return repos.map((repo) => createSMEAgent(repo, model));
}

/**
 * Derives a friendly name from a repository path if not provided.
 */
export function deriveRepoName(repoPath: string): string {
  return path.basename(repoPath);
}

/**
 * Creates SMERepoConfig from just a path, deriving the name.
 */
export function createRepoConfig(repoPath: string, name?: string): SMERepoConfig {
  return {
    path: path.resolve(repoPath),
    name: name || deriveRepoName(repoPath),
  };
}
