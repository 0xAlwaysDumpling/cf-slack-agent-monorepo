import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventBasedCache } from "../../src/tools/cache";

describe("EventBasedCache", () => {
  let cache: EventBasedCache;

  beforeEach(() => {
    cache = new EventBasedCache();
  });

  describe("set/get", () => {
    it("should store and retrieve values", () => {
      cache.set("key1", { data: "value1" });

      const value = cache.get("key1");
      expect(value).toEqual({ data: "value1" });
    });

    it("should return null for missing keys", () => {
      const value = cache.get("nonexistent");
      expect(value).toBeNull();
    });

    it("should overwrite existing values", () => {
      cache.set("key1", "value1");
      cache.set("key1", "value2");

      expect(cache.get("key1")).toBe("value2");
    });
  });

  describe("has", () => {
    it("should check if key exists", () => {
      cache.set("key1", "value");

      expect(cache.has("key1")).toBe(true);
      expect(cache.has("key2")).toBe(false);
    });
  });

  describe("events", () => {
    it("should emit tool:updated event", async () => {
      const handler = vi.fn();
      cache.subscribe("tool:updated", handler);

      await cache.invalidateTool("test-tool");

      expect(handler).toHaveBeenCalledWith("tool:updated", "test-tool");
    });

    it("should emit tool:deleted event", async () => {
      const handler = vi.fn();
      cache.subscribe("tool:deleted", handler);

      await cache.deleteTool("test-tool");

      expect(handler).toHaveBeenCalledWith("tool:deleted", "test-tool");
    });

    it("should emit prompt:updated event", async () => {
      const handler = vi.fn();
      cache.subscribe("prompt:updated", handler);

      await cache.invalidatePrompt("test-prompt");

      expect(handler).toHaveBeenCalledWith("prompt:updated", "test-prompt");
    });

    it("should emit discovery:changed event", async () => {
      const handler = vi.fn();
      cache.subscribe("discovery:changed", handler);

      await cache.invalidateDiscovery();

      expect(handler).toHaveBeenCalledWith("discovery:changed", "discovery-graph");
    });
  });

  describe("subscriptions", () => {
    it("should support multiple subscribers", async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      cache.subscribe("tool:updated", handler1);
      cache.subscribe("tool:updated", handler2);

      await cache.invalidateTool("tool");

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it("should support unsubscribing", async () => {
      const handler = vi.fn();
      const unsubscribe = cache.subscribe("tool:updated", handler);

      await cache.invalidateTool("tool1");
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      await cache.invalidateTool("tool2");
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("invalidation", () => {
    it("should remove from cache on invalidateTool", async () => {
      const key = "tool:test";
      cache.set(key, { data: "value" });

      expect(cache.has(key)).toBe(true);

      await cache.invalidateTool("test");

      expect(cache.has(key)).toBe(false);
    });

    it("should clear all cache on clear", async () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");

      await cache.clear();

      const stats = cache.getStats();
      expect(stats.size).toBe(0);
    });
  });

  describe("stats", () => {
    it("should report cache statistics", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");

      const stats = cache.getStats();

      expect(stats.size).toBe(2);
      expect(stats.keys).toContain("key1");
      expect(stats.keys).toContain("key2");
    });

    it("should report subscriber count", () => {
      cache.subscribe("tool:updated", () => {});
      cache.subscribe("tool:updated", () => {});

      expect(cache.getSubscriberCount("tool:updated")).toBe(2);
      expect(cache.getSubscriberCount("tool:deleted")).toBe(0);
    });
  });
});
