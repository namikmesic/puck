import { AgentId, SignOffTracker as ISignOffTracker } from "./types.js";

/**
 * Tracks which agents have signed off from their work.
 * When all agents sign off, triggers a callback for human direction.
 */
export class SignOffTrackerImpl implements ISignOffTracker {
  private signedOffAgents: Set<AgentId> = new Set();
  private allSignedOffCallback: (() => void) | null = null;
  private totalAgentCount: number;

  constructor(totalAgentCount: number) {
    this.totalAgentCount = totalAgentCount;
  }

  signOff(agentId: AgentId): void {
    this.signedOffAgents.add(agentId);
    console.log(
      `[SignOff] ${agentId} signed off (${this.signedOffAgents.size}/${this.totalAgentCount})`
    );

    if (this.signedOffAgents.size === this.totalAgentCount && this.allSignedOffCallback) {
      this.allSignedOffCallback();
    }
  }

  clear(): void {
    this.signedOffAgents.clear();
  }

  allSignedOff(totalAgents: number): boolean {
    return this.signedOffAgents.size >= totalAgents;
  }

  onAllSignedOff(callback: () => void): void {
    this.allSignedOffCallback = callback;
  }

  getSignedOffCount(): number {
    return this.signedOffAgents.size;
  }

  setTotalAgentCount(count: number): void {
    this.totalAgentCount = count;
  }
}
