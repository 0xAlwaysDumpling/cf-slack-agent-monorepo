/**
 * MCP handlers for querying Cloudflare AI Gateway logs and usage.
 * Provides tools for viewing token usage, costs, errors, and request history.
 *
 * API: https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs
 */

import type { ToolDefinition, ToolContext, ToolExecutionParams, MCPToolResult } from "../types";

function getHeaders(env: any): Record<string, string> | null {
  if (!env.CF_API_TOKEN) return null;
  return {
    Authorization: `Bearer ${env.CF_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function buildBaseUrl(env: any): string {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai-gateway/gateways/${env.CF_GATEWAY}`;
}

export function createAIGatewayMCPTools(): ToolDefinition[] {
  return [
    {
      name: "gateway.logs",
      description: "Query recent AI Gateway logs showing model calls, tokens, cost, latency, and success status. Use to debug failed LLM calls or inspect request history.",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of logs to return (default: 20, max: 100)",
          },
          success: {
            type: "boolean",
            description: "Filter by success (true) or failure (false). Omit for all.",
          },
          model: {
            type: "string",
            description: "Filter by model name (e.g. 'gemini-2.5-flash')",
          },
          provider: {
            type: "string",
            description: "Filter by provider (e.g. 'google-ai-studio', 'anthropic', 'openai')",
          },
          hoursBack: {
            type: "number",
            description: "Look back N hours (default: 24, max: 168 for 7 days)",
          },
        },
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const env = context.env;
        const headers = getHeaders(env);
        if (!headers || !env.CF_ACCOUNT_ID || !env.CF_GATEWAY) {
          return {
            type: "text",
            content: JSON.stringify({
              error: "AI Gateway credentials not configured",
              help: "Requires CF_API_TOKEN, CF_ACCOUNT_ID, and CF_GATEWAY",
            }),
          };
        }

        try {
          const limit = Math.min((params.limit as number) ?? 20, 100);
          const hoursBack = Math.min((params.hoursBack as number) ?? 24, 168);
          const startDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

          const url = new URL(`${buildBaseUrl(env)}/logs`);
          url.searchParams.set("per_page", String(limit));
          url.searchParams.set("order_by", "created_at");
          url.searchParams.set("order_by_direction", "desc");
          url.searchParams.set("start_date", startDate);

          if (params.success !== undefined) {
            url.searchParams.set("success", String(params.success));
          }
          if (params.model) {
            url.searchParams.set("model", params.model as string);
          }
          if (params.provider) {
            url.searchParams.set("provider", params.provider as string);
          }

          const response = await fetch(url.toString(), { method: "GET", headers });
          if (!response.ok) {
            const error = await response.text();
            return {
              type: "text",
              content: JSON.stringify({
                error: `AI Gateway API error: ${response.status}`,
                message: error,
              }),
            };
          }

          const data = await response.json() as {
            result?: any[];
            result_info?: any;
            success?: boolean;
          };

          const logs = (data.result || []).map((log: any) => ({
            id: log.id,
            created_at: log.created_at,
            model: log.model,
            provider: log.provider,
            success: log.success,
            status_code: log.status_code,
            tokens_in: log.tokens_in,
            tokens_out: log.tokens_out,
            cost: log.cost,
            duration: log.duration,
            cached: log.cached,
          }));

          return {
            type: "text",
            content: JSON.stringify({
              success: true,
              count: logs.length,
              totalCount: data.result_info?.total_count,
              logs,
            }),
          };
        } catch (error) {
          return {
            type: "text",
            content: JSON.stringify({
              error: "Failed to query AI Gateway logs",
              details: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      },
    },

    {
      name: "gateway.usage",
      description: "Get a summary of AI Gateway usage: total requests, tokens, cost, and error rate over a time period. Useful for cost monitoring and usage reports.",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          hoursBack: {
            type: "number",
            description: "Look back N hours (default: 24, max: 168 for 7 days)",
          },
        },
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const env = context.env;
        const headers = getHeaders(env);
        if (!headers || !env.CF_ACCOUNT_ID || !env.CF_GATEWAY) {
          return {
            type: "text",
            content: JSON.stringify({
              error: "AI Gateway credentials not configured",
              help: "Requires CF_API_TOKEN, CF_ACCOUNT_ID, and CF_GATEWAY",
            }),
          };
        }

        try {
          const hoursBack = Math.min((params.hoursBack as number) ?? 24, 168);
          const startDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

          const url = new URL(`${buildBaseUrl(env)}/logs`);
          url.searchParams.set("per_page", "1");
          url.searchParams.set("start_date", startDate);
          url.searchParams.set("meta_info", "true");

          const response = await fetch(url.toString(), { method: "GET", headers });
          if (!response.ok) {
            const error = await response.text();
            return {
              type: "text",
              content: JSON.stringify({
                error: `AI Gateway API error: ${response.status}`,
                message: error,
              }),
            };
          }

          const data = await response.json() as { result_info?: any; success?: boolean };
          const info = data.result_info || {};

          // Fetch a page of logs to compute per-model breakdown
          const logsUrl = new URL(`${buildBaseUrl(env)}/logs`);
          logsUrl.searchParams.set("per_page", "100");
          logsUrl.searchParams.set("start_date", startDate);
          logsUrl.searchParams.set("order_by", "created_at");
          logsUrl.searchParams.set("order_by_direction", "desc");

          const logsResponse = await fetch(logsUrl.toString(), { method: "GET", headers });
          let modelBreakdown: Record<string, { requests: number; tokens_in: number; tokens_out: number; cost: number; errors: number }> = {};

          if (logsResponse.ok) {
            const logsData = await logsResponse.json() as { result?: any[] };
            for (const log of logsData.result || []) {
              const model = log.model || "unknown";
              if (!modelBreakdown[model]) {
                modelBreakdown[model] = { requests: 0, tokens_in: 0, tokens_out: 0, cost: 0, errors: 0 };
              }
              modelBreakdown[model].requests++;
              modelBreakdown[model].tokens_in += log.tokens_in || 0;
              modelBreakdown[model].tokens_out += log.tokens_out || 0;
              modelBreakdown[model].cost += log.cost || 0;
              if (!log.success) modelBreakdown[model].errors++;
            }
          }

          return {
            type: "text",
            content: JSON.stringify({
              success: true,
              period: { hoursBack, startDate },
              summary: {
                totalRequests: info.total_count ?? 0,
                costRange: { min: info.min_cost, max: info.max_cost },
                tokensInRange: { min: info.min_tokens_in, max: info.max_tokens_in },
                tokensOutRange: { min: info.min_tokens_out, max: info.max_tokens_out },
                durationRange: { min: info.min_duration, max: info.max_duration },
              },
              byModel: modelBreakdown,
            }),
          };
        } catch (error) {
          return {
            type: "text",
            content: JSON.stringify({
              error: "Failed to query AI Gateway usage",
              details: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      },
    },

    {
      name: "gateway.log-detail",
      description: "Get full details for a specific AI Gateway log entry by ID, including request/response headers and sizes.",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The log entry ID to retrieve",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const env = context.env;
        const headers = getHeaders(env);
        if (!headers || !env.CF_ACCOUNT_ID || !env.CF_GATEWAY) {
          return {
            type: "text",
            content: JSON.stringify({
              error: "AI Gateway credentials not configured",
              help: "Requires CF_API_TOKEN, CF_ACCOUNT_ID, and CF_GATEWAY",
            }),
          };
        }

        try {
          const logId = params.id as string;
          const url = `${buildBaseUrl(env)}/logs/${logId}`;

          const response = await fetch(url, { method: "GET", headers });
          if (!response.ok) {
            const error = await response.text();
            return {
              type: "text",
              content: JSON.stringify({
                error: `AI Gateway API error: ${response.status}`,
                message: error,
              }),
            };
          }

          const data = await response.json() as { result?: any };
          const log = data.result;

          return {
            type: "text",
            content: JSON.stringify({
              success: true,
              log: {
                id: log.id,
                created_at: log.created_at,
                model: log.model,
                provider: log.provider,
                success: log.success,
                status_code: log.status_code,
                tokens_in: log.tokens_in,
                tokens_out: log.tokens_out,
                cost: log.cost,
                duration: log.duration,
                cached: log.cached,
                request_size: log.request_size,
                response_size: log.response_size,
                request_head: log.request_head,
                response_head: log.response_head,
              },
            }),
          };
        } catch (error) {
          return {
            type: "text",
            content: JSON.stringify({
              error: "Failed to get log detail",
              details: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      },
    },
  ];
}
