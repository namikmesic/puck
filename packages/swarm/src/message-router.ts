import {
  AgentId,
  ChannelId,
  Message,
  Envelope,
  MessageRouter as IMessageRouter,
  ChannelRegistry,
  isChannel,
  getChannelId,
} from "./types.js";
import { MessageStoreImpl } from "./message-store.js";
import { TranscriptWriterImpl } from "./transcript-writer.js";
import { renderMarkdown } from "./markdown-renderer.js";

type WakeupCallback = () => void;

/**
 * Routes messages - determines WHERE messages go.
 * Works with MessageStore for persistence and ChannelRegistry for pub/sub.
 */
export class MessageRouterImpl implements IMessageRouter {
  private messageCounter = 0;
  private wakeups: Map<AgentId, WakeupCallback> = new Map();
  private store: MessageStoreImpl;
  private channelRegistry: ChannelRegistry;
  private transcriptWriter?: TranscriptWriterImpl;

  constructor(
    store: MessageStoreImpl,
    channelRegistry: ChannelRegistry,
    transcriptWriter?: TranscriptWriterImpl
  ) {
    this.store = store;
    this.channelRegistry = channelRegistry;
    this.transcriptWriter = transcriptWriter;
  }

  registerWakeup(agentId: AgentId, callback: WakeupCallback): void {
    this.wakeups.set(agentId, callback);
  }

  unregisterWakeup(agentId: AgentId): void {
    this.wakeups.delete(agentId);
  }

  private notifyAgent(agentId: AgentId): void {
    const wakeup = this.wakeups.get(agentId);
    if (wakeup) wakeup();
  }

  private generateMessageId(): string {
    return `msg_${++this.messageCounter}`;
  }

  routeDirect(from: AgentId, to: AgentId, envelope: Envelope): void {
    const message: Message = {
      id: this.generateMessageId(),
      from,
      to,
      content: envelope.content,
      timestamp: Date.now(),
      replyTo: envelope.replyTo,
    };

    this.store.enqueue(to, message);
    this.transcriptWriter?.recordMessage(message);
    console.log(`\n${"─".repeat(60)}`);
    console.log(`[${from} -> ${to}]`);
    console.log(renderMarkdown(envelope.content));
    console.log(`${"─".repeat(60)}\n`);
    this.notifyAgent(to);
  }

  routeToChannel(from: AgentId, channel: ChannelId, envelope: Envelope): void {
    const channelId = getChannelId(channel);
    const subscribers = this.channelRegistry.getSubscribers(channelId);

    if (subscribers.length === 0) {
      console.warn(
        `[Router] Channel ${channelId} has no subscribers, message dropped. Subscribe first.`
      );
      return;
    }

    const message: Message = {
      id: this.generateMessageId(),
      from,
      to: channelId,
      content: envelope.content,
      timestamp: Date.now(),
      replyTo: envelope.replyTo,
      channel: channelId,
    };

    // Record to transcript once for channel messages
    this.transcriptWriter?.recordMessage(message);

    let deliveredCount = 0;
    for (const subscriberId of subscribers) {
      // Don't deliver to sender
      if (subscriberId === from) continue;

      this.store.enqueue(subscriberId, { ...message, to: subscriberId });
      deliveredCount++;
      this.notifyAgent(subscriberId);
    }

    console.log(`\n${"─".repeat(60)}`);
    console.log(`[${from} -> ${channelId}] (${deliveredCount} recipients)`);
    console.log(renderMarkdown(envelope.content));
    console.log(`${"─".repeat(60)}\n`);
  }

  routeToAll(from: AgentId, envelope: Envelope): void {
    const agentIds = this.store.getAgentIds();
    for (const agentId of agentIds) {
      if (agentId === from) continue;
      this.routeDirect(from, agentId, envelope);
    }
  }

  /**
   * Legacy method for backwards compatibility with existing code.
   * Routes to channel if target starts with #, otherwise direct.
   */
  send(from: AgentId, to: string, content: string, replyTo?: string): Message {
    const envelope: Envelope = { content, replyTo };

    if (isChannel(to)) {
      this.routeToChannel(from, to, envelope);
    } else {
      this.routeDirect(from, to, envelope);
    }

    return {
      id: `msg_${this.messageCounter}`,
      from,
      to,
      content,
      timestamp: Date.now(),
      replyTo,
      channel: isChannel(to) ? getChannelId(to) : undefined,
    };
  }

  /**
   * Legacy method for backwards compatibility.
   */
  broadcast(from: AgentId, content: string, excludeSelf = true): Message[] {
    const messages: Message[] = [];
    const agentIds = this.store.getAgentIds();

    for (const agentId of agentIds) {
      if (excludeSelf && agentId === from) continue;
      messages.push(this.send(from, agentId, content));
    }
    return messages;
  }

  /**
   * Legacy method for backwards compatibility.
   */
  publishToChannel(
    from: AgentId,
    channelName: string,
    content: string,
    replyTo?: string
  ): Message {
    const envelope: Envelope = { content, replyTo };
    this.routeToChannel(from, channelName, envelope);

    const channelId = getChannelId(channelName);
    return {
      id: `msg_${this.messageCounter}`,
      from,
      to: channelId,
      content,
      timestamp: Date.now(),
      replyTo,
      channel: channelId,
    };
  }
}
