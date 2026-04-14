import { describe, it, expect, beforeEach, vi } from "vitest";
import { PromptRegistry } from "../../src/prompts/registry";
import type { PromptPart } from "../../src/prompts/types";

describe("PromptRegistry", () => {
  let mockR2: any;
  let registry: PromptRegistry;

  beforeEach(() => {
    mockR2 = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    registry = new PromptRegistry({
      r2Bucket: mockR2,
      cacheTTL: 1000,
    });
  });

  describe("getPart", () => {
    it("should fetch part from R2", async () => {
      const part: PromptPart = {
        type: "system",
        key: "mentioned",
        name: "Mentioned",
        content: "You are helpful",
        version: 1,
        metadata: {
          description: "For mentions",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };

      mockR2.get.mockResolvedValue({
        text: async () => JSON.stringify(part),
      });

      const result = await registry.getPart("system", "mentioned");

      expect(result).toEqual(part);
      expect(mockR2.get).toHaveBeenCalledWith("prompts/parts/system/mentioned.json");
    });

    it("should return null if not found", async () => {
      mockR2.get.mockResolvedValue(null);

      const result = await registry.getPart("system", "nonexistent");

      expect(result).toBeNull();
    });

    it("should cache result", async () => {
      const part: PromptPart = {
        type: "system",
        key: "test",
        name: "Test",
        content: "Test",
        version: 1,
        metadata: {
          description: "Test",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };

      mockR2.get.mockResolvedValue({
        text: async () => JSON.stringify(part),
      });

      // First call
      await registry.getPart("system", "test");
      expect(mockR2.get).toHaveBeenCalledTimes(1);

      // Second call should use cache
      await registry.getPart("system", "test");
      expect(mockR2.get).toHaveBeenCalledTimes(1);
    });
  });

  describe("savePart", () => {
    it("should save part to R2", async () => {
      const part: PromptPart = {
        type: "system",
        key: "new",
        name: "New",
        content: "New content",
        version: 1,
        metadata: {
          description: "New part",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };

      await registry.savePart(part);

      expect(mockR2.put).toHaveBeenCalledWith(
        "prompts/parts/system/new.json",
        expect.any(String),
        expect.any(Object)
      );
    });
  });

  describe("deletePart", () => {
    it("should delete part from R2", async () => {
      await registry.deletePart("system", "mentioned");

      expect(mockR2.delete).toHaveBeenCalledWith("prompts/parts/system/mentioned.json");
    });
  });

  describe("listParts", () => {
    it("should list all parts of type", async () => {
      const index = {
        version: 1,
        type: "system",
        parts: [
          { key: "mentioned", name: "Mentioned", description: "For mentions" },
          { key: "thread", name: "Thread", description: "For threads" },
        ],
      };

      const part1: PromptPart = {
        type: "system",
        key: "mentioned",
        name: "Mentioned",
        content: "Content 1",
        version: 1,
        metadata: {
          description: "For mentions",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };

      const part2: PromptPart = {
        type: "system",
        key: "thread",
        name: "Thread",
        content: "Content 2",
        version: 1,
        metadata: {
          description: "For threads",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };

      mockR2.get
        .mockResolvedValueOnce({
          text: async () => JSON.stringify(index),
        })
        .mockResolvedValueOnce({
          text: async () => JSON.stringify(part1),
        })
        .mockResolvedValueOnce({
          text: async () => JSON.stringify(part2),
        });

      const results = await registry.listParts("system");

      expect(results).toHaveLength(2);
      expect(results[0].key).toBe("mentioned");
      expect(results[1].key).toBe("thread");
    });
  });

  describe("cache invalidation", () => {
    it("should invalidate cache on save", async () => {
      const part: PromptPart = {
        type: "system",
        key: "test",
        name: "Test",
        content: "Test",
        version: 1,
        metadata: {
          description: "Test",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };

      // Populate cache
      mockR2.get.mockResolvedValue({
        text: async () => JSON.stringify(part),
      });
      await registry.getPart("system", "test");

      // Save should invalidate
      await registry.savePart(part);

      const stats = registry.getCacheStats();
      expect(stats.size).toBe(0);
    });
  });
});
