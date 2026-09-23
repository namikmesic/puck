import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as readline from "readline";
import {
  AgentConfig,
  AgentId,
  AgentLifecycleState,
  AgentLifecycle as IAgentLifecycle,
  Message,
  SignOffCallback,
  ChannelRegistry,
} from "./types.js";
import { MessageStoreImpl } from "./message-store.js";
import { MessageRouterImpl } from "./message-router.js";

interface AgentState {
  id: string;
  name: string;
  sessionId?: string;
  isProcessing: boolean;
  lastActivity: number;
  lifecycleState: AgentLifecycleState;
}

/**
 * Manages an individual agent's lifecycle and Claude API interactions.
 */
export class AgentLifecycleImpl implements IAgentLifecycle {
  private config: AgentConfig;
  private agentState: AgentState;
  private messageStore: MessageStoreImpl;
  private messageRouter: MessageRouterImpl;
  private channelRegistry: ChannelRegistry;
  private workingDirectory: string;
  private signOffCallback: SignOffCallback | null = null;

  constructor(
    config: AgentConfig,
    messageStore: MessageStoreImpl,
    messageRouter: MessageRouterImpl,
    channelRegistry: ChannelRegistry,
    workingDirectory: string
  ) {
    this.config = config;
    this.messageStore = messageStore;
    this.messageRouter = messageRouter;
    this.channelRegistry = channelRegistry;
    this.workingDirectory = workingDirectory;
    this.agentState = {
      id: config.id,
      name: config.name,
      isProcessing: false,
      lastActivity: Date.now(),
      lifecycleState: "created",
    };

    messageStore.createQueue(config.id);
  }

  get id(): AgentId {
    return this.config.id;
  }

  get state(): AgentLifecycleState {
    return this.agentState.lifecycleState;
  }

  get isProcessing(): boolean {
    return this.agentState.isProcessing;
  }

  setSignOffCallback(callback: SignOffCallback): void {
    this.signOffCallback = callback;
  }

  async start(): Promise<void> {
    this.agentState.lifecycleState = "starting";
    // Initialization complete
    this.agentState.lifecycleState = "ready";
  }

  async stop(): Promise<void> {
    this.agentState.lifecycleState = "stopped";
    this.agentState.sessionId = undefined;
    console.log(`[${this.config.id}] Agent stopped`);
  }

  async reset(): Promise<void> {
    this.agentState.sessionId = undefined;
    this.agentState.lifecycleState = "ready";
  }

  isReady(): boolean {
    return this.agentState.lifecycleState === "ready";
  }

  hasIncomingMessages(): boolean {
    return this.messageStore.hasPending(this.config.id);
  }

  private getExternalMcpToolPatterns(): string[] {
    if (!this.config.mcpServers) return [];
    return Object.keys(this.config.mcpServers).map(
      (serverName) => `mcp__${serverName}__*`
    );
  }

  private createMessagingServer() {
    const agentId = this.config.id;
    const router = this.messageRouter;
    const store = this.messageStore;
    const channelReg = this.channelRegistry;

    const sendMessageTool = tool(
      "send_message",
      "Send a message to another agent in the network",
      {
        to: z.string().describe("Agent ID to send message to"),
        content: z.string().describe("Message content"),
        reply_to: z.string().optional().describe("Message ID if replying"),
      },
      async ({ to, content, reply_to }) => {
        const msg = router.send(agentId, to, content, reply_to);
        return {
          content: [
            {
              type: "text" as const,
              text: `Message sent to ${to} (id: ${msg.id})`,
            },
          ],
        };
      }
    );

    const broadcastTool = tool(
      "broadcast",
      "Send a message to all agents in the network",
      {
        content: z.string().describe("Message content to broadcast"),
      },
      async ({ content }) => {
        const msgs = router.broadcast(agentId, content);
        return {
          content: [
            {
              type: "text" as const,
              text: `Broadcast sent to ${msgs.length} agents`,
            },
          ],
        };
      }
    );

    const listAgentsTool = tool(
      "list_agents",
      "List all agents in the network",
      {},
      async () => {
        const agents = store.getAgentIds().filter((id) => id !== agentId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Available agents: ${agents.join(", ")}`,
            },
          ],
        };
      }
    );

    const subscribeTool = tool(
      "subscribe",
      "Subscribe to a channel to receive messages published to it. Creates the channel if it doesn't exist.",
      {
        channel: z
          .string()
          .describe(
            "Channel name (with or without # prefix, e.g., 'planning' or '#planning')"
          ),
      },
      async ({ channel }) => {
        const subscribed = channelReg.subscribe(agentId, channel);
        const channelId = channel.startsWith("#") ? channel : `#${channel}`;
        return {
          content: [
            {
              type: "text" as const,
              text: subscribed
                ? `Subscribed to ${channelId}`
                : `Already subscribed to ${channelId}`,
            },
          ],
        };
      }
    );

    const unsubscribeTool = tool(
      "unsubscribe",
      "Unsubscribe from a channel to stop receiving its messages",
      {
        channel: z
          .string()
          .describe("Channel name (with or without # prefix)"),
      },
      async ({ channel }) => {
        const unsubscribed = channelReg.unsubscribe(agentId, channel);
        const channelId = channel.startsWith("#") ? channel : `#${channel}`;
        return {
          content: [
            {
              type: "text" as const,
              text: unsubscribed
                ? `Unsubscribed from ${channelId}`
                : `Was not subscribed to ${channelId}`,
            },
          ],
        };
      }
    );

    const publishTool = tool(
      "publish",
      "Publish a message to a channel. All subscribers (except you) will receive it.",
      {
        channel: z
          .string()
          .describe("Channel name (with or without # prefix)"),
        content: z.string().describe("Message content to publish"),
        reply_to: z.string().optional().describe("Message ID if replying"),
      },
      async ({ channel, content, reply_to }) => {
        const msg = router.publishToChannel(agentId, channel, content, reply_to);
        const channelId = channel.startsWith("#") ? channel : `#${channel}`;
        return {
          content: [
            {
              type: "text" as const,
              text: `Published to ${channelId} (id: ${msg.id})`,
            },
          ],
        };
      }
    );

    const listChannelsTool = tool(
      "list_channels",
      "List all active channels and your subscriptions",
      {},
      async () => {
        const channels = channelReg.getChannels();
        const mySubscriptions = channelReg.getSubscriptions(agentId);

        if (channels.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No active channels. Use subscribe to create and join a channel.",
              },
            ],
          };
        }

        const channelList = channels
          .map((ch) => {
            const subscribed = mySubscriptions.includes(ch.name)
              ? " (subscribed)"
              : "";
            return `${ch.name}: ${ch.subscriberCount} subscribers${subscribed}`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Active channels:\n${channelList}`,
            },
          ],
        };
      }
    );

    const signOffTool = tool(
      "sign_off",
      "Sign off to indicate you have completed your current work and have no further actions to take. Use this when you have finished all tasks assigned to you and are waiting for new direction. When all agents sign off, the human overseer will be prompted to provide feedback (continuing with existing context) or start fresh (resetting all contexts).",
      {},
      async () => {
        if (this.signOffCallback) {
          this.signOffCallback(agentId);
        }
        return {
          content: [
            {
              type: "text" as const,
              text: "You have signed off. The system will notify you when new direction is available.",
            },
          ],
        };
      }
    );

    const baseTools = [
      sendMessageTool,
      broadcastTool,
      listAgentsTool,
      subscribeTool,
      unsubscribeTool,
      publishTool,
      listChannelsTool,
    ];

    const agentType = this.config.agentType ?? "workflow";
    const allTools = agentType === "workflow"
      ? [...baseTools, signOffTool]
      : baseTools;

    return createSdkMcpServer({
      name: `messaging-${agentId}`,
      version: "1.0.0",
      tools: allTools,
    });
  }

  private formatIncomingMessages(messages: Message[]): string {
    if (messages.length === 0) return "";

    const formatted = messages
      .map((m) => {
        if (m.channel) {
          return `[${m.from} in ${m.channel}]: ${m.content}`;
        }
        return `[${m.from}]: ${m.content}`;
      })
      .join("\n\n");

    return `\n--- INCOMING MESSAGES ---\n${formatted}\n--- END MESSAGES ---\n`;
  }

  private truncateInput(input: string, maxLength: number = 500): string {
    if (input.length <= maxLength) {
      return input;
    }
    return input.substring(0, maxLength) + "\n[...truncated]";
  }

  private formatToolInput(toolName: string, input: Record<string, unknown>): string {
    if (toolName === "Bash") {
      const command = input.command as string;
      const description = input.description as string;
      return `Command: ${this.truncateInput(command)}\n${description ? `Description: ${description}` : ""}`;
    } else if (toolName === "Edit") {
      const filePath = input.file_path as string;
      const oldString = input.old_string as string;
      const newString = input.new_string as string;
      return `File: ${filePath}\nOld: ${this.truncateInput(oldString)}\nNew: ${this.truncateInput(newString)}`;
    } else if (toolName === "Write") {
      const filePath = input.file_path as string;
      const content = input.content as string;
      return `File: ${filePath}\nContent: ${this.truncateInput(content)}`;
    } else {
      // Generic formatting for other tools
      const formatted = Object.entries(input)
        .map(([key, value]) => `${key}: ${this.truncateInput(String(value))}`)
        .join("\n");
      return formatted;
    }
  }

  private async promptForPermission(
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      blockedPath?: string;
      decisionReason?: string;
      toolUseID: string;
    }
  ): Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }> {
    // Auto-approve safe operations
    const autoApproveTools = [
      // Messaging tools
      "mcp__messaging__send_message",
      "mcp__messaging__broadcast",
      "mcp__messaging__list_agents",
      "mcp__messaging__subscribe",
      "mcp__messaging__unsubscribe",
      "mcp__messaging__publish",
      "mcp__messaging__list_channels",
      "mcp__messaging__sign_off",
      // Read-only tools
      "Read",
      "Glob",
      "Grep",
    ];

    // Auto-approve external MCP tools (except our messaging tools which are already handled)
    if (toolName.startsWith("mcp__") && !toolName.startsWith("mcp__messaging__")) {
      return { behavior: "allow" };
    }

    // Auto-approve safe tools
    if (autoApproveTools.includes(toolName)) {
      return { behavior: "allow" };
    }

    // For all other tools, prompt for permission
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const formattedInput = this.formatToolInput(toolName, input);

      console.log("\n⚠️  PERMISSION REQUEST");
      console.log(`Tool: ${toolName}`);
      console.log(formattedInput);
      if (options.decisionReason) {
        console.log(`Reason: ${options.decisionReason}`);
      }

      // Handle timeout via AbortSignal
      const timeoutHandler = () => {
        rl.close();
        resolve({
          behavior: "deny",
          message: "Permission request timed out after 60 seconds. Please try again.",
        });
      };

      if (options.signal.aborted) {
        timeoutHandler();
        return;
      }

      options.signal.addEventListener("abort", timeoutHandler);

      rl.question("[A]llow / [D]eny: ", (answer) => {
        rl.close();
        options.signal.removeEventListener("abort", timeoutHandler);

        const normalized = answer.toLowerCase().trim();
        if (["allow", "a", "yes", "y"].includes(normalized)) {
          resolve({ behavior: "allow" });
        } else {
          resolve({
            behavior: "deny",
            message: `User denied permission to use ${toolName}. Please try a different approach or ask the user for clarification.`,
          });
        }
      });
    });
  }

  async processMessages(initialPrompt?: string): Promise<string> {
    if (this.agentState.isProcessing) {
      return "Agent is busy processing";
    }

    this.agentState.isProcessing = true;
    this.agentState.lifecycleState = "processing";
    this.agentState.lastActivity = Date.now();

    try {
      const MAX_RETRIES = 3;
      const delays = [1000, 2000, 4000]; // 1s, 2s, 4s exponential backoff
      let attempt = 0;

      while (attempt < MAX_RETRIES) {
      try {
        // Peek at messages without removing them
        const incomingMessages = this.messageStore.peek(this.config.id);
        const messagesText = this.formatIncomingMessages(incomingMessages);

        let prompt: string;
        if (initialPrompt) {
          prompt = initialPrompt + messagesText;
        } else if (incomingMessages.length > 0) {
          prompt = `You have received messages from other agents:${messagesText}\n\nRespond appropriately using the send_message tool.`;
        } else {
          this.agentState.lifecycleState = "ready";
          return "No messages to process";
        }

        const messagingServer = this.createMessagingServer();

        const systemPrompt = `${this.config.systemPrompt}

You are agent "${this.config.id}" (${this.config.name}) in a multi-agent network.

Available tools for communication:
- send_message: Send a direct message to another agent
- broadcast: Send a message to all agents
- list_agents: See who else is in the network

Channel-based communication (pub/sub):
- subscribe: Join a channel (creates it if needed). Example: subscribe to "#planning"
- unsubscribe: Leave a channel
- publish: Send a message to all channel subscribers
- list_channels: See all active channels and your subscriptions

Workflow control:
- sign_off: Signal that you have completed your current work and are waiting for new direction. Use this when you have no further actions to take. When all agents sign off, the human overseer will provide feedback or request a fresh start.

Channels are useful for topic-based discussions. Use #planning for proposals and discussions,
#implementation for code-related work. Subscribe before publishing.

When you receive messages, read them and respond appropriately.
Be collaborative and helpful to other agents.`;

        let responseText = "";
        let sessionId: string | undefined;

        // Messaging tools available to all agents
        const baseMessagingTools = [
          "mcp__messaging__send_message",
          "mcp__messaging__broadcast",
          "mcp__messaging__list_agents",
          "mcp__messaging__subscribe",
          "mcp__messaging__unsubscribe",
          "mcp__messaging__publish",
          "mcp__messaging__list_channels",
        ];

        const agentType = this.config.agentType ?? "workflow";
        const messagingTools = agentType === "workflow"
          ? [...baseMessagingTools, "mcp__messaging__sign_off"]
          : baseMessagingTools;

        // Code tools from agent config (defaults to empty array if not specified)
        const codeTools = this.config.tools || [];

        // External MCP tool patterns (e.g., "mcp__context7__*")
        const externalMcpToolPatterns = this.getExternalMcpToolPatterns();

        const options: Parameters<typeof query>[0]["options"] = {
          model: this.config.model || "claude-sonnet-4-5-20250514",
          systemPrompt,
          cwd: this.workingDirectory,
          mcpServers: {
            messaging: messagingServer,
            ...(this.config.mcpServers || {}),
          },
          allowedTools: [...messagingTools, ...codeTools, ...externalMcpToolPatterns],
          permissionMode: "default" as const,
          canUseTool: async (toolName, input, permissionOptions) => {
            return this.promptForPermission(toolName, input, permissionOptions);
          },
        };

        if (this.agentState.sessionId) {
          options.resume = this.agentState.sessionId;
        }

        const response = query({
          prompt,
          options,
        });

        for await (const message of response) {
          if (message.type === "system" && message.subtype === "init") {
            sessionId = message.session_id;
          }
          if (message.type === "assistant" && "content" in message) {
            if (typeof message.content === "string") {
              responseText += message.content;
            }
          }
        }

        if (sessionId) {
          this.agentState.sessionId = sessionId;
        }

        // Only remove messages from queue on successful processing
        this.messageStore.dequeue(this.config.id);

        this.agentState.lifecycleState = "ready";
        return responseText || "Processed";
      } catch (error) {
        attempt++;
        console.error(`[${this.config.id}] Error (attempt ${attempt}/${MAX_RETRIES}):`, error);

        const timestamp = new Date().toISOString();

        if (attempt < MAX_RETRIES) {
          // Broadcast retry attempt to #errors channel
          const errorMsg = `[ERROR from ${this.config.id}] ${(error as Error).message} (attempt ${attempt}/${MAX_RETRIES}) at ${timestamp}`;
          this.messageRouter.publishToChannel(this.config.id, "#errors", errorMsg);

          // Wait before retry with exponential backoff
          await new Promise(resolve => setTimeout(resolve, delays[attempt - 1]));
        } else {
          // Final failure after all retries
          this.agentState.lifecycleState = "ready";
          const errorMsg = `[ERROR from ${this.config.id}] FINAL attempt ${attempt}/${MAX_RETRIES} failed: ${(error as Error).message} at ${timestamp}`;
          this.messageRouter.publishToChannel(this.config.id, "#errors", errorMsg);
          throw error;
        }
      }
    }

      // Should never reach here, but satisfy TypeScript
      this.agentState.lifecycleState = "ready";
      return "Max retries exceeded";
    } finally {
      this.agentState.isProcessing = false;
    }
  }
}
