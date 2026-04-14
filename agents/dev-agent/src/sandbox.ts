import { getSandbox } from "@cloudflare/sandbox";
import type { RepoConfig } from "./types";
import { appendRepoContext, extractRepoName, buildBranchName } from "./config";
import { buildAuthenticatedCloneUrl, buildGitCredentialCommands } from "./github";
import { generatePRSummary, generateNoSolutionReason } from "./summarize";
import { PromptManager } from "./prompts";
import { BASE_RESEARCH_SYSTEM_PROMPT } from "./prompts/defaults";
import {
	SANDBOX_WORKSPACE_DIR,
	GIT_USER_NAME,
	GIT_USER_EMAIL,
	COMMIT_PREFIX,
	PR_TITLE_PREFIX,
	MAX_COMMIT_TASK_CHARS,
	MAX_PR_TITLE_TASK_CHARS,
	PR_BODY_HEADER,
	PR_BODY_FOOTER,
	TASK_TIMEOUT_MS,
	SANDBOX_INIT_MAX_RETRIES,
	SANDBOX_INIT_RETRY_DELAY_MS,
} from "./config/constants";

export interface SandboxTaskInput {
	taskId: string;
	repo: string;
	task: string;
	baseBranch?: string;
	repoConfig: RepoConfig | null;
	continueFrom?: { priorTaskId: string };
	auditContext?: string;
}

export interface TaskUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd: number;
	numTurns: number;
	durationMs?: number;
}

export interface SandboxTaskOutput {
	logs: string;
	diff: string;
	prUrl: string | null;
}

/**
 * Parse Claude Code's stream-json output to extract the final result with usage.
 * Each line is a JSON object; the last one with type="result" has cost/token data.
 */
export function parseClaudeUsage(logs: string): TaskUsage | null {
	let lastResult: any = null;

	for (const line of logs.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const obj = JSON.parse(trimmed);
			if (obj.type === "result") {
				lastResult = obj;
			}
		} catch {
			// not valid JSON, skip
		}
	}

	if (!lastResult) return null;

	const usage = lastResult.usage as Record<string, unknown> | undefined;

	// Aggregate tokens from modelUsage (per-model breakdown) as fallback
	let muIn = 0, muOut = 0, muCacheRead = 0, muCacheWrite = 0;
	if (lastResult.modelUsage && typeof lastResult.modelUsage === "object") {
		for (const m of Object.values(lastResult.modelUsage) as Record<string, number>[]) {
			muIn += m.inputTokens ?? 0;
			muOut += m.outputTokens ?? 0;
			muCacheRead += m.cacheReadInputTokens ?? 0;
			muCacheWrite += m.cacheCreationInputTokens ?? 0;
		}
	}

	const inputTokens = (lastResult.total_input_tokens
		?? (usage?.input_tokens as number | undefined)
		?? muIn) || 0;
	const outputTokens = (lastResult.total_output_tokens
		?? (usage?.output_tokens as number | undefined)
		?? muOut) || 0;
	const cacheReadTokens = (lastResult.total_cache_read_tokens
		?? (usage?.cache_read_input_tokens as number | undefined)
		?? muCacheRead) || undefined;
	const cacheWriteTokens = (lastResult.total_cache_creation_tokens
		?? (usage?.cache_creation_input_tokens as number | undefined)
		?? muCacheWrite) || undefined;
	const costUsd = lastResult.total_cost_usd ?? lastResult.cost_usd ?? lastResult.total_cost ?? 0;
	const numTurns = lastResult.num_turns ?? 0;

	if (inputTokens === 0 && outputTokens === 0 && costUsd === 0) return null;

	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		costUsd,
		numTurns,
		durationMs: lastResult.duration_ms ?? lastResult.total_duration_ms ?? undefined,
	};
}

const CLI_FAILURE_PATTERNS = [
	/argument '.*' is invalid/i,
	/Allowed choices are/i,
	/Unknown option/i,
	/unrecognized option/i,
	/ANTHROPIC_API_KEY.*not set/i,
	/command not found.*claude/i,
	/claude:.*not found/i,
	/Error: Cannot find module/i,
];

/**
 * Detect if the Claude CLI failed to start (bad flags, missing binary, etc.)
 * vs Claude running normally but producing no changes.
 * Returns the error message if a startup failure is detected, null otherwise.
 */
export function detectCliStartupFailure(logs: string): string | null {
	if (logs.length > 5000) return null;

	for (const pattern of CLI_FAILURE_PATTERNS) {
		if (pattern.test(logs)) {
			const errorLine = logs.split("\n").find((l) => pattern.test(l));
			return errorLine?.trim() ?? logs.trim().slice(0, 200);
		}
	}

	return null;
}

const WORKSPACE = SANDBOX_WORKSPACE_DIR;
const STEP_TIMEOUT_MS = 2 * 60 * 1000;

const TRANSIENT_ERROR_PATTERNS = [
	/container is starting/i,
	/sandbox.*not ready/i,
	/sandbox.*initializ/i,
	/sandbox init timed out/i,
	/EHOSTUNREACH/i,
	/ECONNREFUSED/i,
	/socket hang up/i,
];

function isTransientSandboxError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(msg));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(taskId: string, step: string, detail?: string) {
	const msg = detail ? `[${taskId}] ${step}: ${detail}` : `[${taskId}] ${step}`;
	console.log(msg);
}

type SandboxHandle = ReturnType<typeof getSandbox>;

/**
 * Acquire a sandbox and run `initFn`, retrying on transient errors.
 *
 * The SDK's BaseTransport already retries 503 "Container is starting" responses
 * with exponential backoff (up to containerTimeouts budget). We keep retries
 * bounded so the alarm handler doesn't block for too long — plan-level retry
 * (via alarm) handles repeated failures across separate alarm invocations.
 */
async function initSandboxWithRetry(
	env: Env,
	taskId: string,
	initFn: (sb: SandboxHandle) => Promise<void>,
): Promise<SandboxHandle> {
	let lastErr: unknown;
	const sb = getSandbox(env.Sandbox, taskId, { keepAlive: true });

	for (let attempt = 1; attempt <= SANDBOX_INIT_MAX_RETRIES; attempt++) {
		try {
			log(taskId, "sandbox-init", attempt > 1 ? `retry ${attempt}/${SANDBOX_INIT_MAX_RETRIES}` : undefined);
			// Race the init against a hard timeout so the alarm handler unblocks.
			// 90s allows for cold start (exec warmup ~30s) + git clone (~30s) + buffer.
			await Promise.race([
				initFn(sb),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("SandboxError: sandbox init timed out (90s)")), 90_000),
				),
			]);
			return sb;
		} catch (err) {
			lastErr = err;
			if (isTransientSandboxError(err) && attempt < SANDBOX_INIT_MAX_RETRIES) {
				const delayMs = SANDBOX_INIT_RETRY_DELAY_MS * attempt;
				log(taskId, "sandbox-retry", `attempt ${attempt}/${SANDBOX_INIT_MAX_RETRIES} failed (${err instanceof Error ? err.message : err}), waiting ${delayMs}ms`);
				await sleep(delayMs);
				continue;
			}
			throw err;
		}
	}

	throw lastErr;
}

/**
 * Phase 1 (test mode): No git — just start Claude with a simple prompt.
 * Use repo="test" to trigger this path.
 */
export async function startTestInSandbox(
	env: Env,
	taskId: string,
	task: string,
): Promise<{ processId: string }> {
	const sandbox = await initSandboxWithRetry(env, taskId, async (sb) => {
		await sb.setEnvVars({ ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY });
	});

	const claudeCmd = [
		`claude`,
		`-p "${task.replace(/"/g, '\\"')}"`,
		`--max-turns 2`,
		`--verbose`,
	].join(" ");

	const processId = `claude-${taskId}`;
	log(taskId, "test-claude-start", `cmd: ${claudeCmd}`);
	const proc = await sandbox.startProcess(claudeCmd, { processId });
	log(taskId, "test-claude-start", `pid=${proc.pid} status=${proc.status}`);

	return { processId };
}

export interface ResearchTaskInput {
	taskId: string;
	repo: string;
	task: string;
	baseBranch?: string;
	repoConfig: RepoConfig | null;
}

/**
 * Research mode: clone the repo read-only and run Claude to analyze the codebase.
 * No branch creation, no commits, no PRs. Output is captured from Claude's logs.
 */
export async function startResearchInSandbox(
	env: Env,
	input: ResearchTaskInput,
): Promise<{ processId: string; repoDir: string }> {
	const { taskId, repo, task, baseBranch, repoConfig } = input;
	const repoName = extractRepoName(repo);
	const repoDir = `${WORKSPACE}/${repoName}`;

	let systemPrompt = BASE_RESEARCH_SYSTEM_PROMPT;
	if (task) {
		systemPrompt += `\n\n# Specific Focus\n\nThe user is particularly interested in:\n${task}`;
	}

	const envVars: Record<string, string> = {
		ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
		COREPACK_ENABLE_STRICT: "0",
	};

	const t0 = Date.now();
	const sandbox = await initSandboxWithRetry(env, taskId, async (sb) => {
		console.log(`[${taskId}] research-init: setEnvVars (+${Date.now() - t0}ms)`);
		await sb.setEnvVars(envVars);

		await sb.exec("echo ready", { timeout: 30_000 });
		console.log(`[${taskId}] research-init: exec ready (+${Date.now() - t0}ms)`);

		for (const cmd of buildGitCredentialCommands(env.GITHUB_TOKEN)) {
			await sb.exec(cmd, { timeout: 30_000 });
		}

		const cloneUrl = buildAuthenticatedCloneUrl(repo, env.GITHUB_TOKEN);
		const cloneResult = await sb.exec(
			`git clone --depth 1 ${baseBranch ? `-b ${baseBranch}` : ""} ${cloneUrl} ${repoDir}`,
			{ timeout: 60_000 },
		);
		if (!cloneResult.success) {
			throw new Error(`Git clone failed: ${cloneResult.stderr}`);
		}
		console.log(`[${taskId}] research-init: clone done (+${Date.now() - t0}ms)`);
	});
	console.log(`[${taskId}] research-init: total ${Date.now() - t0}ms`);

	await sandbox.exec(`chown -R agent:agent ${repoDir}`, { timeout: STEP_TIMEOUT_MS });

	const promptPath = `${WORKSPACE}/.system-prompt`;
	await sandbox.writeFile(promptPath, systemPrompt);

	const claudeTimeoutSec = Math.floor(TASK_TIMEOUT_MS / 1000) - 60;
	const claudeCmd = [
		`cd ${repoDir}`,
		`&& gosu agent timeout ${claudeTimeoutSec}`,
		`claude`,
		`--append-system-prompt "$(cat ${promptPath})"`,
		`-p "Analyze this repository and produce a comprehensive codebase audit."`,
		`--permission-mode bypassPermissions`,
		`--max-turns 15`,
		`--output-format stream-json`,
		`--verbose`,
	].join(" ");

	const processId = `claude-${taskId}`;
	log(taskId, "research-start", `starting process ${processId}`);
	const proc = await sandbox.startProcess(claudeCmd, { processId });
	log(taskId, "research-start", `pid=${proc.pid} status=${proc.status}`);

	return { processId, repoDir };
}

/**
 * Phase 1: Set up sandbox, clone repo, start Claude as background process.
 * Returns the processId so the alarm-based poller can track it.
 */
export async function startClaudeInSandbox(
	env: Env,
	input: SandboxTaskInput,
): Promise<{ processId: string; repoDir: string; branchName: string }> {
	const { taskId, repo, task, baseBranch, repoConfig, continueFrom, auditContext } = input;
	const repoName = extractRepoName(repo);
	const repoDir = `${WORKSPACE}/${repoName}`;
	const branchName = buildBranchName(repoConfig, taskId);

	const pm = new PromptManager(env.SESSIONS_BUCKET);

	// Load continuation context from R2 if this is a continuation task
	let continuationContext: string | null = null;
	if (continueFrom) {
		try {
			const obj = await env.SESSIONS_BUCKET.get(`continuations/${taskId}.json`);
			if (obj) {
				continuationContext = await obj.text();
				log(taskId, "continuation", `loaded context (${continuationContext.length} chars)`);
			}
		} catch (err) {
			log(taskId, "continuation-warn", `failed to load context: ${err instanceof Error ? err.message : err}`);
		}
	}

	// Prompt resolution: R2 per-task prompt (set by plan) → fallback to task-level prompt
	let systemPrompt: string;
	const taskPrompt = await pm.loadTaskPrompt(taskId);
	if (taskPrompt) {
		systemPrompt = appendRepoContext(taskPrompt, repoConfig);
	} else {
		const { content } = await pm.load("task", repo);
		systemPrompt = appendRepoContext(content, repoConfig);
	}

	// Append continuation instructions to the system prompt
	if (continuationContext) {
		systemPrompt += [
			"",
			"",
			"## Continuation Context",
			"This task is a continuation of a prior attempt that failed or was incomplete.",
			"A file at /workspace/.continuation-context contains the previous session's",
			"diff, summary, error, and logs. Read it to understand what was already done",
			"and what went wrong. Resume from where the prior attempt left off — do not",
			"start over. The prior branch's changes are already in your working tree.",
		].join("\n");
	}

	// Inject cached audit context so the agent has architectural understanding
	if (auditContext) {
		systemPrompt += [
			"",
			"",
			"## Codebase Audit",
			"A prior analysis of this repository is available below. Use it to understand",
			"the project structure, tech stack, patterns, and architecture before making changes.",
			"",
			auditContext,
		].join("\n");
		log(taskId, "audit-context", `injected ${auditContext.length} chars of audit context`);
	}

	const commitMsg = `${COMMIT_PREFIX}${task.slice(0, MAX_COMMIT_TASK_CHARS)}`;
	const prTitle = `${PR_TITLE_PREFIX} ${task.slice(0, MAX_PR_TITLE_TASK_CHARS)}`;
	const prBody = [
		PR_BODY_HEADER,
		"",
		`**Task:** ${task}`,
		"",
		"---",
		PR_BODY_FOOTER,
	].join("\n");

	const envVars: Record<string, string> = {
		ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
		GH_TOKEN: env.GITHUB_TOKEN,
		_AGENT_TASK: task,
		_COMMIT_MSG: commitMsg,
		_PR_TITLE: prTitle,
		_PR_BODY: prBody,
		COREPACK_ENABLE_STRICT: "0",
	};

	if (env.RAILWAY_API_TOKEN && repoConfig?.platform === "railway") {
		envVars.RAILWAY_TOKEN = env.RAILWAY_API_TOKEN;
	}

	const t0 = Date.now();
	const sandbox = await initSandboxWithRetry(env, taskId, async (sb) => {
		console.log(`[${taskId}] sandbox-init: setEnvVars (+${Date.now() - t0}ms, prompt=${systemPrompt.length} chars)`);
		await sb.setEnvVars(envVars);
		console.log(`[${taskId}] sandbox-init: setEnvVars done (+${Date.now() - t0}ms), exec warmup...`);

		await sb.exec("echo ready", { timeout: 30_000 });
		console.log(`[${taskId}] sandbox-init: exec ready (+${Date.now() - t0}ms)`);

		for (const cmd of buildGitCredentialCommands(env.GITHUB_TOKEN)) {
			await sb.exec(cmd, { timeout: 30_000 });
		}
		const promptPath = `${WORKSPACE}/.system-prompt`;
		await sb.writeFile(promptPath, systemPrompt);
		console.log(`[${taskId}] sandbox-init: prompt written (+${Date.now() - t0}ms, ${systemPrompt.length} chars)`);

		// Write continuation context file if present
		if (continuationContext) {
			await sb.writeFile(`${WORKSPACE}/.continuation-context`, continuationContext);
			console.log(`[${taskId}] sandbox-init: continuation context written (+${Date.now() - t0}ms)`);
		}

		console.log(`[${taskId}] sandbox-init: git creds done (+${Date.now() - t0}ms)`);

		const cloneUrl = buildAuthenticatedCloneUrl(repo, env.GITHUB_TOKEN);
		const cloneResult = await sb.exec(
			`git clone --depth 1 ${baseBranch ? `-b ${baseBranch}` : ""} ${cloneUrl} ${repoDir}`,
			{ timeout: 60_000 },
		);
		if (!cloneResult.success) {
			throw new Error(`Git clone failed: ${cloneResult.stderr}`);
		}
		console.log(`[${taskId}] sandbox-init: clone done (+${Date.now() - t0}ms)`);
	});
	console.log(`[${taskId}] sandbox-init: total ${Date.now() - t0}ms`);

	// Clean up R2 copies now that they're in the container
	pm.deleteTaskPrompt(taskId).catch(() => {});
	if (continueFrom) {
		env.SESSIONS_BUCKET.delete(`continuations/${taskId}.json`).catch(() => {});
	}

	// Hand ownership to non-root 'agent' user so Claude Code accepts bypassPermissions
	await sandbox.exec(`chown -R agent:agent ${repoDir}`, { timeout: STEP_TIMEOUT_MS });

	log(taskId, "git-setup");
	await sandbox.exec(`gosu agent git -C ${repoDir} config user.name "${GIT_USER_NAME}"`, { timeout: STEP_TIMEOUT_MS });
	await sandbox.exec(`gosu agent git -C ${repoDir} config user.email "${GIT_USER_EMAIL}"`, { timeout: STEP_TIMEOUT_MS });
	await sandbox.exec(`gosu agent git -C ${repoDir} fetch --unshallow || true`, { timeout: STEP_TIMEOUT_MS });
	await sandbox.exec(`gosu agent git -C ${repoDir} checkout -b ${branchName}`, { timeout: STEP_TIMEOUT_MS });

	log(taskId, "git-push-branch", "pushing branch to remote immediately");
	await sandbox.exec(`gosu agent git -C ${repoDir} push origin ${branchName}`, { timeout: STEP_TIMEOUT_MS });

	const promptPath = `${WORKSPACE}/.system-prompt`;
	const claudeTimeoutSec = Math.floor(TASK_TIMEOUT_MS / 1000) - 60;
	const claudeCmd = [
		`cd ${repoDir}`,
		`&& gosu agent timeout ${claudeTimeoutSec}`,
		`claude`,
		`--append-system-prompt "$(cat ${promptPath})"`,
		`-p "$_AGENT_TASK"`,
		`--permission-mode bypassPermissions`,
		`--max-turns 30`,
		`--output-format stream-json`,
		`--verbose`,
	].join(" ");

	const processId = `claude-${taskId}`;
	log(taskId, "claude-start", `starting process ${processId}`);
	const proc = await sandbox.startProcess(claudeCmd, { processId });
	log(taskId, "claude-start", `pid=${proc.pid} status=${proc.status}`);

	return { processId, repoDir, branchName };
}

/**
 * Phase 2a: Poll Claude's logs. Called from alarm handler.
 * Returns { done, logs } where done=true means Claude has exited.
 */
export async function pollClaudeLogs(
	env: Env,
	taskId: string,
	processId: string,
	lastLogLen: number,
): Promise<{ done: boolean; logs: string; newContent: string; totalLen: number }> {
	const sandbox = getSandbox(env.Sandbox, taskId, { keepAlive: true });

	try {
		const proc = await sandbox.getProcess(processId);
		if (!proc) {
			log(taskId, "poll", "process not found");
			return { done: true, logs: "", newContent: "", totalLen: lastLogLen };
		}

		const { stdout, stderr } = await proc.getLogs();
		const combined = stdout + stderr;
		const newContent = combined.length > lastLogLen ? combined.slice(lastLogLen) : "";

		if (newContent) {
			const preview = newContent.replace(/\n/g, "\\n").slice(0, 500);
			log(taskId, "claude-live", `+${newContent.length} chars (total ${combined.length}): ${preview}`);
		}

		const status = await proc.getStatus();
		const done = status === "completed" || status === "failed" || status === "killed";

		if (done) {
			log(taskId, "claude-exit", `status=${status} total=${combined.length} chars`);
		}

		return { done, logs: combined, newContent, totalLen: combined.length };
	} catch (err) {
		log(taskId, "poll-error", err instanceof Error ? err.message : String(err));
		return { done: false, logs: "", newContent: "", totalLen: lastLogLen };
	}
}

/**
 * Phase 2b: After Claude finishes, commit + push + PR with a rich description.
 */
export async function finalizeSandboxTask(
	env: Env,
	taskId: string,
	repoDir: string,
	branchName: string,
	baseBranch: string | undefined,
	claudeLogs: string,
	taskDescription: string,
): Promise<{ diff: string; prUrl: string | null; summary: string }> {
	const sandbox = getSandbox(env.Sandbox, taskId, { keepAlive: true });

	try {
		// Stage and commit any remaining uncommitted changes
		log(taskId, "git-add");
		await sandbox.exec(`gosu agent git -C ${repoDir} add -A`, { timeout: STEP_TIMEOUT_MS });

		const stagedCheck = await sandbox.exec(
			`gosu agent git -C ${repoDir} diff --cached --quiet`,
			{ timeout: STEP_TIMEOUT_MS },
		);
		if (!stagedCheck.success) {
			log(taskId, "git-commit", "committing remaining staged changes");
			await sandbox.exec(`cd ${repoDir} && gosu agent git commit -m "$_COMMIT_MSG"`, { timeout: STEP_TIMEOUT_MS });
		}

		log(taskId, "git-push");
		await sandbox.exec(`gosu agent git -C ${repoDir} push origin ${branchName}`, { timeout: STEP_TIMEOUT_MS });

		// Compare branch against base to find ALL changes (including those Claude already committed)
		const target = baseBranch || "main";
		log(taskId, "git-diff", `comparing ${branchName} against origin/${target}`);
		const diffResult = await sandbox.exec(
			`gosu agent git -C ${repoDir} diff origin/${target}...${branchName}`,
			{ timeout: STEP_TIMEOUT_MS },
		);
		const diff = diffResult.success ? diffResult.stdout : diffResult.stderr;

		if (!diff.trim()) {
			log(taskId, "no-changes");
			let reason = "No code changes were produced.";
			try {
				reason = await generateNoSolutionReason(env.ANTHROPIC_API_KEY, taskDescription, claudeLogs);
			} catch (err) {
				log(taskId, "summarize-error", err instanceof Error ? err.message : String(err));
			}
			return { diff: "", prUrl: null, summary: reason };
		}

		log(taskId, "summarize");
		let prBody: string;
		try {
			prBody = await generatePRSummary(env.ANTHROPIC_API_KEY, taskDescription, diff, claudeLogs);
		} catch (err) {
			log(taskId, "summarize-error", err instanceof Error ? err.message : String(err));
			prBody = [PR_BODY_HEADER, "", `**Task:** ${taskDescription}`, "", "---", PR_BODY_FOOTER].join("\n");
		}

		log(taskId, "pr-create");
		const prBodyFile = "/tmp/pr-body.md";
		await sandbox.exec(`cat > ${prBodyFile} << 'PRBODYEOF'\n${prBody}\nPRBODYEOF`, { timeout: STEP_TIMEOUT_MS });

		const prParts = [
			`cd ${repoDir}`,
			`&& gosu agent gh pr create`,
			`--title "$_PR_TITLE"`,
			`--body-file ${prBodyFile}`,
			`--head ${branchName}`,
		];
		if (baseBranch) {
			prParts.push(`--base ${baseBranch}`);
		}

		const prResult = await sandbox.exec(prParts.join(" "), { timeout: STEP_TIMEOUT_MS });
		const prUrl = prResult.success ? prResult.stdout.trim() : null;
		if (!prResult.success) {
			log(taskId, "pr-create-failed", prResult.stderr);
		}
		log(taskId, "pr-create", `success=${prResult.success} url=${prUrl ?? "none"}`);

		return { diff, prUrl, summary: prBody };
	} finally {
		try {
			await sandbox.destroy();
		} catch (destroyErr) {
			console.error(`[${taskId}] sandbox.destroy() failed:`, destroyErr);
		}
	}
}

/**
 * Checkpoint: stage + commit + push any uncommitted work.
 * Called periodically during polling and as a salvage attempt before destroy.
 * Returns whether a commit was actually made (i.e. there were changes).
 */
export async function checkpointSandbox(
	env: Env,
	taskId: string,
	repoDir: string,
	branchName: string,
): Promise<{ committed: boolean }> {
	const sandbox = getSandbox(env.Sandbox, taskId, { keepAlive: true });
	try {
		await sandbox.exec(`gosu agent git -C ${repoDir} add -A`, { timeout: STEP_TIMEOUT_MS });
		const diffCheck = await sandbox.exec(
			`gosu agent git -C ${repoDir} diff --cached --quiet`,
			{ timeout: STEP_TIMEOUT_MS },
		);
		if (diffCheck.success) {
			return { committed: false };
		}

		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const commitResult = await sandbox.exec(
			`cd ${repoDir} && gosu agent git commit -m "wip: checkpoint ${ts}"`,
			{ timeout: STEP_TIMEOUT_MS },
		);
		if (!commitResult.success) {
			log(taskId, "checkpoint-commit-fail", commitResult.stderr);
			return { committed: false };
		}

		const pushResult = await sandbox.exec(
			`gosu agent git -C ${repoDir} push origin ${branchName}`,
			{ timeout: STEP_TIMEOUT_MS },
		);
		if (!pushResult.success) {
			log(taskId, "checkpoint-push-fail", pushResult.stderr);
		}

		log(taskId, "checkpoint", "committed and pushed work-in-progress");
		return { committed: true };
	} catch (err) {
		log(taskId, "checkpoint-error", err instanceof Error ? err.message : String(err));
		return { committed: false };
	}
}

export async function destroySandbox(env: Env, taskId: string): Promise<void> {
	try {
		const sandbox = getSandbox(env.Sandbox, taskId, { keepAlive: true });
		await sandbox.destroy();
	} catch (err) {
		console.error(`[${taskId}] sandbox.destroy() failed:`, err);
	}
}
