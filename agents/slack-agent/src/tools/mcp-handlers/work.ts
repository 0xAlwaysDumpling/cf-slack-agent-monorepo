/**
 * MCP handlers for work tracking tools.
 * Exposes search, status, active, and cancel for tracked work items.
 */

import type { ToolDefinition, ToolExecutionParams, ToolContext, MCPToolResult } from "../types";
import type { WorkTracker } from "../../work/tracker";

function text(content: string): MCPToolResult {
  return { type: "text", content };
}

export function createWorkMCPTools(tracker: WorkTracker): ToolDefinition[] {
  return [
    {
      name: "work.search",
      description:
        "Search tracked work items (tasks and plans). Filter by repo, status, type, channel, user, or description text. Returns work items with their Slack thread context.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Filter by repo URL or name (partial match)" },
          status: { type: "string", description: "Filter by status: pending, running, completed, failed, cancelled" },
          type: { type: "string", description: "Filter by type: task or plan" },
          channel: { type: "string", description: "Filter by Slack channel ID" },
          createdBy: { type: "string", description: "Filter by Slack user ID who created the work" },
          query: { type: "string", description: "Search description text (partial match)" },
          limit: { type: "number", description: "Max results to return (default 20, max 100)" },
        },
      },
      handler: async (params: ToolExecutionParams): Promise<MCPToolResult> => {
        const results = await tracker.search({
          repo: params.repo as string | undefined,
          status: params.status as any,
          type: params.type as any,
          channel: params.channel as string | undefined,
          createdBy: params.createdBy as string | undefined,
          query: params.query as string | undefined,
          limit: params.limit as number | undefined,
        });
        return text(JSON.stringify({ count: results.length, items: results }));
      },
    },

    {
      name: "work.status",
      description:
        "Get the status of a specific work item by its ID or dev-agent task/plan ID. Includes the Slack thread where it was discussed.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          devAgentId: { type: "string", description: "Dev-agent task or plan ID" },
        },
        required: ["devAgentId"],
      },
      handler: async (params: ToolExecutionParams): Promise<MCPToolResult> => {
        const item = await tracker.getByDevAgentId(params.devAgentId as string);
        if (!item) {
          return text(JSON.stringify({ error: "Work item not found" }));
        }
        return text(JSON.stringify(item));
      },
    },

    {
      name: "work.active",
      description:
        "List all currently active (pending or running) work items. Shows what the dev-agent is working on right now with Slack thread context.",
      category: "shared",
      version: 1,
      inputSchema: { type: "object", properties: {} },
      handler: async (): Promise<MCPToolResult> => {
        const items = await tracker.getActive();
        return text(JSON.stringify({ count: items.length, items }));
      },
    },

    {
      name: "work.thread",
      description:
        "Get all work items associated with a specific Slack thread. Shows the history of tasks and plans created in a conversation.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Slack channel ID" },
          threadTs: { type: "string", description: "Slack thread timestamp" },
        },
        required: ["channel", "threadTs"],
      },
      handler: async (params: ToolExecutionParams): Promise<MCPToolResult> => {
        const items = await tracker.getByThread(
          params.channel as string,
          params.threadTs as string,
        );
        return text(JSON.stringify({ count: items.length, items }));
      },
    },
  ];
}
