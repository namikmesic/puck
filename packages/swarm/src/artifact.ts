import {
  PhaseId,
  AgentId,
  Artifact,
  ArtifactType,
  ArtifactRegistry as IArtifactRegistry,
} from "./types.js";

/**
 * Registry for tracking artifacts produced during workflow.
 * Artifacts are work products like proposals, test plans, and implementations.
 */
export class ArtifactRegistryImpl implements IArtifactRegistry {
  private artifacts: Map<string, Artifact> = new Map();
  private artifactCounter = 0;

  register(artifact: Omit<Artifact, "id" | "timestamp">): Artifact {
    const id = `artifact_${++this.artifactCounter}`;
    const fullArtifact: Artifact = {
      ...artifact,
      id,
      timestamp: Date.now(),
    };

    this.artifacts.set(id, fullArtifact);
    console.log(
      `[Artifact] Registered ${artifact.type} from ${artifact.author} for phase '${artifact.phase}'`
    );

    return fullArtifact;
  }

  get(id: string): Artifact | undefined {
    return this.artifacts.get(id);
  }

  getByPhase(phase: PhaseId): Artifact[] {
    return Array.from(this.artifacts.values()).filter((a) => a.phase === phase);
  }

  getByType(type: ArtifactType): Artifact[] {
    return Array.from(this.artifacts.values()).filter((a) => a.type === type);
  }

  getByAuthor(author: AgentId): Artifact[] {
    return Array.from(this.artifacts.values()).filter((a) => a.author === author);
  }

  getLatest(type: ArtifactType): Artifact | undefined {
    const ofType = this.getByType(type);
    if (ofType.length === 0) return undefined;
    return ofType.reduce((latest, current) =>
      current.timestamp > latest.timestamp ? current : latest
    );
  }

  getAll(): Artifact[] {
    return Array.from(this.artifacts.values());
  }

  reset(): void {
    this.artifacts.clear();
    this.artifactCounter = 0;
  }
}
