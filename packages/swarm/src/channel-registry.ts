import {
  AgentId,
  ChannelId,
  ChannelRegistry as IChannelRegistry,
  getChannelId,
} from "./types.js";

interface Channel {
  name: string;
  subscribers: Set<AgentId>;
  createdAt: number;
}

/**
 * Manages channel subscriptions - tracks who listens to what.
 * Channels are created on first subscription and removed when empty.
 */
export class ChannelRegistryImpl implements IChannelRegistry {
  private channels: Map<ChannelId, Channel> = new Map();

  subscribe(agentId: AgentId, channelName: ChannelId): boolean {
    const channelId = getChannelId(channelName);

    // Create channel if it doesn't exist
    if (!this.channels.has(channelId)) {
      this.channels.set(channelId, {
        name: channelId,
        subscribers: new Set(),
        createdAt: Date.now(),
      });
      console.log(`[Channel] ${channelId} created`);
    }

    const channel = this.channels.get(channelId)!;
    if (channel.subscribers.has(agentId)) {
      return false; // Already subscribed
    }

    channel.subscribers.add(agentId);
    console.log(`[Channel] ${agentId} subscribed to ${channelId}`);
    return true;
  }

  unsubscribe(agentId: AgentId, channelName: ChannelId): boolean {
    const channelId = getChannelId(channelName);
    const channel = this.channels.get(channelId);

    if (!channel || !channel.subscribers.has(agentId)) {
      return false;
    }

    channel.subscribers.delete(agentId);
    console.log(`[Channel] ${agentId} unsubscribed from ${channelId}`);

    // Remove empty channels
    if (channel.subscribers.size === 0) {
      this.channels.delete(channelId);
      console.log(`[Channel] ${channelId} removed (no subscribers)`);
    }

    return true;
  }

  getSubscribers(channel: ChannelId): AgentId[] {
    const channelId = getChannelId(channel);
    const ch = this.channels.get(channelId);
    return ch ? Array.from(ch.subscribers) : [];
  }

  getSubscriptions(agentId: AgentId): ChannelId[] {
    const subscriptions: ChannelId[] = [];
    for (const [channelId, channel] of this.channels) {
      if (channel.subscribers.has(agentId)) {
        subscriptions.push(channelId);
      }
    }
    return subscriptions;
  }

  getChannels(): Array<{ name: string; subscriberCount: number }> {
    return Array.from(this.channels.entries()).map(([name, channel]) => ({
      name,
      subscriberCount: channel.subscribers.size,
    }));
  }
}
