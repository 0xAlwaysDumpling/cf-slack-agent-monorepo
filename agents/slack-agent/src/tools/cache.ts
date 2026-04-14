/**
 * Event-based cache for MCP tools and prompts.
 * Invalidation happens on events, not TTL.
 */

import type { CacheEvent, CacheEventHandler } from "./types";

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class EventBasedCache {
  private cache: Map<string, CacheEntry<unknown>> = new Map();
  private subscribers: Map<CacheEvent, Set<CacheEventHandler>> = new Map();

  constructor() {
    // Initialize event subscribers
    const events: CacheEvent[] = ["tool:updated", "tool:deleted", "prompt:updated", "discovery:changed"];
    for (const event of events) {
      this.subscribers.set(event, new Set());
    }
  }

  /**
   * Subscribe to cache events.
   */
  subscribe(event: CacheEvent, handler: CacheEventHandler): () => void {
    const handlers = this.subscribers.get(event);
    if (!handlers) return () => {};

    handlers.add(handler);

    // Return unsubscribe function
    return () => {
      handlers.delete(handler);
    };
  }

  /**
   * Emit a cache event to all subscribers.
   */
  private async emit(event: CacheEvent, key: string): Promise<void> {
    const handlers = this.subscribers.get(event);
    if (!handlers) return;

    const promises = Array.from(handlers).map((handler) => Promise.resolve(handler(event, key)).catch((err) => {
      console.error(`Error in cache event handler for ${event}:`, err);
    }));

    await Promise.all(promises);
  }

  /**
   * Set a value in cache.
   */
  set<T>(key: string, data: T): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Get a value from cache.
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    return entry?.data ?? null;
  }

  /**
   * Check if key exists in cache.
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Invalidate cache for a tool (emits event).
   */
  async invalidateTool(toolName: string): Promise<void> {
    this.cache.delete(toolName);
    this.cache.delete(`tool:${toolName}`);
    await this.emit("tool:updated", toolName);
  }

  /**
   * Delete a tool from cache (emits event).
   */
  async deleteTool(toolName: string): Promise<void> {
    this.cache.delete(toolName);
    this.cache.delete(`tool:${toolName}`);
    await this.emit("tool:deleted", toolName);
  }

  /**
   * Invalidate cache for a prompt (emits event).
   */
  async invalidatePrompt(promptKey: string): Promise<void> {
    this.cache.delete(promptKey);
    this.cache.delete(`prompt:${promptKey}`);
    await this.emit("prompt:updated", promptKey);
  }

  /**
   * Invalidate discovery graph (emits event).
   */
  async invalidateDiscovery(): Promise<void> {
    this.cache.delete("discovery-graph");
    await this.emit("discovery:changed", "discovery-graph");
  }

  /**
   * Clear all cache and emit discovery change event.
   */
  async clear(): Promise<void> {
    this.cache.clear();
    await this.emit("discovery:changed", "all");
  }

  /**
   * Get cache statistics.
   */
  getStats(): {
    size: number;
    keys: string[];
    oldestEntry?: number;
    newestEntry?: number;
  } {
    const keys = Array.from(this.cache.keys());
    let oldestEntry: number | undefined;
    let newestEntry: number | undefined;

    if (this.cache.size > 0) {
      oldestEntry = Math.min(...Array.from(this.cache.values()).map((e) => e.timestamp));
      newestEntry = Math.max(...Array.from(this.cache.values()).map((e) => e.timestamp));
    }

    return {
      size: this.cache.size,
      keys,
      oldestEntry,
      newestEntry,
    };
  }

  /**
   * Get subscriber count for an event.
   */
  getSubscriberCount(event: CacheEvent): number {
    return this.subscribers.get(event)?.size ?? 0;
  }
}
