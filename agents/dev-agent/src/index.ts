import { DevAgent } from "./agent";
import { createRailwayMCPTools } from "./tools/mcp-handlers/railway";
import { createProxyHandler } from "./proxy/index";
import { anthropicService } from "./proxy/services/anthropic";
import { githubService } from "./proxy/services/github";
import { PromptManager } from "./prompts";
import type { TaskRequest, RepoConfig, PlanRequest, PlanUpdateRequest } from "./types";
import { AGENT_ID, DEFAULT_DO_NAME, MCP_AGENT_ID, MCP_TEAM_ID, PROXY_MOUNT_PATH } from "./config/constants";

const proxyHandler = createProxyHandler({
	mountPath: PROXY_MOUNT_PATH,
	jwtSecret: (env) => env.PROXY_JWT_SECRET,
	services: {
		anthropic: anthropicService,
		github: githubService,
	},
});

export { DevAgent };
export { Sandbox } from "@cloudflare/sandbox";

function getAgent(env: Env, agentId = DEFAULT_DO_NAME) {
	const id = env.DevAgent.idFromName(agentId);
	return env.DevAgent.get(id);
}

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function error(message: string, status = 400): Response {
	return json({ error: message }, status);
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	const method = request.method;

	// --- Task routes ---

	if (method === "POST" && path === "/tasks") {
		return handleCreateTask(request, env, ctx);
	}

	if (method === "GET" && path === "/tasks") {
		return handleListTasks(env);
	}

	const logsMatch = path.match(/^\/tasks\/([a-zA-Z0-9-]+)\/logs$/);
	if (logsMatch && method === "GET") {
		return handleGetTaskLogs(env, logsMatch[1]);
	}

	const taskMatch = path.match(/^\/tasks\/([a-zA-Z0-9-]+)$/);
	if (taskMatch) {
		const taskId = taskMatch[1];

		if (method === "GET") {
			return handleGetTask(env, taskId);
		}
	}

	const sessionMatch = path.match(/^\/tasks\/([a-zA-Z0-9-]+)\/session$/);
	if (sessionMatch && method === "GET") {
		return handleGetSession(env, sessionMatch[1]);
	}

	const cancelMatch = path.match(/^\/tasks\/([a-zA-Z0-9-]+)\/cancel$/);
	if (cancelMatch && method === "POST") {
		return handleCancelTask(env, cancelMatch[1]);
	}

	const continueMatch = path.match(/^\/tasks\/([a-zA-Z0-9-]+)\/continue$/);
	if (continueMatch && method === "POST") {
		return handleContinueTask(env, continueMatch[1]);
	}

	// --- Session routes ---

	if (method === "GET" && path === "/sessions") {
		return handleListSessions(env);
	}

	// --- Plan routes ---

	if (method === "POST" && path === "/plans") {
		return handleCreatePlan(request, env);
	}

	if (method === "GET" && path === "/plans") {
		return handleListPlans(env);
	}

	const planRunMatch = path.match(/^\/plans\/([a-zA-Z0-9-]+)\/run$/);
	if (planRunMatch && method === "POST") {
		return handleRunPlan(env, planRunMatch[1]);
	}

	const planResetMatch = path.match(/^\/plans\/([a-zA-Z0-9-]+)\/reset$/);
	if (planResetMatch && method === "POST") {
		return handleResetPlan(env, planResetMatch[1]);
	}

	const planReconcileMatch = path.match(/^\/plans\/([a-zA-Z0-9-]+)\/reconcile$/);
	if (planReconcileMatch && method === "POST") {
		return handleReconcilePlan(env, planReconcileMatch[1]);
	}

	const planMergedMatch = path.match(/^\/plans\/([a-zA-Z0-9-]+)\/merged$/);
	if (planMergedMatch && method === "POST") {
		return handleMarkStepsMerged(request, env, planMergedMatch[1]);
	}

	const planMatch = path.match(/^\/plans\/([a-zA-Z0-9-]+)$/);
	if (planMatch) {
		if (method === "GET") return handleGetPlan(env, planMatch[1]);
		if (method === "PATCH") return handleUpdatePlan(request, env, planMatch[1]);
		if (method === "DELETE") return handleDeletePlan(env, planMatch[1]);
	}

	// --- Research / Audit routes ---

	if (method === "POST" && path === "/research") {
		return handleCreateResearch(request, env);
	}

	const auditsRepoMatch = path.match(/^\/audits\/([a-zA-Z0-9._-]+)$/);
	if (auditsRepoMatch && method === "GET") {
		return handleListAudits(env, auditsRepoMatch[1]);
	}

	const auditMatch = path.match(/^\/audits\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9-]+)$/);
	if (auditMatch && method === "GET") {
		return handleGetAudit(env, auditMatch[1], auditMatch[2]);
	}

	const latestAuditMatch = path.match(/^\/audits\/latest$/);
	if (latestAuditMatch && method === "GET") {
		return handleGetLatestAudit(request, env);
	}

	// --- Repo config routes ---

	if (method === "GET" && path === "/repos") {
		return handleListRepoConfigs(env);
	}

	if (method === "POST" && path === "/repos") {
		return handleSetRepoConfig(request, env);
	}

	// --- Prompt routes ---

	if (path === "/prompts" && method === "GET") {
		return handleListPrompts(env);
	}

	const promptMatch = path.match(/^\/prompts\/(task|plan)$/);
	if (promptMatch) {
		const type = promptMatch[1] as "task" | "plan";
		if (method === "GET") return handleGetPrompt(request, env, type);
		if (method === "PUT") return handleSetPrompt(request, env, type);
		if (method === "DELETE") return handleDeletePrompt(request, env, type);
	}

	// --- Proxy routes (credential isolation for sandbox) ---

	if (path.startsWith("/proxy/")) {
		return proxyHandler(request, env);
	}

	// --- Railway MCP tool routes ---

	if (path.startsWith("/mcp/tools")) {
		return handleMCPRoute(request, env, path);
	}

	// --- Health check ---

	if (method === "GET" && (path === "/" || path === "/health")) {
		return json({ status: "ok", service: AGENT_ID });
	}

	return error("Not found", 404);
}

// --- Task handlers ---

async function handleCreateTask(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	let body: TaskRequest;
	try {
		body = (await request.json()) as TaskRequest;
	} catch {
		return error("Invalid JSON body");
	}

	if (!body.repo || !body.task) {
		return error("Missing required fields: repo, task");
	}

	const agent = getAgent(env);
	const result = await agent.createTask(body);
	return json(result, 201);
}

async function handleGetTask(env: Env, taskId: string): Promise<Response> {
	const agent = getAgent(env);
	const result = await agent.getTaskStatus(taskId);
	if (!result) return error("Task not found", 404);
	return json(result);
}

async function handleListTasks(env: Env): Promise<Response> {
	const agent = getAgent(env);
	const tasks = await agent.listTasks();
	return json({ tasks });
}

async function handleGetTaskLogs(env: Env, taskId: string): Promise<Response> {
	const agent = getAgent(env);
	const logs = await agent.getTaskLogs(taskId);
	if (logs === null) return error("Task not found", 404);
	return new Response(logs, {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}

async function handleGetSession(env: Env, taskId: string): Promise<Response> {
	const agent = getAgent(env);
	const archived = await agent.getArchivedTask(taskId);
	if (!archived) return error("Session not found", 404);
	return json(archived);
}

async function handleCancelTask(env: Env, taskId: string): Promise<Response> {
	const agent = getAgent(env);
	const result = await agent.cancelTask(taskId);
	if (!result) return error("Task not found", 404);
	return json(result);
}

async function handleContinueTask(env: Env, taskId: string): Promise<Response> {
	const agent = getAgent(env);
	const result = await agent.continueTask(taskId);
	if (result.error && !result.priorTaskId) return json(result, 400);
	return json(result, 201);
}

// --- Session handlers ---

async function handleListSessions(env: Env): Promise<Response> {
	const agent = getAgent(env);
	const sessions = await agent.listSessions();
	return json({ sessions });
}

// --- Research / Audit handlers ---

async function handleCreateResearch(request: Request, env: Env): Promise<Response> {
	let body: { repo: string; task?: string; branch?: string };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return error("Invalid JSON body");
	}

	if (!body.repo) {
		return error("Missing required field: repo");
	}

	const agent = getAgent(env);
	const result = await agent.createTask({
		repo: body.repo,
		task: body.task ?? "Analyze this repository and produce a comprehensive codebase audit.",
		branch: body.branch,
		mode: "research",
	});
	return json(result, 201);
}

async function handleListAudits(env: Env, repoName: string): Promise<Response> {
	const agent = getAgent(env);
	const audits = await agent.listAudits(repoName);
	return json({ audits });
}

async function handleGetAudit(env: Env, repoName: string, auditId: string): Promise<Response> {
	const agent = getAgent(env);
	const audit = await agent.getAudit(repoName, auditId);
	if (!audit) return error("Audit not found", 404);
	return json(audit);
}

async function handleGetLatestAudit(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const repoUrl = url.searchParams.get("repo");
	if (!repoUrl) return error("Missing required query param: repo");

	const agent = getAgent(env);
	const audit = await agent.getLatestAudit(repoUrl);
	if (!audit) return error("No audits found for this repo", 404);
	return json(audit);
}

// --- Repo config handlers ---

async function handleListRepoConfigs(env: Env): Promise<Response> {
	const agent = getAgent(env);
	const configs = await agent.getRepoConfigs();
	return json({ configs });
}

async function handleSetRepoConfig(request: Request, env: Env): Promise<Response> {
	let config: RepoConfig;
	try {
		config = (await request.json()) as RepoConfig;
	} catch {
		return error("Invalid JSON body");
	}

	if (!config.repoUrl || !config.platform) {
		return error("Missing required fields: repoUrl, platform");
	}

	const agent = getAgent(env);
	await agent.setRepoConfig(config);
	return json({ ok: true });
}

// --- Plan handlers ---

async function handleCreatePlan(request: Request, env: Env): Promise<Response> {
	let body: PlanRequest;
	try {
		body = (await request.json()) as PlanRequest;
	} catch {
		return error("Invalid JSON body");
	}

	if (!body.repo || !body.name || !body.steps?.length) {
		return error("Missing required fields: repo, name, steps (non-empty array)");
	}

	const agent = getAgent(env);
	const result = await agent.createPlan(body);
	return json(result, 201);
}

async function handleGetPlan(env: Env, planId: string): Promise<Response> {
	const agent = getAgent(env);
	const result = await agent.getPlanStatus(planId);
	if (!result) return error("Plan not found", 404);
	return json(result);
}

async function handleUpdatePlan(request: Request, env: Env, planId: string): Promise<Response> {
	let body: PlanUpdateRequest;
	try {
		body = (await request.json()) as PlanUpdateRequest;
	} catch {
		return error("Invalid JSON body");
	}

	const agent = getAgent(env);
	const result = await agent.updatePlan(planId, body);
	if (!result) return error("Plan not found", 404);
	return json(result);
}

async function handleListPlans(env: Env): Promise<Response> {
	const agent = getAgent(env);
	const plans = await agent.listPlans();
	return json({ plans });
}

async function handleRunPlan(env: Env, planId: string): Promise<Response> {
	const agent = getAgent(env);
	const result = await agent.runPlan(planId);
	if (!result) return error("Plan not found", 404);
	if (result.error) return json(result, 409);
	return json(result);
}

async function handleResetPlan(env: Env, planId: string): Promise<Response> {
	const agent = getAgent(env);
	const result = await agent.resetPlan(planId);
	if (!result) return error("Plan not found", 404);
	if (result.error) return json(result, 409);
	return json(result);
}

async function handleDeletePlan(env: Env, planId: string): Promise<Response> {
	const agent = getAgent(env);
	const result = await agent.deletePlan(planId);
	if (!result) return error("Plan not found", 404);
	return json(result);
}

async function handleReconcilePlan(env: Env, planId: string): Promise<Response> {
	const agent = getAgent(env);
	const result = await agent.reconcilePlan(planId);
	if (!result) return error("Plan not found", 404);
	return json(result);
}

async function handleMarkStepsMerged(request: Request, env: Env, planId: string): Promise<Response> {
	let body: { merged: Array<{ stepId?: string; prNumber?: number }> };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return error("Invalid JSON body");
	}

	if (!body.merged?.length) {
		return error("Missing required field: merged (non-empty array of { stepId?, prNumber? })");
	}

	const agent = getAgent(env);
	const result = await agent.markStepsMerged(planId, body.merged);
	if (!result) return error("Plan not found", 404);
	return json(result);
}

// --- Prompt handlers ---

async function handleListPrompts(env: Env): Promise<Response> {
	const pm = new PromptManager(env.SESSIONS_BUCKET);
	const prompts = await pm.list();
	return json({ prompts });
}

async function handleGetPrompt(request: Request, env: Env, type: "task" | "plan"): Promise<Response> {
	const url = new URL(request.url);
	const repo = url.searchParams.get("repo") ?? undefined;
	const pm = new PromptManager(env.SESSIONS_BUCKET);
	const result = await pm.load(type, repo);
	return json({ type, repo: repo ?? null, source: result.source, content: result.content });
}

async function handleSetPrompt(request: Request, env: Env, type: "task" | "plan"): Promise<Response> {
	let body: { content: string; repo?: string };
	try {
		body = (await request.json()) as { content: string; repo?: string };
	} catch {
		return error("Invalid JSON body");
	}
	if (!body.content) return error("Missing required field: content");

	const pm = new PromptManager(env.SESSIONS_BUCKET);
	await pm.save(type, body.content, body.repo);
	return json({ ok: true, type, repo: body.repo ?? null });
}

async function handleDeletePrompt(request: Request, env: Env, type: "task" | "plan"): Promise<Response> {
	const url = new URL(request.url);
	const repo = url.searchParams.get("repo") ?? undefined;
	const pm = new PromptManager(env.SESSIONS_BUCKET);
	const deleted = await pm.delete(type, repo);
	if (!deleted) return error("Prompt not found", 404);
	return json({ ok: true, type, repo: repo ?? null });
}

// --- MCP tool routes (Railway tools exposed for service binding access) ---

async function handleMCPRoute(request: Request, env: Env, path: string): Promise<Response> {
	const tools = createRailwayMCPTools(env);

	if (path === "/mcp/tools" && request.method === "GET") {
		const toolList = tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		}));
		return json({ tools: toolList });
	}

	const toolMatch = path.match(/^\/mcp\/tools\/(.+)$/);
	if (toolMatch && request.method === "POST") {
		const toolName = toolMatch[1];
		const tool = tools.find((t) => t.name === toolName);
		if (!tool) return error(`Tool not found: ${toolName}`, 404);

		let params: Record<string, unknown> = {};
		try {
			params = (await request.json()) as Record<string, unknown>;
		} catch {
			// no params is fine for some tools
		}

		try {
			const result = await tool.handler(params, {
				env,
				agentId: MCP_AGENT_ID,
				teamId: MCP_TEAM_ID,
			});
			return json(result);
		} catch (err) {
			return error(err instanceof Error ? err.message : String(err), 500);
		}
	}

	return error("Not found", 404);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			return await handleRequest(request, env, ctx);
		} catch (err) {
			console.error("Unhandled error:", err);
			return error("Internal server error", 500);
		}
	},
};
