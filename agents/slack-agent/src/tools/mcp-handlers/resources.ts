/**
 * MCP handlers for provisioning Cloudflare resources (D1, R2).
 * Creates databases and buckets on demand, returns the binding config
 * to paste into wrangler.jsonc.
 */

import type { ToolDefinition, ToolContext, ToolExecutionParams, MCPToolResult } from "../types";

function text(content: string): MCPToolResult {
  return { type: "text", content };
}

function getCFHeaders(env: any): Record<string, string> | null {
  const token = env.CF_API_TOKEN || env.CF_AIG_TOKEN;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export function createResourceMCPTools(): ToolDefinition[] {
  return [
    {
      name: "cf.create-d1",
      description:
        "Create a new Cloudflare D1 database. Returns the database_id and the wrangler.jsonc binding snippet to add to a project.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: 'Database name, e.g. "my-app-db". Lowercase, hyphens allowed.',
          },
          binding: {
            type: "string",
            description: 'Binding name in wrangler.jsonc. Defaults to "DB".',
          },
        },
        required: ["name"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const env = context.env;
        const headers = getCFHeaders(env);
        if (!headers || !env.CF_ACCOUNT_ID) {
          return text(JSON.stringify({ error: "CF_API_TOKEN / CF_ACCOUNT_ID not configured" }));
        }

        const name = (params.name as string).trim();
        const binding = ((params.binding as string | undefined)?.trim() || "DB");

        try {
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({ name }),
            }
          );

          const data = await res.json() as {
            success: boolean;
            result?: { uuid: string; name: string; created_at: string };
            errors?: Array<{ code: number; message: string }>;
          };

          if (!data.success || !data.result) {
            const errMsg = data.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || "Unknown error";
            return text(JSON.stringify({ error: "Failed to create D1 database", details: errMsg }));
          }

          const wranglerSnippet = {
            binding,
            database_name: data.result.name,
            database_id: data.result.uuid,
          };

          return text(
            JSON.stringify({
              ok: true,
              database_id: data.result.uuid,
              name: data.result.name,
              created_at: data.result.created_at,
              wrangler_binding: wranglerSnippet,
              instructions: `Add this to your wrangler.jsonc under "d1_databases": ${JSON.stringify([wranglerSnippet], null, 2)}`,
            })
          );
        } catch (error) {
          return text(
            JSON.stringify({
              error: "Failed to create D1 database",
              details: error instanceof Error ? error.message : String(error),
            })
          );
        }
      },
    },

    {
      name: "cf.create-r2-bucket",
      description:
        "Create a new Cloudflare R2 bucket. Returns the bucket name and the wrangler.jsonc binding snippet to add to a project.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: 'Bucket name, e.g. "my-app-storage". Lowercase, hyphens allowed.',
          },
          binding: {
            type: "string",
            description: 'Binding name in wrangler.jsonc. Defaults to "BUCKET".',
          },
        },
        required: ["name"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const env = context.env;
        const headers = getCFHeaders(env);
        if (!headers || !env.CF_ACCOUNT_ID) {
          return text(JSON.stringify({ error: "CF_API_TOKEN / CF_ACCOUNT_ID not configured" }));
        }

        const name = (params.name as string).trim();
        const binding = ((params.binding as string | undefined)?.trim() || "BUCKET");

        try {
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/buckets`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({ name }),
            }
          );

          const data = await res.json() as {
            success: boolean;
            result?: { name: string; creation_date: string };
            errors?: Array<{ code: number; message: string }>;
          };

          if (!data.success || !data.result) {
            const errMsg = data.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || "Unknown error";
            return text(JSON.stringify({ error: "Failed to create R2 bucket", details: errMsg }));
          }

          const wranglerSnippet = {
            binding,
            bucket_name: data.result.name,
          };

          return text(
            JSON.stringify({
              ok: true,
              bucket_name: data.result.name,
              created_at: data.result.creation_date,
              wrangler_binding: wranglerSnippet,
              instructions: `Add this to your wrangler.jsonc under "r2_buckets": ${JSON.stringify([wranglerSnippet], null, 2)}`,
            })
          );
        } catch (error) {
          return text(
            JSON.stringify({
              error: "Failed to create R2 bucket",
              details: error instanceof Error ? error.message : String(error),
            })
          );
        }
      },
    },
  ];
}
