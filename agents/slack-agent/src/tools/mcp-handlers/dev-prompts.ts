/**
 * MCP handlers for dev-agent prompt management.
 * Proxies to the cf-dev-agent prompt endpoints via service binding.
 */

import type { ToolDefinition, ToolContext, ToolExecutionParams, MCPToolResult } from "../types";

function text(content: string): MCPToolResult {
  return { type: "text", content };
}

function noBinding(): MCPToolResult {
  return text(JSON.stringify({ error: "DEV_AGENT service binding not configured" }));
}

async function callDevAgent(
  devAgent: Fetcher,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<MCPToolResult> {
  try {
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await devAgent.fetch(`https://dev-agent${path}`, opts);
    const data = await res.json();
    return text(JSON.stringify(data));
  } catch (error) {
    return text(JSON.stringify({
      error: `Dev agent prompt request failed: ${path}`,
      details: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function createDevPromptMCPTools(): ToolDefinition[] {
  return [
    {
      name: "dev.get-prompt",
      description:
        "Get the active system prompt for dev-agent tasks or plans. Shows which level it's loading from (repo-specific, default R2, or hardcoded fallback). Optionally filter by repo.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: 'Prompt type: "task" (developer prompt) or "plan" (plan-aware prompt)',
          },
          repo: {
            type: "string",
            description: "GitHub repo URL to check for repo-specific prompt (optional)",
          },
        },
        required: ["type"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();
        const type = params.type as string;
        const repo = params.repo as string | undefined;
        const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
        return callDevAgent(devAgent, `/prompts/${type}${qs}`);
      },
    },

    {
      name: "dev.set-prompt",
      description:
        "Create or update a dev-agent system prompt in R2 storage. Can set the global default or a repo-specific override. The prompt is used by Claude Code inside the sandbox.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: 'Prompt type: "task" or "plan"',
          },
          content: {
            type: "string",
            description: "Full prompt content (markdown)",
          },
          repo: {
            type: "string",
            description: "GitHub repo URL for repo-specific prompt (omit for global default)",
          },
        },
        required: ["type", "content"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();
        return callDevAgent(devAgent, `/prompts/${params.type}`, "PUT", {
          content: params.content,
          repo: params.repo,
        });
      },
    },

    {
      name: "dev.list-prompts",
      description:
        "List all stored dev-agent prompts in R2. Shows type (task/plan), scope (default/repo-specific), size, and last updated timestamp.",
      category: "shared",
      version: 1,
      inputSchema: { type: "object", properties: {} },
      handler: async (_params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();
        return callDevAgent(devAgent, "/prompts");
      },
    },

    {
      name: "dev.reset-prompt",
      description:
        "Delete a stored dev-agent prompt from R2, reverting to the next fallback level (repo-specific -> default -> hardcoded).",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: 'Prompt type: "task" or "plan"',
          },
          repo: {
            type: "string",
            description: "GitHub repo URL for repo-specific prompt (omit to delete the global default)",
          },
        },
        required: ["type"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();
        const type = params.type as string;
        const repo = params.repo as string | undefined;
        const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
        return callDevAgent(devAgent, `/prompts/${type}${qs}`, "DELETE");
      },
    },
  ];
}
