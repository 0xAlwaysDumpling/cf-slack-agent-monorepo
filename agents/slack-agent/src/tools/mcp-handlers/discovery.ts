/**
 * MCP handlers for tool discovery.
 */

import type { ToolDefinition, ToolContext, ToolExecutionParams, MCPToolResult } from "../types";
import { ToolDiscovery } from "../discovery";

export function createDiscoveryMCPTools(discovery: ToolDiscovery): ToolDefinition[] {
  return [
    {
      name: "tools.discover",
      description: "List all available MCP tools with their descriptions",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: 'Filter by category: "core", "shared", or "custom" (optional)',
          },
          sortBy: {
            type: "string",
            description: 'Sort by: "priority", "name", or "category" (default: priority)',
          },
        },
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams): Promise<MCPToolResult> => {
        const { category, sortBy } = params as { category?: string; sortBy?: string };

        let tools: Awaited<ReturnType<ToolDiscovery["getGraph"]>>["tools"];

        if (category && ["core", "shared", "custom"].includes(category)) {
          const categoryTools = await discovery.getToolsByCategory(
            category as "core" | "shared" | "custom"
          );
          tools = categoryTools;
        } else {
          const graph = await discovery.getGraph();
          tools = graph.tools;
        }

        // Sort
        if (sortBy === "name") {
          tools = tools.sort((a, b) => a.name.localeCompare(b.name));
        } else if (sortBy === "category") {
          tools = tools.sort((a, b) => a.category.localeCompare(b.category));
        } else {
          tools = tools.sort((a, b) => b.priority - a.priority);
        }

        return {
          type: "text",
          content: JSON.stringify({
            count: tools.length,
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              category: t.category,
              priority: t.priority,
            })),
          }),
        };
      },
    },

    {
      name: "tools.describe",
      description: "Get detailed information and schema for a specific tool",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Tool name to describe",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams): Promise<MCPToolResult> => {
        const { name } = params as { name: string };

        const tool = await discovery.findTool(name);

        if (!tool) {
          return {
            type: "text",
            content: JSON.stringify({
              error: `Tool not found: ${name}`,
            }),
          };
        }

        return {
          type: "text",
          content: JSON.stringify(tool),
        };
      },
    },

    {
      name: "tools.search",
      description: "Search for tools by name or description pattern",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (matches name or description)",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams): Promise<MCPToolResult> => {
        const { query } = params as { query: string };

        const results = await discovery.search(query);

        return {
          type: "text",
          content: JSON.stringify({
            query,
            count: results.length,
            tools: results.map((t) => ({
              name: t.name,
              description: t.description,
              category: t.category,
              priority: t.priority,
            })),
          }),
        };
      },
    },

    {
      name: "tools.related",
      description: "Get tools related to a specific tool",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          toolName: {
            type: "string",
            description: "Name of the tool to find related tools for",
          },
        },
        required: ["toolName"],
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams): Promise<MCPToolResult> => {
        const { toolName } = params as { toolName: string };

        const related = await discovery.getRelatedTools(toolName);

        return {
          type: "text",
          content: JSON.stringify({
            toolName,
            relatedCount: related.length,
            related: related.map((t) => ({
              name: t.name,
              description: t.description,
            })),
          }),
        };
      },
    },
  ];
}
