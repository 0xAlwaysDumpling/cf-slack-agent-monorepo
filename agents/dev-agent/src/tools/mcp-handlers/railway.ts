import type { ToolDefinition, MCPToolResult } from "../types";
import {
	listServices,
	listDeployments,
	getDeploymentStatus,
	getEnvironmentLogs,
	triggerRedeploy,
	getServiceVariables,
	redactVariables,
} from "../../railway";
import {
	RAILWAY_DEFAULT_DEPLOYMENT_LIMIT,
	PG_POOL_MAX,
	PG_IDLE_TIMEOUT_SECONDS,
	PG_CONNECT_TIMEOUT_SECONDS,
	MAX_SQL_RESULT_ROWS,
} from "../../config/constants";

function text(content: string): MCPToolResult {
	return { type: "text", content };
}

export function createRailwayMCPTools(env: Env): ToolDefinition[] {
	const token = env.RAILWAY_API_TOKEN;
	if (!token) return [];

	return [
		{
			name: "railway.services",
			description: "List services in a Railway project",
			category: "shared",
			version: 1,
			inputSchema: {
				type: "object",
				properties: {
					projectId: { type: "string", description: "Railway project ID" },
				},
				required: ["projectId"],
			},
			handler: async (params) => {
				const services = await listServices(token, params.projectId as string);
				return text(JSON.stringify(services, null, 2));
			},
		},

		{
			name: "railway.deployments",
			description: "List recent deployments for a Railway service with status",
			category: "shared",
			version: 1,
			inputSchema: {
				type: "object",
				properties: {
					projectId: { type: "string", description: "Railway project ID" },
					serviceId: { type: "string", description: "Railway service ID" },
					environmentId: { type: "string", description: "Railway environment ID" },
					limit: { type: "number", description: "Max deployments to return (default 10)" },
				},
				required: ["projectId", "serviceId", "environmentId"],
			},
			handler: async (params) => {
				const deployments = await listDeployments(
					token,
					params.projectId as string,
					params.serviceId as string,
					params.environmentId as string,
					(params.limit as number) ?? RAILWAY_DEFAULT_DEPLOYMENT_LIMIT
				);
				return text(JSON.stringify(deployments, null, 2));
			},
		},

		{
			name: "railway.deployment-status",
			description: "Get detailed status of a specific Railway deployment",
			category: "shared",
			version: 1,
			inputSchema: {
				type: "object",
				properties: {
					deploymentId: { type: "string", description: "Railway deployment ID" },
				},
				required: ["deploymentId"],
			},
			handler: async (params) => {
				const deployment = await getDeploymentStatus(token, params.deploymentId as string);
				return text(JSON.stringify(deployment, null, 2));
			},
		},

		{
			name: "railway.logs",
			description:
				"Fetch Railway logs for an environment. Supports Railway filter syntax (@level:error, @httpStatus:500, etc.)",
			category: "shared",
			version: 1,
			inputSchema: {
				type: "object",
				properties: {
					environmentId: { type: "string", description: "Railway environment ID" },
					filter: {
						type: "string",
						description: "Railway filter syntax, e.g. @level:error, @httpStatus:500",
					},
					serviceId: { type: "string", description: "Filter to specific service ID" },
					deploymentId: { type: "string", description: "Filter to specific deployment ID" },
					limit: {
						type: "number",
						description: "Max log lines (default 100, max 5000)",
					},
				},
				required: ["environmentId"],
			},
			handler: async (params) => {
				const logs = await getEnvironmentLogs(
					token,
					params.environmentId as string,
					{
						filter: params.filter as string | undefined,
						serviceId: params.serviceId as string | undefined,
						deploymentId: params.deploymentId as string | undefined,
						limit: params.limit as number | undefined,
					}
				);

				if (logs.length === 0) {
					return text("No logs found matching the query.");
				}

				const formatted = logs
					.map((l) => {
						const sev = l.severity ? `[${l.severity}]` : "";
						return `${l.timestamp} ${sev} ${l.message}`;
					})
					.join("\n");

				return text(formatted);
			},
		},

		{
			name: "railway.redeploy",
			description: "Trigger a redeployment of a Railway deployment",
			category: "shared",
			version: 1,
			inputSchema: {
				type: "object",
				properties: {
					deploymentId: { type: "string", description: "Railway deployment ID to redeploy" },
				},
				required: ["deploymentId"],
			},
			handler: async (params) => {
				const result = await triggerRedeploy(token, params.deploymentId as string);
				return text(
					`Redeployment triggered. New deployment ID: ${result.id}, status: ${result.status}`
				);
			},
		},

		{
			name: "railway.variables",
			description:
				"List environment variables for a Railway service (sensitive values are redacted)",
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
			handler: async (params) => {
				const vars = await getServiceVariables(
					token,
					params.projectId as string,
					params.environmentId as string,
					params.serviceId as string
				);
				const redacted = redactVariables(vars);
				return text(JSON.stringify(redacted, null, 2));
			},
		},

		{
			name: "railway.query",
			description:
				"Run a read-only SQL query against a Railway Postgres service. Fetches DATABASE_URL from the service's env vars automatically.",
			category: "shared",
			version: 1,
			inputSchema: {
				type: "object",
				properties: {
					projectId: { type: "string", description: "Railway project ID" },
					environmentId: { type: "string", description: "Railway environment ID" },
					serviceId: {
						type: "string",
						description: "Railway Postgres service ID",
					},
					query: { type: "string", description: "SQL query (SELECT only)" },
				},
				required: ["projectId", "environmentId", "serviceId", "query"],
			},
			handler: async (params) => {
				const sql = (params.query as string).trim();
				if (!isReadOnly(sql)) {
					return text("Error: Only read-only queries (SELECT, EXPLAIN, SHOW) are allowed.");
				}

				const vars = await getServiceVariables(
					token,
					params.projectId as string,
					params.environmentId as string,
					params.serviceId as string
				);

				const dbUrl = vars.DATABASE_URL || vars.DATABASE_PUBLIC_URL;
				if (!dbUrl) {
					return text(
						"Error: No DATABASE_URL or DATABASE_PUBLIC_URL found in the service variables. " +
							"Ensure public networking is enabled on the Postgres service."
					);
				}

				try {
					const { default: postgres } = await import("postgres");
					const pg = postgres(dbUrl, { max: PG_POOL_MAX, idle_timeout: PG_IDLE_TIMEOUT_SECONDS, connect_timeout: PG_CONNECT_TIMEOUT_SECONDS });

					try {
						const rows = await pg.unsafe(sql);
						const result = {
							rowCount: rows.length,
							columns: rows.columns?.map((c: { name: string }) => c.name) ?? [],
							rows: rows.slice(0, MAX_SQL_RESULT_ROWS),
						};
						return text(JSON.stringify(result, null, 2));
					} finally {
						await pg.end();
					}
				} catch (err) {
					return text(`Error executing query: ${err instanceof Error ? err.message : String(err)}`);
				}
			},
		},
	];
}

const READ_ONLY_PATTERN = /^\s*(SELECT|EXPLAIN|SHOW|DESCRIBE|WITH\s)/i;
const WRITE_PATTERN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i;

function isReadOnly(sql: string): boolean {
	if (!READ_ONLY_PATTERN.test(sql)) return false;
	if (WRITE_PATTERN.test(sql)) return false;
	return true;
}
