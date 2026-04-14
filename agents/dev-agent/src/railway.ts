/**
 * Railway GraphQL API client.
 * Endpoint: https://backboard.railway.com/graphql/v2
 * Auth: workspace token via Authorization: Bearer header.
 */

import {
	RAILWAY_GRAPHQL_URL,
	RAILWAY_DEFAULT_DEPLOYMENT_LIMIT,
	RAILWAY_DEFAULT_LOG_LINES,
	RAILWAY_MAX_LOG_LINES,
	SENSITIVE_KEY_PATTERNS,
	REDACT_VISIBLE_CHARS,
} from "./config/constants";

interface GraphQLResponse<T = unknown> {
	data?: T;
	errors?: Array<{ message: string; extensions?: unknown }>;
}

export async function railwayQuery<T = unknown>(
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
		const text = await res.text();
		throw new Error(`Railway API error (${res.status}): ${text}`);
	}

	const json = (await res.json()) as GraphQLResponse<T>;

	if (json.errors && json.errors.length > 0) {
		throw new Error(`Railway GraphQL error: ${json.errors.map((e) => e.message).join(", ")}`);
	}

	if (!json.data) {
		throw new Error("Railway API returned no data");
	}

	return json.data;
}

// --- Query builders ---

export interface RailwayService {
	id: string;
	name: string;
	icon: string | null;
	updatedAt: string;
}

export interface RailwayDeployment {
	id: string;
	status: string;
	createdAt: string;
	updatedAt: string;
	staticUrl: string | null;
	meta: {
		commitMessage?: string;
		commitHash?: string;
		branch?: string;
	} | null;
}

export interface RailwayLogEntry {
	message: string;
	timestamp: string;
	severity: string | null;
}

export async function listServices(
	token: string,
	projectId: string
): Promise<RailwayService[]> {
	const query = `
		query ListServices($projectId: String!) {
			project(id: $projectId) {
				services {
					edges {
						node {
							id
							name
							icon
							updatedAt
						}
					}
				}
			}
		}
	`;

	const data = await railwayQuery<{
		project: { services: { edges: Array<{ node: RailwayService }> } };
	}>(token, query, { projectId });

	return data.project.services.edges.map((e) => e.node);
}

export async function listDeployments(
	token: string,
	projectId: string,
	serviceId: string,
	environmentId: string,
	limit = RAILWAY_DEFAULT_DEPLOYMENT_LIMIT
): Promise<RailwayDeployment[]> {
	const query = `
		query ListDeployments(
			$projectId: String!
			$serviceId: String!
			$environmentId: String!
			$limit: Int
		) {
			deployments(
				input: {
					projectId: $projectId
					serviceId: $serviceId
					environmentId: $environmentId
				}
				first: $limit
			) {
				edges {
					node {
						id
						status
						createdAt
						updatedAt
						staticUrl
						meta {
							commitMessage
							commitHash
							branch
						}
					}
				}
			}
		}
	`;

	const data = await railwayQuery<{
		deployments: { edges: Array<{ node: RailwayDeployment }> };
	}>(token, query, { projectId, serviceId, environmentId, limit });

	return data.deployments.edges.map((e) => e.node);
}

export async function getDeploymentStatus(
	token: string,
	deploymentId: string
): Promise<RailwayDeployment> {
	const query = `
		query GetDeployment($id: String!) {
			deployment(id: $id) {
				id
				status
				createdAt
				updatedAt
				staticUrl
				meta {
					commitMessage
					commitHash
					branch
				}
			}
		}
	`;

	const data = await railwayQuery<{ deployment: RailwayDeployment }>(
		token,
		query,
		{ id: deploymentId }
	);

	return data.deployment;
}

export async function getEnvironmentLogs(
	token: string,
	environmentId: string,
	opts: {
		filter?: string;
		limit?: number;
		serviceId?: string;
		deploymentId?: string;
	} = {}
): Promise<RailwayLogEntry[]> {
	const query = `
		query GetLogs(
			$environmentId: String!
			$filter: String
			$beforeLimit: Int
		) {
			environmentLogs(
				environmentId: $environmentId
				filter: $filter
				beforeLimit: $beforeLimit
			) {
				... on Log {
					message
					timestamp
					severity
				}
			}
		}
	`;

	let filter = opts.filter ?? "";
	if (opts.serviceId) {
		filter = filter ? `${filter} @serviceId:${opts.serviceId}` : `@serviceId:${opts.serviceId}`;
	}
	if (opts.deploymentId) {
		filter = filter
			? `${filter} @deploymentId:${opts.deploymentId}`
			: `@deploymentId:${opts.deploymentId}`;
	}

	const data = await railwayQuery<{
		environmentLogs: RailwayLogEntry[];
	}>(token, query, {
		environmentId,
		filter: filter || undefined,
		beforeLimit: Math.min(opts.limit ?? RAILWAY_DEFAULT_LOG_LINES, RAILWAY_MAX_LOG_LINES),
	});

	return data.environmentLogs;
}

export async function triggerRedeploy(
	token: string,
	deploymentId: string
): Promise<{ id: string; status: string }> {
	const mutation = `
		mutation Redeploy($id: String!) {
			deploymentRedeploy(id: $id) {
				id
				status
			}
		}
	`;

	const data = await railwayQuery<{
		deploymentRedeploy: { id: string; status: string };
	}>(token, mutation, { id: deploymentId });

	return data.deploymentRedeploy;
}

export async function getServiceVariables(
	token: string,
	projectId: string,
	environmentId: string,
	serviceId: string
): Promise<Record<string, string>> {
	const query = `
		query GetVariables(
			$projectId: String!
			$environmentId: String!
			$serviceId: String!
		) {
			variables(
				projectId: $projectId
				environmentId: $environmentId
				serviceId: $serviceId
			)
		}
	`;

	const data = await railwayQuery<{ variables: Record<string, string> }>(
		token,
		query,
		{ projectId, environmentId, serviceId }
	);

	return data.variables;
}

/** Redact sensitive variable values for safe display */
export function redactVariables(vars: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(vars)) {
		const isSensitive = SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
		result[key] = isSensitive
			? `${value.slice(0, REDACT_VISIBLE_CHARS)}...${value.slice(-REDACT_VISIBLE_CHARS)}`
			: value;
	}
	return result;
}
