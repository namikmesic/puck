import { AgentId, Message, MessageStore as IMessageStore } from "./types.js";

/**
 * Stores messages for agents - handles persistence and retrieval.
 * Each agent has their own queue of pending messages.
 */
export class MessageStoreImpl implements IMessageStore {
  private queues: Map<AgentId, Message[]> = new Map();

  createQueue(agentId: AgentId): void {
    if (!this.queues.has(agentId)) {
      this.queues.set(agentId, []);
    }
  }

  enqueue(agentId: AgentId, message: Message): void {
    const queue = this.queues.get(agentId);
    if (queue) {
      queue.push(message);
    } else {
      console.warn(`[Store] Agent ${agentId} not found, message dropped`);
    }
  }

  dequeue(agentId: AgentId): Message[] {
    const queue = this.queues.get(agentId);
    if (!queue) return [];

    const messages = [...queue];
    queue.length = 0;
    return messages;
  }

  peek(agentId: AgentId): Message[] {
    const queue = this.queues.get(agentId);
    return queue ? [...queue] : [];
  }

  hasPending(agentId: AgentId): boolean {
    const queue = this.queues.get(agentId);
    return queue ? queue.length > 0 : false;
  }

  getAgentIds(): AgentId[] {
    return Array.from(this.queues.keys());
  }
}
