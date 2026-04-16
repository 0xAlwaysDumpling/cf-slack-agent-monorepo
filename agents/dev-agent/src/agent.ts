import { DurableObject } from "cloudflare:workers";
import type {
	TaskRequest, TaskResult, TaskStatus, TaskOutcome, RepoConfig, TaskUsageResult,
	Plan, PlanResult, PlanRequest, PlanUpdateRequest, PlanStep,
	AuditResult,
} from "./types";
import { startClaudeInSandbox, startTestInSandbox, startResearchInSandbox, pollClaudeLogs, finalizeSandboxTask, destroySandbox, checkpointSandbox, parseClaudeUsage, detectCliStartupFailure, type TaskUsage } from "./sandbox";
import { PromptManager } from "./prompts";
import type { PlanStepContext } from "./prompts";
import {
	TASK_ID_LENGTH,
	MAX_LISTED_TASKS,
	DEFAULT_GIT_BRANCH,
	STALE_TASK_THRESHOLD_MS,
	CHECKPOINT_INTERVAL_MS,
	STORAGE_KEY_ACTIVE_TASK_IDS,
	STORAGE_KEY_ACTIVE_PLAN_IDS,
	STORAGE_KEY_REPO_CONFIGS,
	STORAGE_KEY_TASK_PREFIX,
	STORAGE_KEY_PLAN_PREFIX,
	MAX_LISTED_PLANS,
	PLAN_ID_LENGTH,
	MAX_STEP_RETRIES_TRANSIENT,
	MAX_STEP_RETRIES_NON_TRANSIENT,
} from "./config/constants";

const POLL_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Durable Object definitions
// ---------------------------------------------------------------------------

interface GitHubPR {
	number: number;
	title: string;
	state: string;
	merged_at: string | null;
	html_url: string;
	head: { ref: string };
}

interface StoredTask {
	id: string;
	status: TaskStatus;
	repo: string;
	task: string;
	branch: string;
	repoConfig: RepoConfig | null;
	createdAt: string;
	updatedAt: string;
	planId?: string;
	priorTaskId?: string;
	mode?: "default" | "research";
	modelProvider?: "anthropic" | "fireworks";
	step?: string;
	logs?: string;
	diff?: string;
	prUrl?: string;
	error?: string;
	summary?: string;
	outcome?: TaskOutcome;
	usage?: TaskUsage;
	processId?: string;
	repoDir?: string;
	branchName?: string;
	lastLogLen?: number;
	lastCheckpointAt?: number;
}


export class DevAgent extends DurableObject<Env> {

	// =========================================================================
	// Task storage helpers
	// =========================================================================

	private async getTask(taskId: string): Promise<StoredTask | null> {
		const raw = await this.ctx.storage.get<string>(`${STORAGE_KEY_TASK_PREFIX}${taskId}`);
		if (!raw) return null;
		return JSON.parse(raw);
	}

	private async saveTask(task: StoredTask): Promise<void> {
		task.updatedAt = new Date().toISOString();
		await this.ctx.storage.put(`${STORAGE_KEY_TASK_PREFIX}${task.id}`, JSON.stringify(task));
	}

	private async appendLogs(taskId: string, chunk: string): Promise<void> {
		const key = `logs:${taskId}`;
		const existing = await this.ctx.storage.get<string>(key) ?? "";
		// Strip thinking signature blobs (huge base64, useless for analysis)
		const stripped = chunk.replace(/"signature":"[A-Za-z0-9+/=]{100,}"/g, '"signature":"[stripped]"');
		let updated = existing + stripped;
		const MAX_LOG_BYTES = 1024 * 1024; // 1MB cap
		if (updated.length > MAX_LOG_BYTES) {
			updated = updated.slice(-MAX_LOG_BYTES);
		}
		await this.ctx.storage.put(key, updated);
	}

	private async archiveTask(task: StoredTask): Promise<void> {
		const rawLogs = await this.ctx.storage.get<string>(`logs:${task.id}`) ?? task.logs ?? "";
		// Cap archived logs at 512KB to keep R2 objects manageable
		const MAX_ARCHIVE_LOGS = 512 * 1024;
		const archiveLogs = rawLogs.length > MAX_ARCHIVE_LOGS ? rawLogs.slice(-MAX_ARCHIVE_LOGS) : rawLogs;

		const archive = {
			id: task.id,
			repo: task.repo,
			task: task.task,
			branch: task.branch,
			branchName: task.branchName ?? null,
			status: task.status,
			outcome: task.outcome,
			planId: task.planId ?? null,
			createdAt: task.createdAt,
			completedAt: task.updatedAt,
			durationMs: Date.now() - new Date(task.createdAt).getTime(),
			step: task.step,
			summary: task.summary ?? null,
			diff: task.diff ?? null,
			prUrl: task.prUrl ?? null,
			logs: archiveLogs,
			error: task.error ?? null,
			usage: task.usage ?? null,
		};

		const repoName = task.repo.split("/").pop()?.replace(/\.git$/, "") ?? "unknown";
		const key = `sessions/${repoName}/${task.id}.json`;

		try {
			await this.env.SESSIONS_BUCKET.put(key, JSON.stringify(archive, null, 2), {
				customMetadata: {
					repo: task.repo,
					status: task.status,
					outcome: task.outcome ?? "unknown",
				},
			});
			console.log(`[${task.id}] Archived to R2: ${key}`);
		} catch (err) {
			console.error(`[${task.id}] R2 archive failed:`, err);
			return;
		}

		task.logs = undefined;
		task.diff = undefined;
		task.processId = undefined;
		task.repoDir = undefined;
		task.branchName = undefined;
		task.lastLogLen = undefined;
		task.lastCheckpointAt = undefined;
		task.repoConfig = null;
		await this.saveTask(task);
		await this.ctx.storage.delete(`logs:${task.id}`);

		const activeIds = (await this.ctx.storage.get<string[]>(STORAGE_KEY_ACTIVE_TASK_IDS)) ?? [];
		if (activeIds.length > MAX_LISTED_TASKS * 2) {
			const trimmed = activeIds.slice(-MAX_LISTED_TASKS);
			await this.ctx.storage.put(STORAGE_KEY_ACTIVE_TASK_IDS, trimmed);
		}
	}

	async getArchivedTask(taskId: string): Promise<Record<string, unknown> | null> {
		const list = await this.env.SESSIONS_BUCKET.list({ prefix: "sessions/" });
		for (const obj of list.objects) {
			if (obj.key.includes(taskId)) {
				const r2Obj = await this.env.SESSIONS_BUCKET.get(obj.key);
				if (!r2Obj) continue;
				return r2Obj.json();
			}
		}
		return null;
	}

	/**
	 * List all archived sessions from R2. Returns lightweight metadata
	 * (no logs/diff) sorted by creation time descending.
	 */
	async listSessions(limit = 50): Promise<Record<string, unknown>[]> {
		const results: Record<string, unknown>[] = [];
		let cursor: string | undefined;

		// R2 list may be paginated; collect all session keys first
		const allObjects: { key: string; uploaded: Date; customMetadata?: Record<string, string> }[] = [];
		do {
			const listed = await this.env.SESSIONS_BUCKET.list({
				prefix: "sessions/",
				cursor,
			});
			for (const obj of listed.objects) {
				// Skip plan archives
				if (obj.key.includes("/plan-")) continue;
				allObjects.push({
					key: obj.key,
					uploaded: obj.uploaded,
					customMetadata: obj.customMetadata,
				});
			}
			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor);

		// Sort by upload time descending (newest first)
		allObjects.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());

		for (const obj of allObjects.slice(0, limit)) {
			try {
				const r2Obj = await this.env.SESSIONS_BUCKET.get(obj.key);
				if (!r2Obj) continue;
				const session = await r2Obj.json() as Record<string, unknown>;
				// Strip heavy fields for the list view
				delete session.logs;
				delete session.diff;
				results.push(session);
			} catch { /* skip malformed */ }
		}

		return results;
	}

	// =========================================================================
	// Plan storage helpers
	// =========================================================================

	private async getPlan(planId: string): Promise<Plan | null> {
		const raw = await this.ctx.storage.get<string>(`${STORAGE_KEY_PLAN_PREFIX}${planId}`);
		if (!raw) return null;
		return JSON.parse(raw);
	}

	private async savePlan(plan: Plan): Promise<void> {
		plan.updatedAt = new Date().toISOString();
		await this.ctx.storage.put(`${STORAGE_KEY_PLAN_PREFIX}${plan.id}`, JSON.stringify(plan));
	}

	private async planToResult(plan: Plan): Promise<PlanResult> {
		// Aggregate usage from all completed steps
		let aggregatedUsage: TaskUsageResult | undefined;
		
		if (plan.steps && plan.steps.length > 0) {
			const completedSteps = plan.steps.filter(s => s.taskId && (s.status === "completed" || s.status === "merged"));
			
			if (completedSteps.length > 0) {
				let totalInputTokens = 0;
				let totalOutputTokens = 0;
				let totalCacheReadTokens = 0;
				let totalCacheWriteTokens = 0;
				let totalCostUsd = 0;
				let totalTurns = 0;
				let totalDurationMs = 0;
				
				for (const step of completedSteps) {
					if (step.taskId) {
						const task = await this.getTask(step.taskId);
						if (task?.usage) {
							totalInputTokens += task.usage.inputTokens ?? 0;
							totalOutputTokens += task.usage.outputTokens ?? 0;
							totalCacheReadTokens += task.usage.cacheReadTokens ?? 0;
							totalCacheWriteTokens += task.usage.cacheWriteTokens ?? 0;
							totalCostUsd += task.usage.costUsd ?? 0;
							totalTurns += task.usage.numTurns ?? 0;
							if (task.usage.durationMs) {
								totalDurationMs += task.usage.durationMs;
							}
						}
					}
				}
				
				if (totalInputTokens > 0 || totalOutputTokens > 0 || totalCostUsd > 0) {
					aggregatedUsage = {
						inputTokens: totalInputTokens,
						outputTokens: totalOutputTokens,
						cacheReadTokens: totalCacheReadTokens,
						cacheWriteTokens: totalCacheWriteTokens,
						costUsd: totalCostUsd,
						numTurns: totalTurns,
						durationMs: totalDurationMs > 0 ? totalDurationMs : undefined,
					};
				}
			}
		}
		
		return {
			id: plan.id,
			repo: plan.repo,
			name: plan.name,
			steps: plan.steps ?? [],
			status: plan.status,
			branch: plan.branch,
			currentStepIndex: plan.currentStepIndex ?? 0,
			createdAt: plan.createdAt,
			updatedAt: plan.updatedAt,
			error: plan.error,
			usage: aggregatedUsage,
		};
	}

	private async archivePlan(plan: Plan): Promise<void> {
		const repoName = (plan.repo ?? "").split("/").pop()?.replace(/\.git$/, "") || "unknown";
		const key = `sessions/${repoName}/plan-${plan.id}.json`;

		try {
			await this.env.SESSIONS_BUCKET.put(key, JSON.stringify(plan, null, 2), {
				customMetadata: {
					repo: plan.repo,
					status: plan.status,
					name: plan.name,
				},
			});
			console.log(`[plan:${plan.id}] Archived to R2: ${key}`);
		} catch (err) {
			console.error(`[plan:${plan.id}] R2 archive failed:`, err);
		}
	}

	// =========================================================================
	// Plan CRUD
	// =========================================================================

	async createPlan(request: PlanRequest): Promise<PlanResult> {
		const id = crypto.randomUUID().slice(0, PLAN_ID_LENGTH);
		const now = new Date().toISOString();

		const steps: PlanStep[] = request.steps.map((input) => {
			const isObj = typeof input === "object";
			return {
				id: crypto.randomUUID().slice(0, 8),
				description: isObj ? input.description : input,
			status: "pending" as const,
			};
		});

		const plan: Plan = {
			id,
			repo: request.repo,
			name: request.name,
			steps,
			status: "draft",
			branch: request.branch ?? DEFAULT_GIT_BRANCH,
			currentStepIndex: 0,
			createdAt: now,
			updatedAt: now,
			modelProvider: request.modelProvider,
		};

		await this.savePlan(plan);

		const planIds = (await this.ctx.storage.get<string[]>(STORAGE_KEY_ACTIVE_PLAN_IDS)) ?? [];
		planIds.push(id);
		await this.ctx.storage.put(STORAGE_KEY_ACTIVE_PLAN_IDS, planIds);

		console.log(`[plan:${id}] Created "${plan.name}" with ${steps.length} steps`);
		return await this.planToResult(plan);
	}

	async getPlanStatus(planId: string): Promise<PlanResult | null> {
		const plan = await this.getPlan(planId);
		if (!plan) return null;

		if (plan.status !== "draft") {
			const needsReconcile =
				plan.steps.some((s) => s.status === "running" && s.taskId) ||
				plan.steps.some((s) => s.prNumber && s.status !== "merged") ||
				plan.steps.some((s) => !s.prNumber && s.status !== "pending" && s.status !== "merged") ||
				(plan.status === "running" && !plan.steps.some((s) => s.status === "running"));
			if (needsReconcile) {
				return await this.reconcilePlan(planId) ?? await this.planToResult(plan);
			}
		}

		return await this.planToResult(plan);
	}

	async updatePlan(planId: string, changes: PlanUpdateRequest): Promise<PlanResult | null> {
		const plan = await this.getPlan(planId);
		if (!plan) return null;

		if (plan.status !== "draft") {
			const result = await this.planToResult(plan);
			return {
				...result,
				error: `Cannot update plan — status is "${plan.status}", must be "draft"`,
			};
		}

		if (changes.name) {
			plan.name = changes.name;
		}

		if (changes.steps) {
		plan.steps = changes.steps.map((s) => ({
			id: s.id ?? crypto.randomUUID().slice(0, 8),
			description: s.description,
			status: "pending" as const,
		}));
		}

		await this.savePlan(plan);
		console.log(`[plan:${planId}] Updated — ${plan.steps.length} steps`);
		return await this.planToResult(plan);
	}

	async listPlans(): Promise<PlanResult[]> {
		const planIds = (await this.ctx.storage.get<string[]>(STORAGE_KEY_ACTIVE_PLAN_IDS)) ?? [];
		const plans: PlanResult[] = [];

		for (const id of planIds.slice(-MAX_LISTED_PLANS)) {
			const result = await this.getPlanStatus(id);
			if (result) plans.push(result);
		}

		return plans;
	}

	async runPlan(planId: string): Promise<PlanResult | null> {
		const plan = await this.getPlan(planId);
		if (!plan) return null;

		if (plan.status !== "draft") {
			const result = await this.planToResult(plan);
			return {
				...result,
				error: `Cannot run plan — status is "${plan.status}", must be "draft"`,
			};
		}

		if (plan.steps.length === 0) {
			const result = await this.planToResult(plan);
			return {
				...result,
				error: "Cannot run plan — no steps defined",
			};
		}

		// Find the first step that still needs work
		let startIndex = 0;
		while (startIndex < plan.steps.length) {
			const s = plan.steps[startIndex].status;
			if (s === "completed" || s === "merged") {
				startIndex++;
			} else {
				break;
			}
		}

		if (startIndex >= plan.steps.length) {
			plan.status = "completed";
			await this.savePlan(plan);
			return await this.planToResult(plan);
		}

		plan.status = "running";
		plan.currentStepIndex = startIndex;
		await this.savePlan(plan);

		await this.startPlanStep(plan, startIndex);
		return await this.planToResult(await this.getPlan(planId) as Plan);
	}

	private async startPlanStep(plan: Plan, stepIndex: number): Promise<void> {
		const step = plan.steps[stepIndex];
		if (!step) return;

		const baseBranch = stepIndex === 0
			? plan.branch
			: plan.steps[stepIndex - 1].branchName ?? plan.branch;

		step.status = "running";
		await this.savePlan(plan);

		console.log(`[plan:${plan.id}] Starting step ${stepIndex} (base: ${baseBranch}): ${step.description.slice(0, 80)}`);

		const pm = new PromptManager(this.env.SESSIONS_BUCKET);
		const { content: basePrompt } = await pm.load("plan", plan.repo);
		const planContext: PlanStepContext = {
			stepNumber: stepIndex + 1,
			totalSteps: plan.steps.length,
			planName: plan.name,
			planId: plan.id,
			steps: plan.steps,
			currentStepDescription: step.description,
			previousStepBranch: stepIndex > 0 ? plan.steps[stepIndex - 1].branchName : undefined,
		};
		let systemPrompt = pm.buildPlanPrompt(basePrompt, planContext);

		// Inject cached audit context if available for this repo
		const audit = await this.getLatestAudit(plan.repo);
		if (audit) {
			systemPrompt += [
				"",
				"",
				"## Codebase Audit",
				"A prior analysis of this repository is available below. Use it to understand",
				"the project structure, tech stack, patterns, and architecture before making changes.",
				"",
				audit.analysis,
			].join("\n");
			console.log(`[plan:${plan.id}] Injected audit context (${audit.analysis.length} chars) into step ${stepIndex}`);
		}

		const taskResult = await this.createTask({
			repo: plan.repo,
			task: step.description,
			branch: baseBranch,
			planId: plan.id,
			continueFromTaskId: step.continueFromTaskId,
			modelProvider: plan.modelProvider,
		});

		// Store the built prompt in R2 keyed by taskId — avoids bloating DO storage
		// and the 5000-byte env var limit (prompts can be 8k+).
		await pm.saveTaskPrompt(taskResult.id, systemPrompt);

		step.taskId = taskResult.id;
		step.continueFromTaskId = undefined;
		await this.savePlan(plan);

		// If createTask failed synchronously (e.g. sandbox init exhausted retries),
		// onTaskCompleted couldn't find this step because taskId wasn't linked yet.
		// Now that it is, re-trigger completion handling so plan-level retry can fire.
		if (taskResult.status === "failed") {
			const task = await this.getTask(taskResult.id);
			if (task) await this.onTaskCompleted(task);
		}
	}

	// =========================================================================
	// Task creation (with plan-aware dedup)
	// =========================================================================

	async createTask(request: TaskRequest): Promise<TaskResult> {
		// Dedup: reject if an identical task (same repo + description) is already running,
		// or if a task for the same repo was created very recently (within 30s) — catches
		// Slack webhook retries where LLM-refined descriptions may differ slightly.
		// Plan-owned tasks bypass dedup (the plan orchestrator controls sequencing).
		if (!request.planId) {
			const activeIds = (await this.ctx.storage.get<string[]>(STORAGE_KEY_ACTIVE_TASK_IDS)) ?? [];
			const cleanedIds: string[] = [];
			const RECENT_WINDOW_MS = 30_000;

			for (const existingId of activeIds) {
				const existing = await this.getTask(existingId);
				if (!existing) continue;

				const isActive = existing.status === "running" || existing.status === "pending";
				const age = Date.now() - new Date(existing.createdAt).getTime();

				if (!isActive || age >= STALE_TASK_THRESHOLD_MS) continue;

				cleanedIds.push(existingId);

				const sameRepo = existing.repo === request.repo;
				const sameText = existing.task === request.task;
				const recentlyCreated = age < RECENT_WINDOW_MS;

				if (isActive && sameRepo && (sameText || recentlyCreated)) {
					if (cleanedIds.length !== activeIds.length) {
						await this.ctx.storage.put(STORAGE_KEY_ACTIVE_TASK_IDS, cleanedIds);
					}
					return {
						id: existing.id,
						status: existing.status,
						repo: existing.repo,
						task: existing.task,
						branch: existing.branch,
						createdAt: existing.createdAt,
						updatedAt: existing.updatedAt,
						step: existing.step,
						duplicate: true,
						error: `Duplicate rejected — task ${existing.id} is already ${existing.status} for this repo. Check its status instead of creating a new one.`,
					};
				}
			}

			if (cleanedIds.length !== activeIds.length) {
				await this.ctx.storage.put(STORAGE_KEY_ACTIVE_TASK_IDS, cleanedIds);
			}
		}

		const id = crypto.randomUUID().slice(0, TASK_ID_LENGTH);
		const now = new Date().toISOString();
		const repoConfig = await this.lookupRepoConfig(request.repo);

		let branch = request.branch ?? repoConfig?.defaultBranch ?? DEFAULT_GIT_BRANCH;
		const defaultBranch = repoConfig?.defaultBranch ?? DEFAULT_GIT_BRANCH;

		// Verify the target branch exists on the remote; fall back to default if not
		if (branch !== defaultBranch) {
			const branchExists = await this.remoteBranchExists(request.repo, branch);
			if (!branchExists) {
				console.warn(`[${id}] Branch "${branch}" not found on remote, falling back to "${defaultBranch}"`);
				branch = defaultBranch;
			}
		}

	const task: StoredTask = {
		id,
		status: "pending",
		repo: request.repo,
		task: request.task,
		branch,
		repoConfig,
		planId: request.planId,
		mode: request.mode,
		modelProvider: request.modelProvider,
		createdAt: now,
		updatedAt: now,
	};

		// Continuation: load prior task context and store it in R2 for the sandbox
		if (request.continueFromTaskId) {
			const prior = await this.getTask(request.continueFromTaskId)
				?? await this.getArchivedTask(request.continueFromTaskId) as StoredTask | null;
			if (prior) {
				task.priorTaskId = request.continueFromTaskId;
				// Use the prior task's feature branch as the base so we start from its work
				if (prior.branchName) {
					const priorBranchExists = await this.remoteBranchExists(request.repo, prior.branchName);
					if (priorBranchExists) {
						task.branch = prior.branchName;
					} else {
						console.warn(`[${id}] Prior branch "${prior.branchName}" not found on remote, staying on "${task.branch}"`);
					}
				}
				const continuation = {
					priorTaskId: prior.id,
					priorBranch: prior.branchName ?? null,
					priorDiff: (prior.diff ?? "").slice(0, 20_000) || null,
					priorSummary: prior.summary ?? null,
					priorError: prior.error ?? null,
					priorLogs: (prior.logs ?? "").slice(-5_000) || null,
					priorOutcome: prior.outcome ?? null,
				};
				await this.env.SESSIONS_BUCKET.put(
					`continuations/${id}.json`,
					JSON.stringify(continuation, null, 2),
				);
				console.log(`[${id}] Continuation context saved (prior: ${request.continueFromTaskId})`);
			}
		}

		// Save and append to active list atomically before any async sandbox work
		await this.saveTask(task);
		const activeIds = (await this.ctx.storage.get<string[]>(STORAGE_KEY_ACTIVE_TASK_IDS)) ?? [];
		activeIds.push(id);
		await this.ctx.storage.put(STORAGE_KEY_ACTIVE_TASK_IDS, activeIds);

		task.status = "pending";
		task.step = "queued";
		await this.saveTask(task);

		// Schedule alarm to start sandbox init asynchronously.
		// This avoids blocking the HTTP request (critical for plan tasks where
		// runPlan → startPlanStep → createTask would otherwise hang for minutes).
		await this.ctx.storage.setAlarm(Date.now() + 100);
		console.log(`[${id}] Task queued, alarm scheduled for sandbox init`);

		return this.toResult(task);
	}

	// =========================================================================
	// Task status / list / cancel
	// =========================================================================

	async getTaskStatus(taskId: string): Promise<TaskResult | null> {
		const task = await this.getTask(taskId);
		if (!task) return null;

		const result = this.toResult(task);

		if (task.status !== "running" && !task.logs && !task.diff) {
			const archived = await this.getArchivedTask(taskId);
			if (archived) {
				result.logs = archived.logs as string | undefined;
				result.diff = archived.diff as string | undefined;
				result.summary = archived.summary as string | undefined;
			}
		}

		return result;
	}

	async getTaskLogs(taskId: string): Promise<string | null> {
		const task = await this.getTask(taskId);
		if (!task) return null;

		const doLogs = await this.ctx.storage.get<string>(`logs:${taskId}`);
		if (doLogs) return doLogs;
		if (task.logs) return task.logs;

		const archived = await this.getArchivedTask(taskId);
		if (archived?.logs) return archived.logs as string;

		return "";
	}

	async cancelTask(taskId: string): Promise<TaskResult | null> {
		const task = await this.getTask(taskId);
		if (!task) return null;

		if (task.status === "pending" || task.status === "running") {
			if (task.repoDir && task.branchName) {
				console.log(`[${taskId}] Attempting salvage checkpoint before cancel`);
				await checkpointSandbox(this.env, taskId, task.repoDir, task.branchName);
			}

			task.status = "cancelled";
			task.outcome = "cancelled";
			task.error = "Cancelled by user";
			task.logs = await this.ctx.storage.get<string>(`logs:${taskId}`) ?? "";
			await this.saveTask(task);
			await this.archiveTask(task);
			await destroySandbox(this.env, taskId);
		}

		return this.toResult(task);
	}

	async deleteTask(taskId: string): Promise<{ ok: boolean; error?: string } | null> {
		const task = await this.getTask(taskId);
		if (!task) return null;

		if (task.status === "running" || task.status === "pending") {
			await this.cancelTask(taskId);
		}

		await this.ctx.storage.delete(`${STORAGE_KEY_TASK_PREFIX}${taskId}`);
		await this.ctx.storage.delete(`logs:${taskId}`);

		const activeIds = (await this.ctx.storage.get<string[]>(STORAGE_KEY_ACTIVE_TASK_IDS)) ?? [];
		const filtered = activeIds.filter((id) => id !== taskId);
		await this.ctx.storage.put(STORAGE_KEY_ACTIVE_TASK_IDS, filtered);

		console.log(`[${taskId}] Deleted (was ${task.status})`);
		return { ok: true };
	}

	async continueTask(priorTaskId: string): Promise<TaskResult> {
		const prior = await this.getTask(priorTaskId)
			?? await this.getArchivedTask(priorTaskId) as (Record<string, unknown> & { repo?: string; task?: string; status?: string; branch?: string; planId?: string }) | null;
		if (!prior) {
			return {
				id: priorTaskId,
				status: "failed",
				repo: "",
				task: "",
				branch: "",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				error: `Prior task ${priorTaskId} not found`,
			};
		}

		const priorStatus = prior.status as string;
		if (priorStatus === "running" || priorStatus === "pending") {
			return {
				id: priorTaskId,
				status: priorStatus as TaskStatus,
				repo: (prior.repo as string) ?? "",
				task: (prior.task as string) ?? "",
				branch: (prior.branch as string) ?? "",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				error: `Cannot continue — task ${priorTaskId} is still ${priorStatus}`,
			};
		}

		return this.createTask({
			repo: prior.repo as string,
			task: prior.task as string,
			branch: prior.branch as string,
			planId: prior.planId as string | undefined,
			continueFromTaskId: priorTaskId,
		});
	}

	async listTasks(): Promise<TaskResult[]> {
		const activeIds = (await this.ctx.storage.get<string[]>(STORAGE_KEY_ACTIVE_TASK_IDS)) ?? [];
		const tasks: TaskResult[] = [];

		let hasActive = false;
		for (const id of activeIds.slice(-MAX_LISTED_TASKS)) {
			const task = await this.getTask(id);
			if (task) {
				tasks.push(this.toResult(task));
				if (task.status === "running" || (task.status === "pending" && task.step === "queued")) {
					hasActive = true;
				}
			}
		}

		// Self-heal: ensure alarm is set when tasks need processing
		if (hasActive) {
			const current = await this.ctx.storage.getAlarm();
			if (!current) {
				console.log("[self-heal] Active tasks detected but no alarm set, scheduling one");
				await this.ctx.storage.setAlarm(Date.now() + 1000);
			}
		}

		return tasks;
	}

	// =========================================================================
	// Alarm: poll tasks + advance plans
	// =========================================================================

	async alarm(): Promise<void> {
		const activeIds = (await this.ctx.storage.get<string[]>(STORAGE_KEY_ACTIVE_TASK_IDS)) ?? [];

		// Start any tasks that need sandbox init (queued tasks, or orphaned sandbox-init tasks
		// whose previous alarm was killed by a deployment)
		for (const id of activeIds) {
			const task = await this.getTask(id);
			if (!task) continue;

			const needsInit =
				(task.status === "pending" && task.step === "queued") ||
				(task.status === "running" && task.step === "sandbox-init" && !task.processId);

			if (needsInit) {
				// Reset to pending so startQueuedTask can process it cleanly
				task.status = "pending";
				task.step = "queued";
				await this.saveTask(task);
				await this.startQueuedTask(task);
			}
		}

		for (const id of activeIds) {
			const task = await this.getTask(id);
			if (!task || task.status !== "running") continue;

			const age = Date.now() - new Date(task.createdAt).getTime();
			if (age > STALE_TASK_THRESHOLD_MS) {
				console.warn(`[${id}] Task timed out (${Math.round(age / 1000)}s at step: ${task.step})`);

				if (task.repoDir && task.branchName) {
					console.log(`[${id}] Attempting salvage checkpoint before destroy`);
					await checkpointSandbox(this.env, id, task.repoDir, task.branchName);
				}

				task.status = "failed";
				task.outcome = "timeout";
				task.error = `Task timed out at step "${task.step}" (${Math.round(age / 1000)}s)`;
				task.logs = await this.ctx.storage.get<string>(`logs:${id}`) ?? "";
				await this.saveTask(task);
				await destroySandbox(this.env, id);
				if (task.planId) await this.onTaskCompleted(task);
				await this.notifySlack(task);
				await this.archiveTask(task);
				continue;
			}

			if (task.processId && task.step === "claude-code") {
				await this.pollAndProgress(task);
			}
		}

		// Check for plan steps waiting to retry (set to "pending" by onTaskCompleted)
		await this.resumePendingPlanSteps();

		let hasActive = false;
		for (const id of activeIds) {
			const t = await this.getTask(id);
			if (t?.status === "running" || (t?.status === "pending" && t?.step === "queued")) {
				hasActive = true;
				break;
			}
		}
		if (hasActive) {
			await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
		}
	}

	// =========================================================================
	// Watchdog: CRON-triggered health check for stuck/orphaned tasks & plans
	// =========================================================================

	async watchdog(): Promise<{ cleaned: string[]; retriggered: string[]; alarmRestored: boolean }> {
		const cleaned: string[] = [];
		const retriggered: string[] = [];
		let alarmRestored = false;

		const activeIds = (await this.ctx.storage.get<string[]>(STORAGE_KEY_ACTIVE_TASK_IDS)) ?? [];
		const now = Date.now();
		let hasActive = false;

		for (const id of activeIds) {
			const task = await this.getTask(id);
			if (!task) continue;

			// 1) Running/pending tasks still need an alarm
			if (task.status === "running" || (task.status === "pending" && task.step === "queued")) {
				hasActive = true;

				// Check for stale running tasks that exceeded the timeout but alarm never fired
				if (task.status === "running") {
					const age = now - new Date(task.createdAt).getTime();
					if (age > STALE_TASK_THRESHOLD_MS) {
						console.warn(`[watchdog] Task ${id} exceeded timeout (${Math.round(age / 1000)}s), cleaning up`);

						if (task.repoDir && task.branchName) {
							await checkpointSandbox(this.env, id, task.repoDir, task.branchName);
						}

						task.status = "failed";
						task.outcome = "timeout";
						task.error = `Watchdog: task timed out at step "${task.step}" (${Math.round(age / 1000)}s)`;
						task.logs = await this.ctx.storage.get<string>(`logs:${id}`) ?? "";
						await this.saveTask(task);
						await destroySandbox(this.env, id);

						if (task.planId) await this.onTaskCompleted(task);
						await this.notifySlack(task);
						await this.archiveTask(task);
						cleaned.push(id);
						hasActive = false;
						continue;
					}
				}
				continue;
			}

			// 2) Completed non-research plan tasks with no changes — let plan retry logic handle it
			if (
				task.status === "completed" &&
				task.outcome === "no_changes" &&
				task.mode !== "research" &&
				task.planId
			) {
				console.warn(`[watchdog] Plan task ${id} completed with no_changes, marking failed for plan retry`);
				task.status = "failed";
				task.outcome = "error";
				task.error = "Watchdog: task produced no code changes";
				await this.saveTask(task);
				await this.onTaskCompleted(task);
				retriggered.push(`plan-no-changes:${id}`);
				continue;
			}

			// 3) Failed tasks that belong to a plan — check if the plan got stuck
			if (task.planId && (task.status === "failed" || task.status === "completed")) {
				const plan = await this.getPlan(task.planId);
				if (plan && plan.status === "running") {
					const stepIdx = plan.steps.findIndex((s) => s.taskId === id);
					if (stepIdx >= 0) {
						const step = plan.steps[stepIdx];
						// Plan step still shows "running" but task is done — advancement was missed
						if (step.status === "running") {
							console.warn(`[watchdog] Plan ${plan.id} step ${stepIdx} stuck (task ${id} is ${task.status}), re-advancing`);
							await this.onTaskCompleted(task);
							retriggered.push(`plan:${plan.id}:step:${stepIdx}`);
						}
					}
				}
			}
		}

		// 3) Check for running plans whose current step has no active task
		const planIds = (await this.ctx.storage.get<string[]>(STORAGE_KEY_ACTIVE_PLAN_IDS)) ?? [];
		for (const planId of planIds) {
			const plan = await this.getPlan(planId);
			if (!plan || plan.status !== "running") continue;

			const currentStep = plan.steps[plan.currentStepIndex ?? 0];
			if (!currentStep || currentStep.status !== "running") continue;

			if (currentStep.taskId) {
				const task = await this.getTask(currentStep.taskId);
				if (!task) {
					const retries = currentStep.retryCount ?? 0;
					if (retries >= MAX_STEP_RETRIES_NON_TRANSIENT) {
						console.error(`[watchdog] Plan ${planId} step ${plan.currentStepIndex} exhausted retries (${retries}), failing plan`);
						currentStep.status = "failed";
						plan.status = "failed";
						plan.error = `Step ${(plan.currentStepIndex ?? 0) + 1} failed: exceeded max retries`;
						await this.savePlan(plan);
					} else {
						console.warn(`[watchdog] Plan ${planId} step ${plan.currentStepIndex} has missing task ${currentStep.taskId}, retriggering (${retries + 1}/${MAX_STEP_RETRIES_NON_TRANSIENT})`);
						currentStep.status = "pending";
						currentStep.taskId = undefined;
						currentStep.retryCount = retries + 1;
						await this.savePlan(plan);
						await this.startPlanStep(plan, plan.currentStepIndex ?? 0);
						retriggered.push(`plan:${planId}:step:${plan.currentStepIndex}`);
						hasActive = true;
					}
				}
			} else {
				const retries = currentStep.retryCount ?? 0;
				if (retries >= MAX_STEP_RETRIES_NON_TRANSIENT) {
					console.error(`[watchdog] Plan ${planId} step ${plan.currentStepIndex} running with no task and exhausted retries (${retries}), failing plan`);
					currentStep.status = "failed";
					plan.status = "failed";
					plan.error = `Step ${(plan.currentStepIndex ?? 0) + 1} failed: exceeded max retries`;
					await this.savePlan(plan);
				} else {
					console.warn(`[watchdog] Plan ${planId} step ${plan.currentStepIndex} running with no task, starting (${retries + 1}/${MAX_STEP_RETRIES_NON_TRANSIENT})`);
					currentStep.retryCount = retries + 1;
					await this.savePlan(plan);
					await this.startPlanStep(plan, plan.currentStepIndex ?? 0);
					retriggered.push(`plan:${planId}:step:${plan.currentStepIndex}`);
					hasActive = true;
				}
			}
		}

		// 4) Reconcile plan step statuses with actual task outcomes
		for (const planId of planIds) {
			const plan = await this.getPlan(planId);
			if (!plan) continue;

			let planChanged = false;
			for (let i = 0; i < plan.steps.length; i++) {
				const step = plan.steps[i];
				if (!step.taskId) continue;

				// Step marked failed but task actually succeeded
				if (step.status === "failed" || (step.status === "running" && plan.status !== "running")) {
					const task = await this.getTask(step.taskId);
					if (!task) continue;

					if (task.status === "completed" && (task.outcome === "pr_created" || task.outcome === "no_changes")) {
						const oldStatus = step.status;
						step.status = "completed";
						step.prUrl = step.prUrl ?? task.prUrl;
						step.branchName = step.branchName ?? task.branchName;
						if (task.prUrl && !step.prNumber) {
							const prMatch = task.prUrl.match(/\/pull\/(\d+)/);
							if (prMatch) step.prNumber = parseInt(prMatch[1], 10);
						}
						planChanged = true;
						console.warn(`[watchdog] Plan ${planId} step ${i} was ${oldStatus} but task ${step.taskId} is completed (${task.outcome}), fixed`);
						cleaned.push(`plan-reconcile:${planId}:step:${i}`);
					}
				}
			}

			if (planChanged) {
				await this.savePlan(plan);
			}
		}

		// 5) Ensure alarm is set if there are active tasks/plans
		if (hasActive) {
			const currentAlarm = await this.ctx.storage.getAlarm();
			if (!currentAlarm) {
				console.log("[watchdog] Restoring missing alarm for active tasks");
				await this.ctx.storage.setAlarm(now + 1000);
				alarmRestored = true;
			}
		}

		console.log(`[watchdog] Done. Cleaned: ${cleaned.length}, Retriggered: ${retriggered.length}, Alarm restored: ${alarmRestored}`);
		return { cleaned, retriggered, alarmRestored };
	}

	private async startQueuedTask(task: StoredTask): Promise<void> {
		// Re-read from storage in case the task was cancelled while we waited for the alarm
		const fresh = await this.getTask(task.id);
		if (!fresh || fresh.status !== "pending") {
			console.log(`[${task.id}] Task no longer pending (${fresh?.status}), skipping init`);
			return;
		}
		task = fresh;

		const isTestMode = task.repo === "test";
		const isResearchMode = task.mode === "research";
		try {
			task.status = "running";
			task.step = "sandbox-init";
			await this.saveTask(task);

			// Load cached audit for non-test, non-research tasks
			let auditContext: string | undefined;
			if (!isTestMode && !isResearchMode) {
				const audit = await this.getLatestAudit(task.repo);
				if (audit) {
					auditContext = audit.analysis;
					console.log(`[${task.id}] Loaded audit context (${auditContext.length} chars)`);
				}
			}

			if (isTestMode) {
				console.log(`[${task.id}] TEST MODE — skipping git, running simple Claude prompt`);
				const { processId } = await startTestInSandbox(this.env, task.id, task.task);
				task.step = "claude-code";
				task.processId = processId;
				task.lastLogLen = 0;
			} else if (isResearchMode) {
				console.log(`[${task.id}] RESEARCH MODE — clone and analyze, no branch/PR`);
				const { processId, repoDir } = await startResearchInSandbox(this.env, {
					taskId: task.id,
					repo: task.repo,
					task: task.task,
					baseBranch: task.branch,
					repoConfig: task.repoConfig,
				});
				task.step = "claude-code";
				task.processId = processId;
				task.repoDir = repoDir;
				task.lastLogLen = 0;
			} else {
				const { processId, repoDir, branchName } = await startClaudeInSandbox(this.env, {
					taskId: task.id,
					repo: task.repo,
					task: task.task,
					baseBranch: task.branch,
					repoConfig: task.repoConfig,
					continueFrom: task.priorTaskId ? { priorTaskId: task.priorTaskId } : undefined,
					auditContext,
					modelProvider: task.modelProvider,
				});
				task.step = "claude-code";
				task.processId = processId;
				task.repoDir = repoDir;
				task.branchName = branchName;
				task.lastLogLen = 0;
			}

			await this.saveTask(task);
		} catch (err) {
			task.status = "failed";
			task.step = `failed:${task.step}`;
			task.error = err instanceof Error ? err.message : String(err);
			task.outcome = "error";
			console.error(`[${task.id}] Setup failed at step "${task.step}":`, task.error);
			await this.saveTask(task);
			await destroySandbox(this.env, task.id);

			if (task.planId) {
				await this.onTaskCompleted(task);
			}
		}
	}

	private async pollAndProgress(task: StoredTask): Promise<void> {
		const { done, newContent, totalLen } = await pollClaudeLogs(
			this.env,
			task.id,
			task.processId!,
			task.lastLogLen ?? 0,
		);

		if (newContent) {
			await this.appendLogs(task.id, newContent);
		}

		task.lastLogLen = totalLen;

		if (!done && task.repoDir && task.branchName) {
			const now = Date.now();
			const lastCp = task.lastCheckpointAt ?? 0;
			if (now - lastCp >= CHECKPOINT_INTERVAL_MS) {
				const { committed } = await checkpointSandbox(this.env, task.id, task.repoDir, task.branchName);
				if (committed) {
					task.lastCheckpointAt = now;
				}
			}
		}

		await this.saveTask(task);

		if (done) {
			const isTestMode = task.repo === "test";
			const isResearchMode = task.mode === "research";
			const allLogs = await this.ctx.storage.get<string>(`logs:${task.id}`) ?? "";

			// Extract token usage from Claude's stream-json output
			const usage = parseClaudeUsage(allLogs);
			if (usage) {
				task.usage = usage;
				console.log(`[${task.id}] Usage: ${usage.inputTokens} in / ${usage.outputTokens} out / $${usage.costUsd.toFixed(4)} / ${usage.numTurns} turns`);
			}

			// Detect CLI startup failures (bad flags, missing binary, etc.)
			// If Claude never started, don't finalize — mark as failed immediately.
			if (!usage) {
				const cliError = detectCliStartupFailure(allLogs);
				if (cliError) {
					task.status = "failed";
					task.outcome = "error";
					task.step = "failed:claude-cli";
					task.error = cliError;
					console.error(`[${task.id}] Claude CLI startup failure: ${cliError}`);
					await this.saveTask(task);
					await destroySandbox(this.env, task.id);
					if (task.planId) await this.onTaskCompleted(task);
					await this.notifySlack(task);
					await this.archiveTask(task);
					return;
				}
			}

			if (isTestMode) {
				task.status = "completed";
				task.step = "done";
				task.outcome = "no_changes";
				task.summary = "Test task completed successfully.";
				console.log(`[${task.id}] TEST completed. Logs: ${allLogs.length} chars`);
				await this.saveTask(task);
				await this.archiveTask(task);
				await destroySandbox(this.env, task.id);
				return;
			}

			if (isResearchMode) {
				task.status = "completed";
				task.step = "done";
				task.outcome = "research_complete";

				// Extract the analysis from Claude's output (last text result)
				let analysis = "";
				for (const line of allLogs.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed.startsWith("{")) continue;
					try {
						const obj = JSON.parse(trimmed);
						if (obj.type === "result" && obj.result) {
							analysis = obj.result;
						} else if (obj.type === "assistant" && obj.message?.content) {
							const textBlocks = obj.message.content.filter((b: any) => b.type === "text");
							if (textBlocks.length > 0) {
								analysis = textBlocks.map((b: any) => b.text).join("\n\n");
							}
						}
					} catch { /* not valid JSON */ }
				}

				task.summary = analysis || "Research task completed but no analysis text was extracted.";

				// Store audit in R2
				const repoName = task.repo.split("/").pop()?.replace(/\.git$/, "") ?? "unknown";
				const audit: AuditResult = {
					id: task.id,
					repo: task.repo,
					createdAt: task.createdAt,
					analysis: task.summary,
					taskId: task.id,
				};
				const auditKey = `audits/${repoName}/${task.id}.json`;
				try {
					await this.env.SESSIONS_BUCKET.put(auditKey, JSON.stringify(audit, null, 2), {
						customMetadata: {
							repo: task.repo,
							repoName,
							createdAt: task.createdAt,
						},
					});
					console.log(`[${task.id}] Research audit stored: ${auditKey}`);
				} catch (err) {
					console.error(`[${task.id}] Failed to store audit:`, err);
				}

				console.log(`[${task.id}] RESEARCH completed. Analysis: ${task.summary.length} chars`);
				await this.saveTask(task);
				await this.archiveTask(task);
				await destroySandbox(this.env, task.id);
				return;
			}

			try {
				task.step = "finalizing";
				await this.saveTask(task);

			const FINALIZE_TIMEOUT_MS = 3 * 60 * 1000; // 3 min hard cap for entire finalization
			const { diff, prUrl, summary } = await Promise.race([
				finalizeSandboxTask(
					this.env,
					task.id,
					task.repoDir!,
					task.branchName!,
					task.branch,
					allLogs,
					task.task,
					task.modelProvider,
				),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Finalization timed out (3m)")), FINALIZE_TIMEOUT_MS),
				),
			]);

				task.status = "completed";
				task.step = "done";
				task.diff = diff;
				task.summary = summary;
				task.prUrl = prUrl ?? undefined;
				task.outcome = prUrl ? "pr_created" : "no_changes";
				console.log(`[${task.id}] Task completed. Outcome: ${task.outcome}, PR: ${prUrl ?? "none"}`);

				// Detect max-turns truncation
				if (allLogs.includes("Reached max turns")) {
					task.outcome = task.prUrl ? "pr_created" : "no_changes";
					task.error = task.error ?? "Reached max turns — task may be incomplete";
				}
			} catch (err) {
				task.status = "failed";
				task.step = `failed:${task.step}`;
				task.error = err instanceof Error ? err.message : String(err);
				task.outcome = "error";
				console.error(`[${task.id}] Finalize failed:`, task.error);
				await destroySandbox(this.env, task.id);
			}

			await this.saveTask(task);

			if (task.planId) {
				await this.onTaskCompleted(task);
			}

			await this.notifySlack(task);
			await this.archiveTask(task);
		}
	}

	// =========================================================================
	// Slack callback
	// =========================================================================

	private async notifySlack(task: StoredTask): Promise<void> {
		try {
			await this.env.SLACK_AGENT.fetch("https://slack-agent/callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					type: task.planId ? "plan_step_completed" : "task_completed",
					taskId: task.id,
					planId: task.planId ?? null,
					repo: task.repo,
					status: task.status,
					outcome: task.outcome,
					prUrl: task.prUrl ?? null,
					branchName: task.branchName ?? null,
					summary: task.summary ?? null,
					error: task.error ?? null,
				}),
			});
		} catch (err) {
			console.error(`[${task.id}] Slack callback failed:`, err);
		}
	}

	// =========================================================================
	// Plan step resume (called from alarm for fresh request context)
	// =========================================================================

	private async resumePendingPlanSteps(): Promise<void> {
		const planIds = (await this.ctx.storage.get<string[]>(STORAGE_KEY_ACTIVE_PLAN_IDS)) ?? [];

		for (const planId of planIds) {
			const plan = await this.getPlan(planId);
			if (!plan || plan.status !== "running") continue;

			const pendingIdx = plan.steps.findIndex((s) => s.status === "pending" && (s.retryCount ?? 0) > 0);
			if (pendingIdx < 0) continue;

			console.log(`[plan:${plan.id}] Alarm resuming step ${pendingIdx} (retryCount=${plan.steps[pendingIdx].retryCount})`);
			await this.startPlanStep(plan, pendingIdx);
			break; // one step at a time
		}
	}

	// =========================================================================
	// Plan chain advancement
	// =========================================================================

	private async onTaskCompleted(task: StoredTask): Promise<void> {
		if (!task.planId) return;
		const plan = await this.getPlan(task.planId);
		if (!plan || plan.status !== "running") return;

		const stepIndex = plan.steps.findIndex((s) => s.taskId === task.id);
		if (stepIndex < 0) return;

		const step = plan.steps[stepIndex];

		if (task.status === "completed" && task.outcome === "pr_created") {
			step.status = "completed";
			step.prUrl = task.prUrl;
			step.branchName = task.branchName;
			const prMatch = task.prUrl?.match(/\/pull\/(\d+)/);
			if (prMatch) step.prNumber = parseInt(prMatch[1], 10);

			const nextIndex = stepIndex + 1;
			if (nextIndex < plan.steps.length) {
				plan.currentStepIndex = nextIndex;
				await this.savePlan(plan);
				await this.startPlanStep(plan, nextIndex);
			} else {
				plan.status = "completed";
				plan.currentStepIndex = plan.steps.length;
				await this.savePlan(plan);
				await this.archivePlan(plan);
				console.log(`[plan:${plan.id}] All ${plan.steps.length} steps completed`);
			}
		} else if (task.status === "completed" && task.outcome === "no_changes") {
			// No code changes for a plan step is unusual — retry once, then advance
			const retries = step.retryCount ?? 0;
			if (retries < 1) {
				step.retryCount = retries + 1;
				step.status = "pending";
				step.taskId = undefined;
				await this.savePlan(plan);
				const backoff = 15_000;
				console.warn(`[plan:${plan.id}] Step ${stepIndex} completed with no changes, scheduling retry in ${backoff}ms (attempt ${step.retryCount})`);
				await this.ctx.storage.setAlarm(Date.now() + backoff);
			} else {
				// Already retried — accept and advance
				step.status = "completed";
				step.branchName = task.branchName;

				const nextIndex = stepIndex + 1;
				if (nextIndex < plan.steps.length) {
					plan.currentStepIndex = nextIndex;
					await this.savePlan(plan);
					await this.startPlanStep(plan, nextIndex);
				} else {
					plan.status = "completed";
					plan.currentStepIndex = plan.steps.length;
					await this.savePlan(plan);
					await this.archivePlan(plan);
					console.log(`[plan:${plan.id}] All steps completed (last had no changes after retry)`);
				}
			}
		} else {
			const isTransient = task.step?.startsWith("failed:sandbox");
			const retries = step.retryCount ?? 0;

			if (isTransient && retries < MAX_STEP_RETRIES_TRANSIENT) {
				step.retryCount = retries + 1;
				step.status = "pending";
				step.taskId = undefined;
				await this.savePlan(plan);
				const backoff = Math.min(10_000 * step.retryCount, 60_000);
				console.warn(`[plan:${plan.id}] Step ${stepIndex} transient failure (attempt ${step.retryCount}/${MAX_STEP_RETRIES_TRANSIENT}), scheduling retry in ${backoff}ms: ${task.error}`);
				await this.ctx.storage.setAlarm(Date.now() + backoff);
			} else if (!isTransient && retries < MAX_STEP_RETRIES_NON_TRANSIENT) {
				step.retryCount = retries + 1;
				step.status = "pending";
				// First retry: continuation (resume from prior branch). Subsequent: fresh run.
				const isFresh = retries >= 1;
				if (isFresh) {
					step.continueFromTaskId = undefined;
				} else {
					step.continueFromTaskId = task.id;
				}
				await this.savePlan(plan);
				const backoff = 15_000;
				const mode = isFresh ? "fresh" : "continuation";
				console.warn(`[plan:${plan.id}] Step ${stepIndex} non-transient failure, scheduling ${mode} retry in ${backoff}ms (attempt ${step.retryCount}/${MAX_STEP_RETRIES_NON_TRANSIENT}): ${task.error}`);
				await this.ctx.storage.setAlarm(Date.now() + backoff);
			} else {
				step.status = "failed";
				plan.status = "failed";
				plan.error = `Step ${stepIndex + 1} failed: ${task.error ?? task.outcome ?? "unknown"}`;
				await this.savePlan(plan);
				console.error(`[plan:${plan.id}] Failed at step ${stepIndex}: ${plan.error}`);
			}
		}
	}

	/**
	 * Link PRs to plan steps and update their status.
	 * Finds steps by stepId or existing prNumber, attaches PR info,
	 * then checks GitHub to set the correct status (merged/completed).
	 */
	async markStepsMerged(planId: string, merged: Array<{ stepId?: string; prNumber?: number }>): Promise<PlanResult | null> {
		const plan = await this.getPlan(planId);
		if (!plan) return null;

		let repo = plan.repo;
		const urlMatch = repo.match(/github\.com\/([^/]+\/[^/.]+)/);
		if (urlMatch) repo = urlMatch[1];

		let changed = false;
		for (const m of merged) {
			const step = plan.steps.find((s) =>
				(m.stepId && s.id === m.stepId) || (m.prNumber && s.prNumber === m.prNumber)
			);
			if (!step || step.status === "merged") continue;

			if (m.prNumber) {
				if (step.prNumber !== m.prNumber) {
					step.prNumber = m.prNumber;
					step.prUrl = `https://github.com/${repo}/pull/${m.prNumber}`;
					changed = true;
				}
			}

			if (step.prNumber) {
				const prState = await this.checkPRState(repo, step.prNumber);
				if (prState === "merged") {
					step.status = "merged";
					changed = true;
				} else if (prState === "open" && (step.status === "pending" || step.status === "failed")) {
					step.status = "completed";
					changed = true;
				}
			}
		}

	if (changed) {
		await this.savePlan(plan);
		await this.archivePlan(plan);
		console.log(`[plan:${planId}] Updated ${merged.length} step(s)`);
	}

	return await this.planToResult(plan);
}

	/**
	 * Reconcile a plan by checking actual task states and GitHub PR states.
	 * For steps without PR info, searches GitHub for matching PRs by title.
	 * Promotes steps to "merged" or "completed" based on actual GitHub state.
	 */
	async reconcilePlan(planId: string): Promise<PlanResult | null> {
		const plan = await this.getPlan(planId);
		if (!plan) return null;

		let repo = plan.repo;
		const urlMatch = repo.match(/github\.com\/([^/]+\/[^/.]+)/);
		if (urlMatch) repo = urlMatch[1];

		const stepsNeedingPR = plan.steps.filter((s) => !s.prNumber);
		let repoPRs: GitHubPR[] | null = null;
		if (stepsNeedingPR.length > 0) {
			repoPRs = await this.listRepoPRs(repo);
		}

		let changed = false;

		for (const step of plan.steps) {
			const prev = step.status;

			if (step.status === "running" && step.taskId) {
				const task = await this.getTask(step.taskId);
				if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled")) {
					step.status = task.status === "completed" ? "completed" : "failed";
					step.prUrl ??= task.prUrl;
					step.branchName ??= task.branchName;
					const prMatch = task.prUrl?.match(/\/pull\/(\d+)/);
					if (prMatch && !step.prNumber) step.prNumber = parseInt(prMatch[1], 10);
					changed = true;
					console.log(`[plan:${planId}] Reconciled step ${step.id}: ${prev} → ${step.status} (task ${task.id})`);
				}
			} else if (step.status === "running" && !step.taskId) {
				// Orphaned step: marked running but no task was ever linked (e.g. DO request died)
				step.status = "failed";
				changed = true;
				console.log(`[plan:${planId}] Reconciled orphaned step ${step.id}: running → failed (no taskId)`);
			}

			if (!step.prNumber && repoPRs) {
				const match = this.matchPRToStep(step, repoPRs, plan);
				if (match) {
					step.prNumber = match.number;
					step.prUrl = match.html_url;
					step.branchName = match.head.ref;
					changed = true;
					console.log(`[plan:${planId}] Linked step ${step.id} to PR #${match.number} ("${match.title.slice(0, 60)}")`);
				}
			}

			if (step.prNumber && step.status !== "merged") {
				const prState = await this.checkPRState(repo, step.prNumber);
				if (prState === "merged") {
					step.status = "merged";
					changed = true;
					console.log(`[plan:${planId}] Step ${step.id} PR #${step.prNumber} merged on GitHub: ${prev} → merged`);
				} else if (prState === "closed" && step.status !== "failed") {
					step.status = "failed";
					changed = true;
					console.log(`[plan:${planId}] Step ${step.id} PR #${step.prNumber} closed without merge on GitHub: ${prev} → failed`);
				} else if (prState === "open" && (step.status === "failed" || step.status === "pending" || step.status === "running")) {
					step.status = "completed";
					changed = true;
					console.log(`[plan:${planId}] Step ${step.id} PR #${step.prNumber} open on GitHub: ${prev} → completed`);
				}
			}
		}

		// Always check for stuck/dead plan states, even if no individual step changed
		const terminalStatuses = new Set(["completed", "merged", "failed", "skipped"]);
		const allDone = plan.steps.every((s) => terminalStatuses.has(s.status));
		if (allDone && plan.status === "running") {
			const anyFailed = plan.steps.some((s) => s.status === "failed");
			plan.status = anyFailed ? "failed" : "completed";
			plan.currentStepIndex = plan.steps.length;
			changed = true;
		}
		// A step failed but remaining steps are still pending (no running step to advance) — plan is dead
		if (plan.status === "running" && plan.steps.some((s) => s.status === "failed") && !plan.steps.some((s) => s.status === "running")) {
			plan.status = "failed";
			const failedStep = plan.steps.find((s) => s.status === "failed");
			const failedIdx = plan.steps.indexOf(failedStep!);
			plan.error = `Step ${failedIdx + 1} failed (detected during reconciliation)`;
			changed = true;
		}
		if (plan.status === "failed" && !plan.steps.some((s) => s.status === "failed")) {
			plan.status = "completed";
			plan.error = undefined;
			changed = true;
		}

	if (changed) {
		await this.savePlan(plan);
		await this.archivePlan(plan);
	}

	return await this.planToResult(plan);
}

	private matchPRToStep(step: PlanStep, prs: GitHubPR[], plan: Plan): GitHubPR | null {
		// Only match PRs whose head branch corresponds to a task in THIS plan
		const planTaskIds = new Set(
			plan.steps.map((s) => s.taskId).filter(Boolean) as string[]
		);

		const candidates = prs.filter((pr) => {
			// PR branch must be a dev-agent branch for a task in this plan
			const branchTaskId = pr.head.ref.replace(/^dev-agent\//, "");
			return planTaskIds.has(branchTaskId);
		});

		if (candidates.length === 0) return null;

		const descWords = step.description.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
		if (descWords.length === 0) return null;

		let bestMatch: GitHubPR | null = null;
		let bestScore = 0;

		for (const pr of candidates) {
			const titleLower = pr.title.toLowerCase();
			const matchCount = descWords.filter((w) => titleLower.includes(w)).length;
			const score = matchCount / descWords.length;
			if (score > bestScore && score >= 0.3) {
				bestScore = score;
				bestMatch = pr;
			}
		}

		return bestMatch;
	}

	private async checkPRState(repo: string, prNumber: number): Promise<"open" | "closed" | "merged" | null> {
		try {
			const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
					"User-Agent": "cf-dev-agent",
				},
			});
			if (!res.ok) return null;
			const pr = await res.json() as { state: string; merged: boolean };
			if (pr.merged) return "merged";
			return pr.state as "open" | "closed";
		} catch {
			return null;
		}
	}

	private async listRepoPRs(repo: string): Promise<GitHubPR[]> {
		try {
			const res = await fetch(`https://api.github.com/repos/${repo}/pulls?state=all&per_page=30&sort=created&direction=desc`, {
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
					"User-Agent": "cf-dev-agent",
				},
			});
			if (!res.ok) return [];
			return await res.json() as GitHubPR[];
		} catch {
			return [];
		}
	}

	/**
	 * Reset a failed plan to draft so steps can be adjusted and re-run.
	 * Completed steps are preserved; only the failed step and beyond are reset.
	 */
	async deletePlan(planId: string): Promise<{ ok: boolean; error?: string } | null> {
		const plan = await this.getPlan(planId);
		if (!plan) return null;

		if (plan.status === "running") {
			// Cancel any running tasks owned by this plan
			for (const step of plan.steps) {
				if (step.taskId && step.status === "running") {
					await this.cancelTask(step.taskId);
				}
			}
		}

		await this.ctx.storage.delete(`${STORAGE_KEY_PLAN_PREFIX}${planId}`);

		const planIds = (await this.ctx.storage.get<string[]>(STORAGE_KEY_ACTIVE_PLAN_IDS)) ?? [];
		const filtered = planIds.filter((id) => id !== planId);
		await this.ctx.storage.put(STORAGE_KEY_ACTIVE_PLAN_IDS, filtered);

		console.log(`[plan:${planId}] Deleted (was ${plan.status})`);
		return { ok: true };
	}

	async resetPlan(planId: string): Promise<PlanResult | null> {
		const plan = await this.getPlan(planId);
		if (!plan) return null;

		// Cancel any running tasks before resetting
		for (const step of plan.steps) {
			if (step.taskId && step.status === "running") {
				await this.cancelTask(step.taskId);
			}
		}

		for (const step of plan.steps) {
			step.status = "pending";
			step.taskId = undefined;
			step.prUrl = undefined;
			step.prNumber = undefined;
			step.branchName = undefined;
			step.retryCount = undefined;
			step.continueFromTaskId = undefined;
		}

		plan.status = "draft";
		plan.currentStepIndex = 0;
		plan.error = undefined;
	await this.savePlan(plan);
	console.log(`[plan:${planId}] Reset to draft`);
	return await this.planToResult(plan);
}

	// =========================================================================
	// Repo config
	// =========================================================================

	private async lookupRepoConfig(repoUrl: string): Promise<RepoConfig | null> {
		const configs = await this.ctx.storage.get<Record<string, RepoConfig>>(STORAGE_KEY_REPO_CONFIGS);
		if (!configs) return null;

		const normalized = repoUrl.replace(/\.git$/, "").toLowerCase();
		for (const config of Object.values(configs)) {
			if (config.repoUrl.replace(/\.git$/, "").toLowerCase() === normalized) {
				return config;
			}
		}

		return null;
	}

	private async remoteBranchExists(repoUrl: string, branch: string): Promise<boolean> {
		try {
			const match = repoUrl.match(/github\.com\/([^/]+\/[^/.]+)/);
			if (!match) return true; // Can't check non-GitHub repos, assume exists
			const repo = match[1];
			const res = await fetch(
				`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`,
				{
					headers: {
						Accept: "application/vnd.github+json",
						Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
						"User-Agent": "cf-dev-agent",
					},
				},
			);
			return res.ok;
		} catch {
			return true; // On network error, assume exists and let clone fail naturally
		}
	}

	async setRepoConfig(config: RepoConfig): Promise<void> {
		const configs = (await this.ctx.storage.get<Record<string, RepoConfig>>(STORAGE_KEY_REPO_CONFIGS)) ?? {};
		const key = config.repoUrl.replace(/\.git$/, "").toLowerCase();
		configs[key] = config;
		await this.ctx.storage.put(STORAGE_KEY_REPO_CONFIGS, configs);
	}

	async getRepoConfigs(): Promise<RepoConfig[]> {
		const configs = await this.ctx.storage.get<Record<string, RepoConfig>>(STORAGE_KEY_REPO_CONFIGS);
		if (!configs) return [];
		return Object.values(configs);
	}

	// =========================================================================
	// Audit retrieval
	// =========================================================================

	async listAudits(repoName: string): Promise<AuditResult[]> {
		const prefix = `audits/${repoName}/`;
		const listed = await this.env.SESSIONS_BUCKET.list({ prefix });
		const results: AuditResult[] = [];
		for (const obj of listed.objects) {
			try {
				const r2Obj = await this.env.SESSIONS_BUCKET.get(obj.key);
				if (r2Obj) {
					results.push(await r2Obj.json() as AuditResult);
				}
			} catch { /* skip malformed */ }
		}
		return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async getAudit(repoName: string, auditId: string): Promise<AuditResult | null> {
		const key = `audits/${repoName}/${auditId}.json`;
		try {
			const obj = await this.env.SESSIONS_BUCKET.get(key);
			if (!obj) return null;
			return await obj.json() as AuditResult;
		} catch {
			return null;
		}
	}

	async getLatestAudit(repoUrl: string): Promise<AuditResult | null> {
		const repoName = repoUrl.split("/").pop()?.replace(/\.git$/, "") ?? "";
		if (!repoName) return null;
		const audits = await this.listAudits(repoName);
		return audits[0] ?? null;
	}

	private toResult(task: StoredTask): TaskResult {
		return {
			id: task.id,
			status: task.status,
			repo: task.repo,
			task: task.task,
			branch: task.branch,
			createdAt: task.createdAt,
			updatedAt: task.updatedAt,
			step: task.step,
			logs: task.logs,
			diff: task.diff,
			prUrl: task.prUrl,
			error: task.error,
			summary: task.summary,
			outcome: task.outcome,
			usage: task.usage,
			priorTaskId: task.priorTaskId,
			modelProvider: task.modelProvider,
		};
	}
}
