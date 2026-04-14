import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolDiscovery } from "../../src/tools/discovery";
import { EventBasedCache } from "../../src/tools/cache";

describe("ToolDiscovery", () => {
  let mockR2: any;
  let cache: EventBasedCache;
  let discovery: ToolDiscovery;

  beforeEach(() => {
    mockR2 = {
      get: vi.fn(),
      put: vi.fn(),
    };

    cache = new EventBasedCache();
    discovery = new ToolDiscovery(mockR2, cache);
  });

  describe("getGraph", () => {
    it("should return default graph if not in R2", async () => {
      mockR2.get.mockResolvedValue(null);

      const graph = await discovery.getGraph();

      expect(graph.version).toBe(1);
      expect(graph.tools.length).toBeGreaterThan(0);
      expect(graph.toolsByCategory).toBeDefined();
    });

    it("should fetch from R2 if exists", async () => {
      const graphData = {
        version: 1,
        timestamp: new Date().toISOString(),
        tools: [
          {
            name: "custom.tool",
            category: "shared",
            description: "Custom tool",
            priority: 5,
          },
        ],
        toolsByCategory: {
          core: [],
          shared: [
            {
              name: "custom.tool",
              category: "shared",
              description: "Custom tool",
              priority: 5,
            },
          ],
          custom: [],
        },
      };

      mockR2.get.mockResolvedValue({
        text: async () => JSON.stringify(graphData),
      });

      const graph = await discovery.getGraph();

      expect(graph.tools[0].name).toBe("custom.tool");
    });

    it("should cache graph", async () => {
      mockR2.get.mockResolvedValue(null);

      const graph1 = await discovery.getGraph();
      const graph2 = await discovery.getGraph();

      expect(graph1).toEqual(graph2);
      expect(mockR2.get).toHaveBeenCalledTimes(1);
    });
  });

  describe("getToolsByCategory", () => {
    it("should return tools by category", async () => {
      mockR2.get.mockResolvedValue(null);

      const core = await discovery.getToolsByCategory("core");

      expect(core.length).toBeGreaterThan(0);
      expect(core.every((t) => t.category === "core")).toBe(true);
    });
  });

  describe("findTool", () => {
    it("should find tool by name", async () => {
      mockR2.get.mockResolvedValue(null);

      const tool = await discovery.findTool("prompts.list");

      expect(tool).toBeDefined();
      expect(tool?.name).toBe("prompts.list");
    });

    it("should return null if tool not found", async () => {
      mockR2.get.mockResolvedValue(null);

      const tool = await discovery.findTool("nonexistent.tool");

      expect(tool).toBeNull();
    });
  });

  describe("getToolsByPriority", () => {
    it("should return tools sorted by priority", async () => {
      mockR2.get.mockResolvedValue(null);

      const tools = await discovery.getToolsByPriority();

      for (let i = 0; i < tools.length - 1; i++) {
        expect(tools[i].priority).toBeGreaterThanOrEqual(tools[i + 1].priority);
      }
    });
  });

  describe("search", () => {
    it("should search by name", async () => {
      mockR2.get.mockResolvedValue(null);

      const results = await discovery.search("prompts");

      expect(results.length).toBeGreaterThan(0);
      expect(results.some((t) => t.name.includes("prompts"))).toBe(true);
    });

    it("should search by description", async () => {
      mockR2.get.mockResolvedValue(null);

      const results = await discovery.search("list");

      expect(results.length).toBeGreaterThan(0);
    });

    it("should be case insensitive", async () => {
      mockR2.get.mockResolvedValue(null);

      const results1 = await discovery.search("PROMPTS");
      const results2 = await discovery.search("prompts");

      expect(results1.length).toBe(results2.length);
    });
  });

  describe("registerTool", () => {
    it("should add tool to graph", async () => {
      mockR2.get.mockResolvedValue(null);

      const tool = {
        name: "custom.action",
        category: "custom" as const,
        description: "Custom action",
        priority: 1,
      };

      await discovery.registerTool(tool);

      expect(mockR2.put).toHaveBeenCalled();
    });
  });

  describe("getRelatedTools", () => {
    it("should get related tools", async () => {
      mockR2.get.mockResolvedValue(null);

      const related = await discovery.getRelatedTools("prompts.list");

      expect(Array.isArray(related)).toBe(true);
    });
  });
});
