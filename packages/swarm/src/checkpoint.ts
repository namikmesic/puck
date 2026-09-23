import {
  PhaseId,
  Checkpoint,
  CheckpointGate as ICheckpointGate,
  AgentRole,
} from "./types.js";

/**
 * Maps phases to their required approver role.
 */
const PHASE_APPROVERS: Record<PhaseId, AgentRole> = {
  proposal: "staff",
  "proposal-review": "staff",
  "test-planning": "staff",
  "test-review": "staff",
  implementation: "staff",
  documentation: "staff",
};

/**
 * Implements checkpoint-based workflow gates.
 * Work cannot proceed to the next phase until the current checkpoint is approved.
 */
export class CheckpointGateImpl implements ICheckpointGate {
  private checkpoints: Map<string, Checkpoint> = new Map();
  private checkpointCounter = 0;
  private phaseApprovals: Map<PhaseId, boolean> = new Map();

  async requestApproval(phase: PhaseId, artifactRef: string): Promise<string> {
    const id = `cp_${++this.checkpointCounter}`;
    const checkpoint: Checkpoint = {
      id,
      phase,
      approver: PHASE_APPROVERS[phase],
      status: "waiting",
      artifactRef,
      timestamp: Date.now(),
    };

    this.checkpoints.set(id, checkpoint);
    console.log(`[Checkpoint] ${id} created for phase '${phase}' (artifact: ${artifactRef})`);

    return id;
  }

  async approve(checkpointId: string, reason?: string): Promise<void> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }

    const updated: Checkpoint = {
      ...checkpoint,
      status: "approved",
      reason,
    };
    this.checkpoints.set(checkpointId, updated);
    this.phaseApprovals.set(checkpoint.phase, true);

    console.log(`[Checkpoint] ${checkpointId} approved for phase '${checkpoint.phase}'`);
  }

  async reject(checkpointId: string, reason: string): Promise<void> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }

    const updated: Checkpoint = {
      ...checkpoint,
      status: "rejected",
      reason,
    };
    this.checkpoints.set(checkpointId, updated);

    console.log(`[Checkpoint] ${checkpointId} rejected: ${reason}`);
  }

  async requestInfo(checkpointId: string, question: string): Promise<void> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }

    const updated: Checkpoint = {
      ...checkpoint,
      status: "needs-info",
      reason: question,
    };
    this.checkpoints.set(checkpointId, updated);

    console.log(`[Checkpoint] ${checkpointId} needs info: ${question}`);
  }

  isPhaseApproved(phase: PhaseId): boolean {
    return this.phaseApprovals.get(phase) ?? false;
  }

  getCheckpoints(): Checkpoint[] {
    return Array.from(this.checkpoints.values());
  }

  getPendingCheckpoints(): Checkpoint[] {
    return this.getCheckpoints().filter((cp) => cp.status === "waiting");
  }

  getCheckpointById(id: string): Checkpoint | undefined {
    return this.checkpoints.get(id);
  }

  reset(): void {
    this.checkpoints.clear();
    this.phaseApprovals.clear();
    this.checkpointCounter = 0;
  }
}
