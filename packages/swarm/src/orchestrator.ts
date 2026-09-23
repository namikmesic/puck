import {
  ProxyConfig,
  AgentId,
  ChannelId,
  PhaseId,
  WorkflowState,
  AgentLifecycleState,
  Orchestrator as IOrchestrator,
} from "./types.js";
import { MessageStoreImpl } from "./message-store.js";
import { MessageRouterImpl } from "./message-router.js";
import { ChannelRegistryImpl } from "./channel-registry.js";
import { SignOffTrackerImpl } from "./sign-off-tracker.js";
import { HumanDirectorImpl } from "./human-director.js";
import { AgentLifecycleImpl } from "./agent-lifecycle.js";
import { CheckpointGateImpl } from "./checkpoint.js";
import { TranscriptWriterImpl } from "./transcript-writer.js";

/**
 * Main orchestrator that coordinates all agents and workflow.
 * Implements the Orchestrator interface with SRP components.
 */
export class OrchestratorImpl implements IOrchestrator {
  private config: ProxyConfig;
  private messageStore: MessageStoreImpl;
  private messageRouter: MessageRouterImpl;
  private channelRegistry: ChannelRegistryImpl;
  private signOffTracker: SignOffTrackerImpl;
  private humanDirector: HumanDirectorImpl;
  private checkpointGate: CheckpointGateImpl;
  private transcriptWriter: TranscriptWriterImpl;
  private agents: Map<AgentId, AgentLifecycleImpl> = new Map();
  private agentWakeups: Map<AgentId, { resolve: () => void } | null> = new Map();
  private running = false;
  private paused = false;
  private pauseResolvers: Map<AgentId, () => void> = new Map();
  private currentPhase: PhaseId = "proposal";
  private completedPhases: PhaseId[] = [];

  constructor(config: ProxyConfig) {
    this.config = config;

    // Initialize SRP components
    this.messageStore = new MessageStoreImpl();
    this.channelRegistry = new ChannelRegistryImpl();
    this.transcriptWriter = new TranscriptWriterImpl(
      config.workingDirectory || process.cwd(),
      config.storeTranscripts ?? false
    );
    this.messageRouter = new MessageRouterImpl(
      this.messageStore,
      this.channelRegistry,
      this.transcriptWriter
    );
    const workflowAgentCount = config.agents.filter(
      (agent) => (agent.agentType ?? "workflow") === "workflow"
    ).length;
    this.signOffTracker = new SignOffTrackerImpl(workflowAgentCount);
    this.humanDirector = new HumanDirectorImpl();
    this.checkpointGate = new CheckpointGateImpl();

    // Create agents
    for (const agentConfig of config.agents) {
      const agent = new AgentLifecycleImpl(
        agentConfig,
        this.messageStore,
        this.messageRouter,
        this.channelRegistry,
        config.workingDirectory || process.cwd()
      );
      this.agents.set(agentConfig.id, agent);

      // Register sign-off callback for each agent
      agent.setSignOffCallback((agentId: AgentId) => {
        this.signOffTracker.signOff(agentId);
      });
    }

    // Setup sign-off handler
    this.signOffTracker.onAllSignedOff(() => {
      this.handleAllSignedOff();
    });

    // Setup human direction handler
    this.humanDirector.onDirection((direction: string) => {
      this.handleNewDirection(direction);
    });

    this.humanDirector.onFreshStart(() => {
      this.handleFreshStart();
    });

    this.humanDirector.onStatusRequest(() => {
      this.printStatus();
    });

    this.humanDirector.onPause(() => {
      this.pause();
    });

    this.humanDirector.onResume(() => {
      this.resume();
    });

    console.log(`[Orchestrator] Initialized with ${this.agents.size} agents`);
  }

  private handleAllSignedOff(): void {
    console.log("[Orchestrator] All agents signed off - waiting for direction");
    this.signOffTracker.clear();
    this.paused = true;
    this.humanDirector.promptForFreshStartChoice();
  }

  private handleNewDirection(direction: string): void {
    // Clear any partial sign-offs when new direction is given
    this.signOffTracker.clear();

    // Unpause if paused
    if (this.paused) {
      console.log("[Orchestrator] New direction received - resuming agents");
      this.unpause();
    }

    // Broadcast direction to all agents via #planning channel
    this.publishToChannel(
      "human-director",
      "#planning",
      `[DIRECTION FROM HUMAN OVERSEER]: ${direction}`
    );
  }

  private handleFreshStart(): void {
    console.log("[Orchestrator] Fresh start - resetting all agent contexts");
    for (const agent of this.agents.values()) {
      agent.reset();
    }
    this.checkpointGate.reset();
    this.currentPhase = "proposal";
    this.completedPhases = [];
  }

  private waitForUnpause(agentId: AgentId): Promise<void> {
    return new Promise((resolve) => {
      if (!this.paused) {
        resolve();
        return;
      }
      this.pauseResolvers.set(agentId, resolve);
    });
  }

  private unpause(): void {
    this.paused = false;
    for (const resolver of this.pauseResolvers.values()) {
      resolver();
    }
    this.pauseResolvers.clear();
  }

  async start(): Promise<void> {
    this.running = true;
    for (const agent of this.agents.values()) {
      await agent.start();
    }
  }

  stop(): void {
    this.running = false;
    console.log("[Orchestrator] Stopping...");

    // End transcript session
    this.transcriptWriter.endSession();

    // Stop human director
    this.humanDirector.stopListening();

    // Resolve pause resolvers to allow clean exit
    for (const resolver of this.pauseResolvers.values()) {
      resolver();
    }
    this.pauseResolvers.clear();

    // Wake up all waiting agents so they can exit
    for (const agentId of this.agents.keys()) {
      const pending = this.agentWakeups.get(agentId);
      if (pending) {
        pending.resolve();
      }
      this.messageRouter.unregisterWakeup(agentId);
    }

    // Stop all agents (both workflow and support)
    for (const agent of this.agents.values()) {
      agent.stop();
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.unpause();
  }

  injectMessage(from: string, channel: ChannelId, content: string): void {
    this.messageRouter.publishToChannel(from, channel, content);
  }

  getWorkflowState(): WorkflowState {
    const agentStates: Record<AgentId, AgentLifecycleState> = {};
    for (const [id, agent] of this.agents) {
      agentStates[id] = agent.state;
    }

    return {
      currentPhase: this.currentPhase,
      completedPhases: this.completedPhases,
      pendingCheckpoints: this.checkpointGate.getPendingCheckpoints(),
      agents: agentStates,
      isPaused: this.paused,
    };
  }

  private printStatus(): void {
    const state = this.getWorkflowState();
    console.log(`
Workflow Status:
  Phase: ${state.currentPhase}
  Paused: ${state.isPaused}
  Completed: ${state.completedPhases.join(", ") || "none"}

Agents:`);
    for (const [id, agentState] of Object.entries(state.agents)) {
      console.log(`  ${id}: ${agentState}`);
    }
    console.log(`
Channels:`);
    for (const ch of this.getChannels()) {
      console.log(`  ${ch.name}: ${ch.subscriberCount} subscribers`);
    }
  }

  getAgentIds(): AgentId[] {
    return Array.from(this.agents.keys());
  }

  subscribeAgentToChannel(agentId: AgentId, channel: ChannelId): boolean {
    return this.channelRegistry.subscribe(agentId, channel);
  }

  unsubscribeAgentFromChannel(agentId: AgentId, channel: ChannelId): boolean {
    return this.channelRegistry.unsubscribe(agentId, channel);
  }

  publishToChannel(from: string, channel: ChannelId, content: string): void {
    this.messageRouter.publishToChannel(from, channel, content);
  }

  async sendInitialPrompt(agentId: AgentId, prompt: string): Promise<string> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    return agent.processMessages(prompt);
  }

  private waitForMessages(agentId: AgentId): Promise<void> {
    return new Promise((resolve) => {
      // If already has messages, resolve immediately
      if (this.messageStore.hasPending(agentId)) {
        resolve();
        return;
      }
      // Otherwise wait for wakeup
      this.agentWakeups.set(agentId, { resolve });
    });
  }

  private async runAgentLoop(agentId: AgentId, agent: AgentLifecycleImpl): Promise<void> {
    while (this.running) {
      // Wait if system is paused
      if (this.paused) {
        await this.waitForUnpause(agentId);
        if (!this.running) break;
      }

      await this.waitForMessages(agentId);
      if (!this.running) break;

      if (!agent.isProcessing && agent.hasIncomingMessages()) {
        try {
          const result = await agent.processMessages();
          console.log(`[Orchestrator] ${agentId}: ${result.substring(0, 100)}...`);
        } catch (err) {
          console.error(`[Orchestrator] ${agentId}: error`, (err as Error).message);
        }
      }
    }
  }

  async runLoop(): Promise<void> {
    this.running = true;

    console.log(`[Orchestrator] Starting event-driven loop`);

    // Start transcript session
    this.transcriptWriter.startSession();

    // Register wakeup callbacks
    for (const agentId of this.agents.keys()) {
      this.messageRouter.registerWakeup(agentId, () => {
        const pending = this.agentWakeups.get(agentId);
        if (pending) {
          pending.resolve();
          this.agentWakeups.set(agentId, null);
        }
      });
    }

    // Start human direction input listener
    this.humanDirector.startListening();

    // Run all agent loops concurrently
    const agentLoops = Array.from(this.agents.entries()).map(([id, agent]) =>
      this.runAgentLoop(id, agent)
    );

    await Promise.all(agentLoops);
  }

  // Expose channel info for debugging
  getChannels(): Array<{ name: string; subscriberCount: number }> {
    return this.channelRegistry.getChannels();
  }

  getAgentSubscriptions(agentId: AgentId): ChannelId[] {
    return this.channelRegistry.getSubscriptions(agentId);
  }
}
