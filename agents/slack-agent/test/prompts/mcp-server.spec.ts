import { describe, it, expect, vi, beforeEach } from "vitest";
import { PromptMCPServer } from "../../src/prompts/mcp-server";
import { PromptRegistry } from "../../src/prompts/registry";
import { PromptComposer } from "../../src/prompts/composer";
import type { PromptPart } from "../../src/prompts/types";

describe("PromptMCPServer", () => {
  let server: PromptMCPServer;
  let mockRegistry: PromptRegistry;
  let mockComposer: PromptComposer;

  beforeEach(() => {
    mockRegistry = {
      getPart: vi.fn(),
      listParts: vi.fn(),
      savePart: vi.fn(),
      deletePart: vi.fn(),
    } as any;

    mockComposer = {
      compose: vi.fn(),
      validate: vi.fn(),
      merge: vi.fn(),
      composeFromParts: vi.fn(),
      createComposedPrompt: vi.fn(),
    } as any;

    server = new PromptMCPServer({
      registry: mockRegistry,
      composer: mockComposer,
    });
  });

  describe("listResources", () => {
    it("should return MCP resource descriptions", async () => {
      vi.mocked(mockRegistry.listParts).mockResolvedValue([
        {
          type: "system",
          key: "mentioned",
          name: "Mentioned Handler",
          content: "You were mentioned",
          version: 1,
          metadata: {
            description: "Handles mentions",
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
          },
        },
      ] as any);

      const resources = await server.listResources();

      expect(resources).toContainEqual(
        expect.objectContaining({
          uri: "prompts://parts/system",
          name: "System Prompt Parts",
        })
      );
    });
  });

  describe("readResource", () => {
    it("should read a system prompt part", async () => {
      const part: PromptPart = {
        type: "system",
        key: "test",
        name: "Test Prompt",
        content: "Test content",
        version: 1,
        metadata: {
          description: "A test prompt",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      };

      vi.mocked(mockRegistry.getPart).mockResolvedValue(part);

      const result = await server.readResource("prompts://parts/system/test");
      const parsed = JSON.parse(result);

      expect(parsed.key).toBe("test");
      expect(parsed.content).toBe("Test content");
    });

    it("should throw on invalid URI format", async () => {
      await expect(server.readResource("invalid://uri")).rejects.toThrow();
    });
  });

  describe("executeTool", () => {
    it("should handle prompts.list", async () => {
      vi.mocked(mockRegistry.listParts).mockResolvedValue([]);

      const result = await server.executeTool("prompts.list", {});

      expect(result.type).toBe("text");
      expect(result.content).toBeDefined();
    });

    it("should handle prompts.get", async () => {
      const part: PromptPart = {
        type: "system",
        key: "test",
        name: "Test",
        content: "content",
        version: 1,
        metadata: {
          description: "",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      };

      vi.mocked(mockRegistry.getPart).mockResolvedValue(part);

      const result = await server.executeTool("prompts.get", {
        type: "system",
        key: "test",
      });

      expect(result.type).toBe("text");
      const parsed = JSON.parse(result.content);
      expect(parsed.key).toBe("test");
    });

    it("should handle prompts.compose", async () => {
      vi.mocked(mockComposer.compose).mockReturnValue({
        full: "composed prompt",
        parts: { system: "sys", user: "user", context: "ctx" },
      } as any);

      const result = await server.executeTool("prompts.compose", {
        system: "sys",
        user: "user",
      });

      expect(result.type).toBe("text");
      const parsed = JSON.parse(result.content);
      expect(parsed.full).toBe("composed prompt");
    });

    it("should handle unknown tools", async () => {
      await expect(server.executeTool("unknown.tool", {})).rejects.toThrow();
    });
  });
});
