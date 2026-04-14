/**
 * Tool discovery system - builds and queries the tool graph/table of contents.
 */

import type { ToolDiscoveryEntry, ToolDiscoveryGraph, MCPTool } from "./types";
import { EventBasedCache } from "./cache";

export class ToolDiscovery {
  private r2Bucket: R2Bucket;
  private cache: EventBasedCache;

  constructor(r2Bucket: R2Bucket, cache: EventBasedCache) {
    this.r2Bucket = r2Bucket;
    this.cache = cache;
  }

  /**
   * Get the complete tool discovery graph (table of contents).
   */
  async getGraph(): Promise<ToolDiscoveryGraph> {
    const cacheKey = "discovery-graph";
    const cached = this.cache.get<ToolDiscoveryGraph>(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      const obj = await this.r2Bucket.get("tools/discovery-graph.json");
      if (!obj) {
        const defaultGraph = this.createDefaultGraph();
        this.cache.set(cacheKey, defaultGraph);
        return defaultGraph;
      }

      const text = await obj.text();
      const graph = JSON.parse(text) as ToolDiscoveryGraph;

      this.cache.set(cacheKey, graph);
      return graph;
    } catch (error) {
      console.error("Failed to fetch discovery graph:", error);
      const defaultGraph = this.createDefaultGraph();
      this.cache.set(cacheKey, defaultGraph);
      return defaultGraph;
    }
  }

  /**
   * Get tools by category.
   */
  async getToolsByCategory(category: "core" | "shared" | "custom"): Promise<ToolDiscoveryEntry[]> {
    const graph = await this.getGraph();
    return graph.toolsByCategory[category] ?? [];
  }

  /**
   * Find a tool by name.
   */
  async findTool(name: string): Promise<ToolDiscoveryEntry | null> {
    const graph = await this.getGraph();
    return graph.tools.find((t) => t.name === name) ?? null;
  }

  /**
   * Get tools sorted by priority (highest first).
   */
  async getToolsByPriority(): Promise<ToolDiscoveryEntry[]> {
    const graph = await this.getGraph();
    return graph.tools.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Find related tools.
   */
  async getRelatedTools(toolName: string): Promise<ToolDiscoveryEntry[]> {
    const graph = await this.getGraph();
    const tool = graph.tools.find((t) => t.name === toolName);

    if (!tool?.relatedTools) {
      return [];
    }

    return graph.tools.filter((t) => tool.relatedTools?.includes(t.name)) ?? [];
  }

  /**
   * Convert discovery entries to MCP tool format.
   */
  toMCPTools(entries: ToolDiscoveryEntry[]): MCPTool[] {
    return entries.map((entry) => ({
      name: entry.name,
      description: entry.description,
      inputSchema: entry.schema ?? {
        type: "object",
        properties: {},
      },
    }));
  }

  /**
   * Save updated discovery graph to R2.
   */
  async saveGraph(graph: ToolDiscoveryGraph): Promise<void> {
    try {
      await this.r2Bucket.put("tools/discovery-graph.json", JSON.stringify(graph, null, 2), {
        httpMetadata: { contentType: "application/json" },
      });

      // Invalidate cache
      await this.cache.invalidateDiscovery();

      console.log("Saved discovery graph");
    } catch (error) {
      console.error("Failed to save discovery graph:", error);
      throw error;
    }
  }

  /**
   * Register a new tool in the discovery graph.
   */
  async registerTool(entry: ToolDiscoveryEntry): Promise<void> {
    const graph = await this.getGraph();

    // Remove if exists
    graph.tools = graph.tools.filter((t) => t.name !== entry.name);

    // Add new tool
    graph.tools.push(entry);

    // Update category map
    const category = entry.category;
    graph.toolsByCategory[category] = graph.toolsByCategory[category].filter((t) => t.name !== entry.name);
    graph.toolsByCategory[category].push(entry);

    // Update timestamp
    graph.timestamp = new Date().toISOString();

    await this.saveGraph(graph);
  }

  /**
   * Unregister a tool from the discovery graph.
   */
  async unregisterTool(toolName: string): Promise<void> {
    const graph = await this.getGraph();

    const tool = graph.tools.find((t) => t.name === toolName);
    if (!tool) return;

    // Remove from tools
    graph.tools = graph.tools.filter((t) => t.name !== toolName);

    // Remove from category
    const category = tool.category;
    graph.toolsByCategory[category] = graph.toolsByCategory[category].filter((t) => t.name !== toolName);

    // Update timestamp
    graph.timestamp = new Date().toISOString();

    await this.saveGraph(graph);
  }

  /**
   * Search tools by description/name pattern.
   */
  async search(query: string): Promise<ToolDiscoveryEntry[]> {
    const graph = await this.getGraph();
    const lowerQuery = query.toLowerCase();

    return graph.tools.filter(
      (t) =>
        t.name.toLowerCase().includes(lowerQuery) ||
        t.description.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * Create default discovery graph with core tools.
   */
  private createDefaultGraph(): ToolDiscoveryGraph {
    return {
      version: 1,
      timestamp: new Date().toISOString(),
      tools: [
        {
          name: "prompts.list",
          category: "core",
          description: "List all available prompt parts and composed prompts",
          priority: 10,
          relatedTools: ["prompts.get", "prompts.compose"],
        },
        {
          name: "prompts.get",
          category: "core",
          description: "Get a specific prompt part or composed prompt by key",
          priority: 9,
          relatedTools: ["prompts.list", "prompts.compose"],
        },
        {
          name: "prompts.compose",
          category: "core",
          description: "Compose a new prompt from system, user, and context parts",
          priority: 9,
          relatedTools: ["prompts.get", "prompts.list"],
        },
        {
          name: "tools.discover",
          category: "core",
          description: "List all available MCP tools",
          priority: 8,
          relatedTools: ["tools.describe", "tools.graph"],
        },
        {
          name: "tools.describe",
          category: "core",
          description: "Get detailed schema and information about a specific tool",
          priority: 7,
          relatedTools: ["tools.discover"],
        },
      ],
      toolsByCategory: {
        core: [
          {
            name: "prompts.list",
            category: "core",
            description: "List all available prompt parts and composed prompts",
            priority: 10,
            relatedTools: ["prompts.get", "prompts.compose"],
          },
          {
            name: "prompts.get",
            category: "core",
            description: "Get a specific prompt part or composed prompt by key",
            priority: 9,
            relatedTools: ["prompts.list", "prompts.compose"],
          },
          {
            name: "prompts.compose",
            category: "core",
            description: "Compose a new prompt from system, user, and context parts",
            priority: 9,
            relatedTools: ["prompts.get", "prompts.list"],
          },
          {
            name: "tools.discover",
            category: "core",
            description: "List all available MCP tools",
            priority: 8,
            relatedTools: ["tools.describe", "tools.graph"],
          },
          {
            name: "tools.describe",
            category: "core",
            description: "Get detailed schema and information about a specific tool",
            priority: 7,
            relatedTools: ["tools.discover"],
          },
        ],
        shared: [],
        custom: [],
      },
    };
  }
}
