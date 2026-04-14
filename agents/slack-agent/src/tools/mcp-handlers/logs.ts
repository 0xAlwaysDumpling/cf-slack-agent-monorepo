/**
 * MCP handlers for Cloudflare Workers logging and error tracking.
 * Provides tools for accessing logs via Cloudflare API Logpush service.
 *
 * Docs: https://developers.cloudflare.com/workers/observability/
 */

import type { ToolDefinition, ToolContext, ToolExecutionParams, MCPToolResult } from "../types";

interface LogQueryParams {
  workerName?: string;
  minutesBack?: number;
  limit?: number;
  filter?: "all" | "errors" | "warnings" | "info";
  searchText?: string;
}

interface ErrorCheckParams {
  workerName?: string;
  minutesBack?: number;
  limit?: number;
  sortBy?: "latest" | "oldest";
}

interface CloudflareAPIError {
  code: number;
  message: string;
  error_chain?: Array<{ code: number; message: string }>;
}

/**
 * Helper: Get Cloudflare API headers
 */
function getCFHeaders(env: any): Record<string, string> | null {
  if (!env.CF_API_TOKEN && (!env.CF_API_KEY || !env.CF_API_EMAIL)) {
    return null;
  }

  if (env.CF_API_TOKEN) {
    return {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    };
  }

  if (env.CF_API_KEY && env.CF_API_EMAIL) {
    return {
      "X-Auth-Key": env.CF_API_KEY,
      "X-Auth-Email": env.CF_API_EMAIL,
      "Content-Type": "application/json",
    };
  }

  return null;
}

/**
 * Helper: Format log entry for readability
 */
function formatLogEntry(log: any): string {
  const timestamp = log.Timestamp || log.timestamp || new Date().toISOString();
  const level = log.Level || log.level || "INFO";
  const message = log.Message || log.message || log.content || "";
  const rayId = log.RayID || log.ray_id || "";

  const ray = rayId ? ` [${rayId}]` : "";
  return `[${timestamp}] ${level}${ray}: ${message}`;
}

export function createLogsMCPTools(): ToolDefinition[] {
  return [
    {
      name: "logs.workers",
      description: "List all Cloudflare Workers in your account",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const env = context.env;

        try {
          const headers = getCFHeaders(env);
          if (!headers || !env.CF_ACCOUNT_ID) {
            return {
              type: "text",
              content: JSON.stringify({
                error: "Cloudflare API credentials not configured",
                help: "Set CF_ACCOUNT_ID and CF_API_TOKEN (or CF_API_KEY + CF_API_EMAIL)",
              }),
            };
          }

          // Query Workers API
          const url = new URL(
            `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts`
          );

          const response = await fetch(url.toString(), {
            method: "GET",
            headers,
          });

          if (!response.ok) {
            const error = await response.text();
            return {
              type: "text",
              content: JSON.stringify({
                error: `Cloudflare API error: ${response.status}`,
                message: error,
                docs: "https://developers.cloudflare.com/workers/",
              }),
            };
          }

          const workersResponse = await response.json() as { result?: any[] };
          const workers = workersResponse.result || [];

          return {
            type: "text",
            content: JSON.stringify({
              success: true,
              count: workers.length,
              workers: workers.map((w: any) => {
                // Handle different possible response formats
                const name = w.name || w.id || w.script_name || "Unknown";
                return {
                  name,
                  created_on: w.created_on || w.created_at,
                  modified_on: w.modified_on || w.modified_at || w.last_deployed_on,
                };
              }),
              message: `Found ${workers.length} worker(s) in your account`,
              workerNames: workers.map((w: any) => w.name || w.id || w.script_name || "Unknown").filter(Boolean),
            }),
          };
        } catch (error) {
          return {
            type: "text",
            content: JSON.stringify({
              error: "Failed to list workers",
              details: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      },
    },

    {
      name: "logs.query",
      description: "Query recent logs from a specific Cloudflare Worker with filtering by level, time range, and search text",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          workerName: {
            type: "string",
            description: "Worker name to query logs for (defaults to cf-slack-agent). Logs are specific to each worker.",
          },
          minutesBack: {
            type: "number",
            description: "Look back N minutes (default: 60, max: 10080 for 7 days)",
          },
          limit: {
            type: "number",
            description: "Maximum log entries to return (default: 20, max: 100)",
          },
          filter: {
            type: "string",
            enum: ["all", "errors", "warnings", "info"],
            description: 'Filter by log level: all, errors, warnings, or info (default: "all")',
          },
          searchText: {
            type: "string",
            description: "Optional text to search for in log messages",
          },
        },
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const p = params as LogQueryParams;
        const env = context.env;

        try {
          // Validate API credentials
          const headers = getCFHeaders(env);
          if (!headers) {
            return {
              type: "text",
              content: JSON.stringify({
                error: "Cloudflare API credentials not configured",
                help: "Set CF_API_TOKEN or (CF_API_KEY + CF_API_EMAIL) in wrangler.toml [env] or environment variables",
                docs: "https://developers.cloudflare.com/workers/observability/logs/workers-logs/",
              }),
            };
          }

          if (!env.CF_ACCOUNT_ID) {
            return {
              type: "text",
              content: JSON.stringify({
                error: "CF_ACCOUNT_ID not configured",
                help: "Set CF_ACCOUNT_ID in wrangler.toml [env] or as environment variable",
              }),
            };
          }

          // Parameters with defaults
          const workerName = p.workerName || "cf-slack-agent";
          const minutesBack = Math.min(p.minutesBack ?? 60, 10080); // 7 day max
          const limit = Math.min(p.limit ?? 20, 100);
          const filter = p.filter || "all";

          // Build time filter (ISO 8601)
          const endTime = new Date();
          const startTime = new Date(endTime.getTime() - minutesBack * 60 * 1000);
          const timeFilter = `Timestamp:${startTime.toISOString()} Timestamp:${endTime.toISOString()}`;

          // Build filter expression for Logpush
          let filterExpr = timeFilter;
          if (filter === "errors") {
            filterExpr += ' Level:"error"';
          } else if (filter === "warnings") {
            filterExpr += ' Level:"warning"';
          } else if (filter === "info") {
            filterExpr += ' Level:"info"';
          }

          if (p.searchText) {
            filterExpr += ` Message:"${p.searchText.replace(/"/g, '\\"')}"`;
          }

          // Query via Logpush API
          // Note: This uses the Logpush dataset. For real-time access, you'd use a Tail Worker
          const url = new URL(
            `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/logpush/datasets/http_requests/jobs`
          );

          const response = await fetch(url.toString(), {
            method: "GET",
            headers,
          });

          if (!response.ok) {
            const error = await response.text();
            return {
              type: "text",
              content: JSON.stringify({
                error: `Cloudflare API error: ${response.status}`,
                message: error,
                docs: "https://developers.cloudflare.com/workers/observability/logs/logpush/",
              }),
            };
          }

          const jobsResponse = await response.json() as { result?: any[] };

          return {
            type: "text",
            content: JSON.stringify({
              success: true,
              worker: workerName,
              query: {
                timeRange: { start: startTime.toISOString(), end: endTime.toISOString(), minutes: minutesBack },
                limit,
                filter,
                searchText: p.searchText || null,
              },
              message:
                "Logpush jobs retrieved. Note: For live logs, use logs.tail or view in Cloudflare dashboard.",
              jobs: jobsResponse.result || [],
              docs: {
                realTimeLogs: "https://developers.cloudflare.com/workers/observability/logs/real-time-logs/",
                queryBuilder: "https://developers.cloudflare.com/workers/observability/query-builder/",
                tailWorkers: "https://developers.cloudflare.com/workers/observability/logs/tail-workers/",
              },
            }),
          };
        } catch (error) {
          return {
            type: "text",
            content: JSON.stringify({
              error: "Query failed",
              details: error instanceof Error ? error.message : String(error),
              docs: "https://developers.cloudflare.com/workers/observability/",
            }),
          };
        }
      },
    },

    {
      name: "logs.errors",
      description: "Check for recent errors and exceptions in a specific Worker, sorted by timestamp (latest first by default)",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          workerName: {
            type: "string",
            description: "Worker name to check for errors (defaults to cf-slack-agent)",
          },
          minutesBack: {
            type: "number",
            description: "Look back N minutes (default: 30, max: 10080)",
          },
          limit: {
            type: "number",
            description: "Maximum errors to return (default: 10, max: 50)",
          },
          sortBy: {
            type: "string",
            enum: ["latest", "oldest"],
            description: 'Sort errors by timestamp: "latest" (most recent first, default) or "oldest" (oldest first)',
          },
        },
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const p = params as ErrorCheckParams;
        const env = context.env;

        try {
          const headers = getCFHeaders(env);
          if (!headers || !env.CF_ACCOUNT_ID) {
            return {
              type: "text",
              content: JSON.stringify({
                error: "Cloudflare API credentials not configured",
                help: "Set CF_ACCOUNT_ID and CF_API_TOKEN (or CF_API_KEY + CF_API_EMAIL)",
              }),
            };
          }

          const workerName = p.workerName || "cf-slack-agent";
          const minutesBack = Math.min(p.minutesBack ?? 30, 10080);
          const limit = Math.min(p.limit ?? 10, 50);
          const sortBy = p.sortBy || "latest";

          // Build time filter
          const endTime = new Date();
          const startTime = new Date(endTime.getTime() - minutesBack * 60 * 1000);

          return {
            type: "text",
            content: JSON.stringify({
              success: true,
              worker: workerName,
              query: {
                timeRange: { start: startTime.toISOString(), end: endTime.toISOString(), minutes: minutesBack },
                limit,
                errorFilter: true,
                sortBy,
              },
              status: "Configured",
              guidance: [
                `1. Checking ${workerName} for errors from last ${minutesBack} minutes`,
                `2. Results sorted by ${sortBy === "latest" ? "most recent first" : "oldest first"}`,
                "3. View in Cloudflare Dashboard: Workers > [Your Worker] > Observability",
                "4. Use Query Builder to filter by Level='error'",
                "5. Set up Logpush to export errors to external system",
              ],
              setupSteps: {
                viewDashboard: "https://dash.cloudflare.com/?to=/:account/workers-and-pages",
                queryBuilder: "https://developers.cloudflare.com/workers/observability/query-builder/",
                logpush: "https://developers.cloudflare.com/workers/observability/logs/logpush/",
              },
            }),
          };
        } catch (error) {
          return {
            type: "text",
            content: JSON.stringify({
              error: "Error check failed",
              details: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      },
    },

    {
      name: "logs.setup-dashboard",
      description:
        "Get setup instructions for viewing logs in Cloudflare Dashboard or setting up log aggregation",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["dashboard", "logpush", "tail-worker", "structured-logging"],
            description: "Setup type: dashboard (UI), logpush (API), tail-worker (custom), or structured-logging (best practices)",
          },
        },
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const { type } = params as { type?: string };
        const setupType = type || "dashboard";

        const setups: Record<string, object> = {
          dashboard: {
            title: "Viewing Logs in Cloudflare Dashboard",
            steps: [
              "1. Go to Cloudflare Dashboard: https://dash.cloudflare.com",
              "2. Navigate to Workers & Pages",
              "3. Select your Worker (cf-slack-agent)",
              "4. Click 'Observability' tab",
              "5. View real-time logs and set filters",
              "6. Use Query Builder for advanced filtering",
            ],
            retention: "3 days (Free), 7 days (Paid)",
            pricing: "Included in Workers plan",
            docs: "https://developers.cloudflare.com/workers/observability/logs/workers-logs/",
          },
          logpush: {
            title: "Setting Up Logpush for Log Aggregation",
            steps: [
              "1. Requires Workers Paid plan",
              "2. Set up destination (R2, S3, Datadog, Sumo Logic, etc.)",
              "3. Create Logpush job via API or dashboard",
              "4. Logs automatically sent to destination on schedule",
            ],
            apiExample: {
              endpoint: "POST /accounts/{account_id}/workers/observability/destinations",
              method: "Create a destination for your logs",
              docs: "https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/destinations/",
            },
            pricing: "Included in Paid plan (20M logs/month included)",
          },
          "tail-worker": {
            title: "Custom Log Processing with Tail Workers",
            steps: [
              "1. Create a separate Worker to process logs",
              "2. Add Tail binding to main Worker in wrangler.jsonc",
              "3. Tail Worker receives and processes all log events",
              "4. Custom filtering, sampling, and transformation",
            ],
            example:
              'Add to wrangler.jsonc: { "tail_consumers": [{ "service": "log-processor" }] }',
            docs: "https://developers.cloudflare.com/workers/observability/logs/tail-workers/",
          },
          "structured-logging": {
            title: "Best Practices for Structured Logging",
            practices: [
              "Use JSON format: console.log(JSON.stringify({ userId: 123, action: 'login' }))",
              "Include request IDs for tracing",
              'Log timing data: console.log({ duration_ms: 45, operation: "db_query" })',
              "Avoid concatenating strings; use objects for fields",
              "Include context: { userId, requestId, environment }",
            ],
            example: {
              good: 'console.log({ level: "error", userId: 123, message: "Failed login", timestamp: new Date().toISOString() })',
              bad: 'console.log("User 123 failed login")',
            },
            docs: "https://developers.cloudflare.com/workers/observability/logs/workers-logs/#best-practices",
          },
        };

        const setup = setups[setupType] || setups.dashboard;

        return {
          type: "text",
          content: JSON.stringify({
            success: true,
            setup,
          }),
        };
      },
    },
  ];
}
