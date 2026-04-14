/**
 * MCP handlers for Railway platform integration.
 * Uses Railway's GraphQL API at backboard.railway.com/graphql/v2.
 */

import type { ToolDefinition, ToolContext, ToolExecutionParams, MCPToolResult } from "../types";
import {
  RAILWAY_GRAPHQL_URL,
  RAILWAY_DEFAULT_DEPLOYMENT_LIMIT,
  RAILWAY_DEFAULT_LOG_LINES,
  RAILWAY_MAX_LOG_LINES,
} from "../../config/constants";

function text(content: string): MCPToolResult {
  return { type: "text", content };
}

async function railwayQuery<T = unknown>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const res = await fetch(RAILWAY_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Railway API error (${res.status}): ${body}`);
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };

  if (json.errors?.length) {
    throw new Error(`Railway GraphQL: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  if (!json.data) throw new Error("Railway API returned no data");
  return json.data;
}

const SENSITIVE_KEY = /token|secret|password|key|auth|credential|private|database_url|dsn/i;

function redact(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    out[k] = SENSITIVE_KEY.test(k) ? `${v.slice(0, 4)}...${v.slice(-4)}` : v;
  }
  return out;
}

export function createRailwayMCPTools(): ToolDefinition[] {
  return [
    {
      name: "railway.services",
      description: "List services in a Railway project.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Railway project ID" },
        },
        required: ["projectId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.RAILWAY_API_TOKEN;
        if (!token) return text(JSON.stringify({ error: "RAILWAY_API_TOKEN not configured" }));

        const data = await railwayQuery<{
          project: { services: { edges: Array<{ node: { id: string; name: string; updatedAt: string } }> } };
        }>(
          token,
          `query($projectId: String!) {
            project(id: $projectId) {
              services { edges { node { id name updatedAt } } }
            }
          }`,
          { projectId: params.projectId as string }
        );

        const services = data.project.services.edges.map((e) => e.node);
        return text(JSON.stringify({ success: true, services }, null, 2));
      },
    },

    {
      name: "railway.deployments",
      description: "List recent deployments for a Railway service with status (SUCCESS, FAILED, CRASHED, BUILDING, etc.).",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Railway project ID" },
          serviceId: { type: "string", description: "Railway service ID" },
          environmentId: { type: "string", description: "Railway environment ID" },
          limit: { type: "number", description: "Max deployments (default 10)" },
        },
        required: ["projectId", "serviceId", "environmentId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.RAILWAY_API_TOKEN;
        if (!token) return text(JSON.stringify({ error: "RAILWAY_API_TOKEN not configured" }));

        const data = await railwayQuery<{
          deployments: {
            edges: Array<{
              node: {
                id: string;
                status: string;
                createdAt: string;
                meta: { commitMessage?: string; commitHash?: string; branch?: string } | null;
              };
            }>;
          };
        }>(
          token,
          `query($projectId: String!, $serviceId: String!, $environmentId: String!, $limit: Int) {
            deployments(
              input: { projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId }
              first: $limit
            ) {
              edges { node { id status createdAt meta { commitMessage commitHash branch } } }
            }
          }`,
          {
            projectId: params.projectId as string,
            serviceId: params.serviceId as string,
            environmentId: params.environmentId as string,
            limit: (params.limit as number) ?? RAILWAY_DEFAULT_DEPLOYMENT_LIMIT,
          }
        );

        const deployments = data.deployments.edges.map((e) => e.node);
        return text(JSON.stringify({ success: true, deployments }, null, 2));
      },
    },

    {
      name: "railway.logs",
      description:
        "Fetch Railway logs for an environment. Supports filter syntax: @level:error, @httpStatus:500, free text search, etc.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          environmentId: { type: "string", description: "Railway environment ID" },
          filter: { type: "string", description: "Railway filter syntax, e.g. @level:error" },
          serviceId: { type: "string", description: "Filter to specific service ID" },
          limit: { type: "number", description: "Max log lines (default 100, max 5000)" },
        },
        required: ["environmentId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.RAILWAY_API_TOKEN;
        if (!token) return text(JSON.stringify({ error: "RAILWAY_API_TOKEN not configured" }));

        let filter = (params.filter as string) ?? "";
        if (params.serviceId) {
          filter = filter ? `${filter} @serviceId:${params.serviceId}` : `@serviceId:${params.serviceId}`;
        }

        const data = await railwayQuery<{
          environmentLogs: Array<{ message: string; timestamp: string; severity: string | null }>;
        }>(
          token,
          `query($environmentId: String!, $filter: String, $beforeLimit: Int) {
            environmentLogs(
              environmentId: $environmentId
              filter: $filter
              beforeLimit: $beforeLimit
            ) {
              ... on Log { message timestamp severity }
            }
          }`,
          {
            environmentId: params.environmentId as string,
            filter: filter || undefined,
            beforeLimit: Math.min((params.limit as number) ?? RAILWAY_DEFAULT_LOG_LINES, RAILWAY_MAX_LOG_LINES),
          }
        );

        if (!data.environmentLogs.length) return text("No logs found matching the query.");

        const formatted = data.environmentLogs
          .map((l) => `${l.timestamp} ${l.severity ? `[${l.severity}]` : ""} ${l.message}`)
          .join("\n");

        return text(formatted);
      },
    },

    {
      name: "railway.deployment-status",
      description: "Get detailed status of a specific Railway deployment.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          deploymentId: { type: "string", description: "Railway deployment ID" },
        },
        required: ["deploymentId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.RAILWAY_API_TOKEN;
        if (!token) return text(JSON.stringify({ error: "RAILWAY_API_TOKEN not configured" }));

        const data = await railwayQuery<{
          deployment: {
            id: string;
            status: string;
            createdAt: string;
            updatedAt: string;
            staticUrl: string | null;
            meta: { commitMessage?: string; commitHash?: string; branch?: string } | null;
          };
        }>(
          token,
          `query($id: String!) {
            deployment(id: $id) {
              id status createdAt updatedAt staticUrl
              meta { commitMessage commitHash branch }
            }
          }`,
          { id: params.deploymentId as string }
        );

        return text(JSON.stringify({ success: true, deployment: data.deployment }, null, 2));
      },
    },

    {
      name: "railway.redeploy",
      description: "Trigger a redeployment of a Railway deployment.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          deploymentId: { type: "string", description: "Railway deployment ID to redeploy" },
        },
        required: ["deploymentId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.RAILWAY_API_TOKEN;
        if (!token) return text(JSON.stringify({ error: "RAILWAY_API_TOKEN not configured" }));

        const data = await railwayQuery<{
          deploymentRedeploy: { id: string; status: string };
        }>(
          token,
          `mutation($id: String!) {
            deploymentRedeploy(id: $id) { id status }
          }`,
          { id: params.deploymentId as string }
        );

        return text(
          `Redeployment triggered. New deployment: ${data.deploymentRedeploy.id}, status: ${data.deploymentRedeploy.status}`
        );
      },
    },

    {
      name: "railway.variables",
      description: "List environment variables for a Railway service (sensitive values are redacted).",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Railway project ID" },
          environmentId: { type: "string", description: "Railway environment ID" },
          serviceId: { type: "string", description: "Railway service ID" },
        },
        required: ["projectId", "environmentId", "serviceId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.RAILWAY_API_TOKEN;
        if (!token) return text(JSON.stringify({ error: "RAILWAY_API_TOKEN not configured" }));

        const data = await railwayQuery<{ variables: Record<string, string> }>(
          token,
          `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
            variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
          }`,
          {
            projectId: params.projectId as string,
            environmentId: params.environmentId as string,
            serviceId: params.serviceId as string,
          }
        );

        return text(JSON.stringify({ success: true, variables: redact(data.variables) }, null, 2));
      },
    },
  ];
}
