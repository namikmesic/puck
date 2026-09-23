import { OrchestratorImpl } from "./orchestrator.js";
import { ProxyConfig, SMEModeConfig, SMERepoConfig, AgentConfig } from "./types.js";
import { createSMEAgents, createRepoConfig } from "./sme-agent.js";
import { createCoordinatorAgent } from "./sme-coordinator.js";
import { createStaffArchitectAgent } from "./staff-architect.js";
// KnowledgeProtocol available for future use in knowledge management
// import { KnowledgeProtocol } from "./knowledge-protocol.js";
import * as path from "path";

export interface SMEModeOptions {
  repositories: string[]; // Paths to repositories
  coordinatorModel?: "sonnet" | "opus" | "haiku";
  smeModel?: "sonnet" | "opus" | "haiku";
  includeArchitect?: boolean;
  storeTranscripts?: boolean;
}

/**
 * Creates SME mode configuration from options.
 */
function createSMEModeConfig(options: SMEModeOptions): SMEModeConfig {
  const repoConfigs: SMERepoConfig[] = options.repositories.map((repoPath) =>
    createRepoConfig(repoPath)
  );

  return {
    repositories: repoConfigs,
    coordinatorModel: options.coordinatorModel || "opus",
    smeModel: options.smeModel || "sonnet",
    includeArchitect: options.includeArchitect ?? true,
  };
}

/**
 * Creates all agent configurations for SME mode.
 */
function createSMEModeAgents(config: SMEModeConfig): AgentConfig[] {
  const agents: AgentConfig[] = [];

  // Create SME agents for each repository
  const smeAgents = createSMEAgents(config.repositories, config.smeModel);
  agents.push(...smeAgents);

  // Create coordinator agent
  const coordinator = createCoordinatorAgent(config.repositories, config.coordinatorModel);
  agents.push(coordinator);

  // Optionally create Staff Architect agent
  if (config.includeArchitect) {
    const staffArchitect = createStaffArchitectAgent(config.repositories);
    agents.push(staffArchitect);
  }

  return agents;
}

/**
 * Sets up channel subscriptions for SME mode.
 */
function setupSMEChannels(
  orchestrator: OrchestratorImpl,
  config: SMEModeConfig
): void {
  const repos = config.repositories;

  // Subscribe coordinator to all channels
  orchestrator.subscribeAgentToChannel("coordinator", "#questions");
  orchestrator.subscribeAgentToChannel("coordinator", "#knowledge");
  for (const repo of repos) {
    orchestrator.subscribeAgentToChannel("coordinator", `#sme-${repo.name}`);
  }

  // Subscribe each SME to their specific channel and shared channels
  for (const repo of repos) {
    const smeId = `sme-${repo.name}`;
    orchestrator.subscribeAgentToChannel(smeId, `#sme-${repo.name}`);
    orchestrator.subscribeAgentToChannel(smeId, "#questions");
    orchestrator.subscribeAgentToChannel(smeId, "#knowledge");
  }

  // Subscribe Staff Architect if present
  if (config.includeArchitect) {
    orchestrator.subscribeAgentToChannel("staff-architect", "#knowledge");
    orchestrator.subscribeAgentToChannel("staff-architect", "#architect");
    orchestrator.subscribeAgentToChannel("staff-architect", "#questions");
  }
}

/**
 * Runs the discovery phase where SMEs explore their repositories.
 */
async function runDiscoveryPhase(
  orchestrator: OrchestratorImpl,
  config: SMEModeConfig
): Promise<void> {
  console.log("\n=== SME Discovery Phase ===\n");

  // Initialize each SME agent with exploration prompt
  const discoveryPromises = config.repositories.map(async (repo) => {
    const smeId = `sme-${repo.name}`;
    console.log(`[Discovery] Initializing ${smeId}...`);

    const discoveryPrompt = `Welcome! You are the SME for the "${repo.name}" repository at ${repo.path}.

DISCOVERY PHASE - Please explore and understand your repository:

1. ORIENTATION
   - Read README.md if it exists
   - Identify the project type (look for package.json, Cargo.toml, pyproject.toml, go.mod, etc.)
   - Understand the project's purpose

2. STRUCTURE MAPPING
   - Use Glob to find source files
   - Identify main directories (src/, lib/, app/, etc.)
   - Map the high-level structure

3. KEY COMPONENTS
   - Read main entry points
   - Identify core modules/packages
   - Note key abstractions and patterns

4. REPORT SUMMARY
   After exploration, publish a summary to #knowledge with:
   - Project type and purpose
   - Key directories and their roles
   - Main entry points
   - Notable patterns or architectural decisions
   - Any concerns or questions

Begin your exploration now. Subscribe to your channels first, then start reading files.`;

    try {
      const response = await orchestrator.sendInitialPrompt(smeId, discoveryPrompt);
      console.log(`[Discovery] ${smeId} completed initial exploration`);
      return { smeId, success: true, response };
    } catch (error) {
      console.error(`[Discovery] ${smeId} failed:`, (error as Error).message);
      return { smeId, success: false, error };
    }
  });

  // Wait for all SMEs to complete discovery
  const results = await Promise.all(discoveryPromises);

  // Report discovery status
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  console.log(`\n[Discovery] Complete: ${successful} successful, ${failed} failed\n`);

  // Have coordinator synthesize the discoveries
  console.log("[Discovery] Coordinator synthesizing discoveries...\n");
  await orchestrator.sendInitialPrompt(
    "coordinator",
    `The SME Discovery Phase has completed. ${successful} SMEs successfully explored their repositories.

Please:
1. Review the knowledge shared on #knowledge channel
2. Synthesize a brief overview for the human
3. List what repositories are available and their purposes
4. Note any cross-repository dependencies discovered
5. Indicate readiness for Q&A

Present your synthesis clearly and concisely.`
  );
}

/**
 * Main entry point for SME mode.
 */
export async function createSMEMode(options: SMEModeOptions): Promise<void> {
  // Validate repositories
  if (!options.repositories || options.repositories.length === 0) {
    throw new Error("At least one repository path is required for SME mode");
  }

  // Create configuration
  const config = createSMEModeConfig(options);

  console.log("\n=== SME Mode ===\n");
  console.log("Repositories:");
  for (const repo of config.repositories) {
    console.log(`  - ${repo.name}: ${repo.path}`);
  }
  console.log("");

  // Create agents
  const agents = createSMEModeAgents(config);

  // Create proxy config
  // Use first repo's parent as working directory, or current directory
  const workingDirectory = path.dirname(config.repositories[0].path);

  const proxyConfig: ProxyConfig = {
    agents,
    workingDirectory,
    storeTranscripts: options.storeTranscripts,
  };

  // Create orchestrator
  const orchestrator = new OrchestratorImpl(proxyConfig);

  console.log("Agents:", orchestrator.getAgentIds().join(", "));
  console.log("Working directory:", workingDirectory);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down SME mode...");
    orchestrator.stop();
    process.exit(0);
  });

  // Setup channel subscriptions
  setupSMEChannels(orchestrator, config);
  console.log("\nChannels configured for SME mode\n");

  // Run discovery phase
  await runDiscoveryPhase(orchestrator, config);

  // Enter interactive Q&A loop
  console.log("\n=== SME Q&A Mode ===");
  console.log("Type your questions. The coordinator will route them to relevant SMEs.");
  console.log("Special commands:");
  console.log("  /architect <topic> - Request a technical design document");
  console.log("  /status - Show system status");
  console.log("  Ctrl+C - Exit\n");

  // Run the message loop
  await orchestrator.runLoop();
}
