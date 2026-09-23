export interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  replyTo?: string;
  channel?: string;
}

// Channel helper functions
export function isChannel(target: string): boolean {
  return target.startsWith("#");
}

export function normalizeChannelName(name: string): string {
  // Remove # prefix if present, lowercase, remove spaces
  return name.replace(/^#/, "").toLowerCase().replace(/\s+/g, "-");
}

export function getChannelId(name: string): string {
  return `#${normalizeChannelName(name)}`;
}

// Valid tool names for agent permissions
export type ToolName = "Read" | "Edit" | "Write" | "Bash" | "Glob" | "Grep";

/**
 * Discriminator for agent lifecycle behavior.
 * - "workflow": Participates in workflow phases, can sign off when done
 * - "support": Always-available resource, should never sign off
 */
export type AgentType = "workflow" | "support";

// Configuration for external MCP servers (e.g., Context7 for library documentation)
export interface ExternalMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AgentConfig {
  id: string;
  name: string;
  systemPrompt: string;
  model?: "sonnet" | "opus" | "haiku";
  tools?: ToolName[]; // Optional: code tools this agent can access (defaults to none)
  mcpServers?: Record<string, ExternalMcpServerConfig>; // Optional: external MCP servers for this agent
  agentType?: AgentType; // Optional: lifecycle behavior (defaults to "workflow")
}

export interface AgentState {
  id: string;
  name: string;
  sessionId?: string;
  pendingMessages: Message[];
  isProcessing: boolean;
  lastActivity: number;
}

// ============================================================================
// SME Mode Interfaces
// ============================================================================

/**
 * Configuration for a repository in SME mode.
 */
export interface SMERepoConfig {
  path: string; // Absolute path to repository
  name: string; // Friendly name (e.g., "backend", "frontend")
}

/**
 * Configuration for SME (Subject Matter Expert) mode.
 */
export interface SMEModeConfig {
  repositories: SMERepoConfig[];
  coordinatorModel?: "sonnet" | "opus" | "haiku";
  smeModel?: "sonnet" | "opus" | "haiku";
  includeArchitect?: boolean;
}

export interface ProxyConfig {
  agents: AgentConfig[];
  tickIntervalMs?: number;
  workingDirectory?: string;
  storeTranscripts?: boolean;
}

export type SignOffCallback = (agentId: string) => void;

// ============================================================================
// Type Aliases for Self-Documentation
// ============================================================================

/** Unique identifier for an agent (e.g., "architect", "developer", "staff") */
export type AgentId = string;

/** Role type for agents in the workflow */
export type AgentRole = "architect" | "developer" | "staff" | "knowledge" | "research";

/** Channel identifier (always starts with #, e.g., "#planning") */
export type ChannelId = string;

// ============================================================================
// Workflow Interfaces
// ============================================================================

/**
 * The six workflow phases.
 * Reading top-to-bottom tells you the entire process.
 */
export type PhaseId =
  | "proposal" // Architect identifies problem + solution
  | "proposal-review" // Staff evaluates proposal
  | "test-planning" // Developer designs verification
  | "test-review" // Staff evaluates test plan
  | "implementation" // Developer writes code, runs tests
  | "documentation"; // Staff updates changelog, retrospective

/**
 * Defines a single phase in the workflow.
 * Each phase has an owner, prerequisites, and outputs.
 */
export interface WorkflowPhase {
  readonly id: PhaseId;
  readonly name: string;
  readonly owner: AgentRole;
  readonly requiredPriorPhases: PhaseId[];
  readonly produces: ArtifactType[];
  readonly completionCriteria: string;
}

// ============================================================================
// Checkpoint Interfaces
// ============================================================================

/**
 * Status of a checkpoint approval request.
 */
export type CheckpointStatus =
  | "waiting" // Submitted, awaiting review
  | "approved" // Can proceed to next phase
  | "rejected" // Must revise and resubmit
  | "needs-info"; // Reviewer needs clarification

/**
 * A checkpoint is a point where work must be approved before proceeding.
 */
export interface Checkpoint {
  readonly id: string;
  readonly phase: PhaseId;
  readonly approver: AgentRole;
  readonly status: CheckpointStatus;
  readonly artifactRef: string;
  readonly timestamp: number;
  readonly reason?: string;
}

/**
 * Gate that controls workflow progression through checkpoints.
 */
export interface CheckpointGate {
  requestApproval(phase: PhaseId, artifactRef: string): Promise<string>;
  approve(checkpointId: string, reason?: string): Promise<void>;
  reject(checkpointId: string, reason: string): Promise<void>;
  requestInfo(checkpointId: string, question: string): Promise<void>;
  isPhaseApproved(phase: PhaseId): boolean;
  getCheckpoints(): Checkpoint[];
}

// ============================================================================
// Messaging Interfaces (split from MessageQueue)
// ============================================================================

/**
 * Envelope wraps message content with workflow context.
 */
export interface Envelope {
  readonly content: string;
  readonly replyTo?: string;
  readonly phase?: PhaseId;
  readonly checkpointId?: string;
}

/**
 * Routes messages - determines WHERE messages go.
 */
export interface MessageRouter {
  routeDirect(from: AgentId, to: AgentId, envelope: Envelope): void;
  routeToChannel(from: AgentId, channel: ChannelId, envelope: Envelope): void;
  routeToAll(from: AgentId, envelope: Envelope): void;
}

/**
 * Stores messages - handles persistence and retrieval.
 */
export interface MessageStore {
  enqueue(agentId: AgentId, message: Message): void;
  dequeue(agentId: AgentId): Message[];
  peek(agentId: AgentId): Message[];
  hasPending(agentId: AgentId): boolean;
  createQueue(agentId: AgentId): void;
}

/**
 * Manages channel subscriptions - tracks who listens to what.
 */
export interface ChannelRegistry {
  subscribe(agentId: AgentId, channel: ChannelId): boolean;
  unsubscribe(agentId: AgentId, channel: ChannelId): boolean;
  getSubscribers(channel: ChannelId): AgentId[];
  getSubscriptions(agentId: AgentId): ChannelId[];
  getChannels(): Array<{ name: string; subscriberCount: number }>;
}

// ============================================================================
// Agent Lifecycle Interfaces (split from AgentSession)
// ============================================================================

/**
 * Lifecycle states an agent can be in.
 */
export type AgentLifecycleState =
  | "created" // Instantiated but not started
  | "starting" // Initialization in progress
  | "ready" // Can process messages
  | "processing" // Currently handling request
  | "paused" // Waiting for signal
  | "stopped"; // Shut down

/**
 * Manages an individual agent's lifecycle.
 */
export interface AgentLifecycle {
  readonly id: AgentId;
  readonly state: AgentLifecycleState;
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): Promise<void>;
  isReady(): boolean;
  processMessages(prompt?: string): Promise<string>;
}

// ============================================================================
// Orchestrator Interfaces (split from Gimbal)
// ============================================================================

/**
 * Current state of the workflow system.
 */
export interface WorkflowState {
  readonly currentPhase: PhaseId;
  readonly completedPhases: PhaseId[];
  readonly pendingCheckpoints: Checkpoint[];
  readonly agents: Record<AgentId, AgentLifecycleState>;
  readonly isPaused: boolean;
}

/**
 * Main orchestrator that coordinates all agents and workflow.
 */
export interface Orchestrator {
  start(): Promise<void>;
  stop(): void;
  pause(): void;
  resume(): void;
  injectMessage(from: string, channel: ChannelId, content: string): void;
  getWorkflowState(): WorkflowState;
  getAgentIds(): AgentId[];
  subscribeAgentToChannel(agentId: AgentId, channel: ChannelId): boolean;
  unsubscribeAgentFromChannel(agentId: AgentId, channel: ChannelId): boolean;
  publishToChannel(from: string, channel: ChannelId, content: string): void;
  sendInitialPrompt(agentId: AgentId, prompt: string): Promise<string>;
  runLoop(): Promise<void>;
}

// ============================================================================
// Human Director Interfaces (split from Gimbal)
// ============================================================================

/**
 * Handles human input and direction.
 */
export interface HumanDirector {
  startListening(): void;
  stopListening(): void;
  onDirection(callback: (direction: string) => void): void;
  onFreshStart(callback: () => void): void;
  prompt(message: string): Promise<string>;
}

/**
 * Tracks which agents have signed off.
 */
export interface SignOffTracker {
  signOff(agentId: AgentId): void;
  clear(): void;
  allSignedOff(totalAgents: number): boolean;
  onAllSignedOff(callback: () => void): void;
  getSignedOffCount(): number;
}

// ============================================================================
// Artifact Interfaces
// ============================================================================

/**
 * Types of artifacts produced during workflow.
 */
export type ArtifactType =
  | "proposal" // Problem + solution + criteria
  | "test-plan" // Verification approach
  | "implementation" // Code changes
  | "test-results" // Evidence tests passed
  | "changelog-entry" // Change documentation
  | "retrospective" // Process learnings
  | "knowledge-response" // Codebase insights from knowledge agent
  | "research-report"; // External research findings from research agent

/**
 * An artifact is a work product from a workflow phase.
 */
export interface Artifact {
  readonly id: string;
  readonly type: ArtifactType;
  readonly phase: PhaseId;
  readonly author: AgentId;
  readonly contentRef: string;
  readonly timestamp: number;
}

/**
 * Registry for tracking artifacts produced during workflow.
 */
export interface ArtifactRegistry {
  register(artifact: Omit<Artifact, "id" | "timestamp">): Artifact;
  get(id: string): Artifact | undefined;
  getByPhase(phase: PhaseId): Artifact[];
  getLatest(type: ArtifactType): Artifact | undefined;
}

// ============================================================================
// Workflow Phase Definitions (static data)
// ============================================================================

/**
 * Static definitions of all workflow phases.
 * Reading this top-to-bottom tells you the entire process.
 */
export const WORKFLOW_PHASES: Record<PhaseId, WorkflowPhase> = {
  proposal: {
    id: "proposal",
    name: "Proposal",
    owner: "architect",
    requiredPriorPhases: [],
    produces: ["proposal"],
    completionCriteria: "Problem, solution, and acceptance criteria defined",
  },
  "proposal-review": {
    id: "proposal-review",
    name: "Proposal Review",
    owner: "staff",
    requiredPriorPhases: ["proposal"],
    produces: [],
    completionCriteria: "Staff approves or rejects proposal",
  },
  "test-planning": {
    id: "test-planning",
    name: "Test Planning",
    owner: "developer",
    requiredPriorPhases: ["proposal-review"],
    produces: ["test-plan"],
    completionCriteria: "Test plan covers all acceptance criteria",
  },
  "test-review": {
    id: "test-review",
    name: "Test Plan Review",
    owner: "staff",
    requiredPriorPhases: ["test-planning"],
    produces: [],
    completionCriteria: "Staff approves test plan",
  },
  implementation: {
    id: "implementation",
    name: "Implementation",
    owner: "developer",
    requiredPriorPhases: ["test-review"],
    produces: ["implementation", "test-results"],
    completionCriteria: "Code written and all tests pass",
  },
  documentation: {
    id: "documentation",
    name: "Documentation",
    owner: "staff",
    requiredPriorPhases: ["implementation"],
    produces: ["changelog-entry", "retrospective"],
    completionCriteria: "CHANGELOG updated and retrospective completed",
  },
};
