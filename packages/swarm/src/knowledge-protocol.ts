import * as fs from "fs";
import * as path from "path";
import { SMERepoConfig } from "./types.js";

/**
 * GIMBAL.md template for repository knowledge persistence.
 */
export const GIMBAL_MD_TEMPLATE = `# GIMBAL.md - {REPO_NAME}

> Auto-generated knowledge base for SME mode. Human approval required for updates.

## Overview

{OVERVIEW_PLACEHOLDER}

## Architecture

{ARCHITECTURE_PLACEHOLDER}

## Key Components

{COMPONENTS_PLACEHOLDER}

## Human-Validated Knowledge

This section contains knowledge that has been validated by a human.

{VALIDATED_KNOWLEDGE_PLACEHOLDER}

## Open Questions

Questions that need human clarification or further investigation.

{OPEN_QUESTIONS_PLACEHOLDER}

## Cross-Repo Dependencies

Dependencies on and from other repositories.

### Depends On
{DEPENDS_ON_PLACEHOLDER}

### Depended By
{DEPENDED_BY_PLACEHOLDER}

---
*Last updated: {TIMESTAMP}*
`;

/**
 * Represents a knowledge update proposal for GIMBAL.md.
 */
export interface KnowledgeUpdateProposal {
  repoName: string;
  section: KnowledgeSection;
  content: string;
  source: string; // Agent ID that proposed this
  timestamp: number;
}

/**
 * Sections in GIMBAL.md that can be updated.
 */
export type KnowledgeSection =
  | "overview"
  | "architecture"
  | "components"
  | "validated-knowledge"
  | "open-questions"
  | "depends-on"
  | "depended-by";

/**
 * Knowledge protocol manager for GIMBAL.md files.
 */
export class KnowledgeProtocol {
  private pendingProposals: Map<string, KnowledgeUpdateProposal[]> = new Map();

  /**
   * Gets the path to GIMBAL.md for a repository.
   */
  getGimbalPath(repoPath: string): string {
    return path.join(repoPath, "GIMBAL.md");
  }

  /**
   * Checks if GIMBAL.md exists for a repository.
   */
  gimbalExists(repoPath: string): boolean {
    return fs.existsSync(this.getGimbalPath(repoPath));
  }

  /**
   * Reads GIMBAL.md content for a repository.
   */
  readGimbal(repoPath: string): string | null {
    const gimbalPath = this.getGimbalPath(repoPath);
    if (!fs.existsSync(gimbalPath)) {
      return null;
    }
    return fs.readFileSync(gimbalPath, "utf-8");
  }

  /**
   * Creates initial GIMBAL.md for a repository.
   */
  initializeGimbal(repo: SMERepoConfig): string {
    const content = GIMBAL_MD_TEMPLATE.replace(/{REPO_NAME}/g, repo.name)
      .replace(/{OVERVIEW_PLACEHOLDER}/g, "_No overview yet. SME will populate during discovery._")
      .replace(
        /{ARCHITECTURE_PLACEHOLDER}/g,
        "_No architecture documented yet. SME will populate during discovery._"
      )
      .replace(
        /{COMPONENTS_PLACEHOLDER}/g,
        "_No components documented yet. SME will populate during discovery._"
      )
      .replace(/{VALIDATED_KNOWLEDGE_PLACEHOLDER}/g, "_No validated knowledge yet._")
      .replace(/{OPEN_QUESTIONS_PLACEHOLDER}/g, "_No open questions yet._")
      .replace(/{DEPENDS_ON_PLACEHOLDER}/g, "_No dependencies documented yet._")
      .replace(/{DEPENDED_BY_PLACEHOLDER}/g, "_No reverse dependencies documented yet._")
      .replace(/{TIMESTAMP}/g, new Date().toISOString());

    return content;
  }

  /**
   * Proposes a knowledge update (requires human approval before writing).
   */
  proposeUpdate(proposal: KnowledgeUpdateProposal): void {
    const key = proposal.repoName;
    if (!this.pendingProposals.has(key)) {
      this.pendingProposals.set(key, []);
    }
    this.pendingProposals.get(key)!.push(proposal);
  }

  /**
   * Gets pending proposals for a repository.
   */
  getPendingProposals(repoName: string): KnowledgeUpdateProposal[] {
    return this.pendingProposals.get(repoName) || [];
  }

  /**
   * Gets all pending proposals across all repositories.
   */
  getAllPendingProposals(): Map<string, KnowledgeUpdateProposal[]> {
    return new Map(this.pendingProposals);
  }

  /**
   * Clears pending proposals for a repository (after approval or rejection).
   */
  clearProposals(repoName: string): void {
    this.pendingProposals.delete(repoName);
  }

  /**
   * Formats a proposal for human review.
   */
  formatProposalForReview(proposal: KnowledgeUpdateProposal): string {
    return `
## Knowledge Update Proposal

**Repository:** ${proposal.repoName}
**Section:** ${proposal.section}
**Proposed by:** ${proposal.source}
**Timestamp:** ${new Date(proposal.timestamp).toISOString()}

### Proposed Content:
${proposal.content}
`.trim();
  }
}

/**
 * Formats knowledge for sharing on #knowledge channel.
 */
export function formatKnowledgeShare(
  repoName: string,
  topic: string,
  content: string,
  source: string
): string {
  return `[KNOWLEDGE: ${repoName}] ${topic}

${content}

Source: ${source}`;
}

/**
 * Parses a knowledge share message.
 */
export function parseKnowledgeShare(
  message: string
): { repoName: string; topic: string; content: string } | null {
  const headerMatch = message.match(/^\[KNOWLEDGE: ([^\]]+)\] (.+)$/m);
  if (!headerMatch) {
    return null;
  }

  const [, repoName, topic] = headerMatch;
  const contentStart = message.indexOf("\n\n");
  const contentEnd = message.lastIndexOf("\n\nSource:");
  if (contentStart === -1) {
    return null;
  }

  const content =
    contentEnd !== -1
      ? message.slice(contentStart + 2, contentEnd)
      : message.slice(contentStart + 2);

  return { repoName, topic, content: content.trim() };
}
