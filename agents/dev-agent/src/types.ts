export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface TaskRequest {
	repo: string;
	task: string;
	branch?: string;
	planId?: string;
	continueFromTaskId?: string;
	mode?: "default" | "research";
}

// ---------------------------------------------------------------------------
// Plans & Chains
// ---------------------------------------------------------------------------

export type PlanStatus = "draft" | "running" | "completed" | "failed";

export type PlanStepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "merged";

export interface PlanStep {
	id: string;
	description: string;
	taskId?: string;
	branchName?: string;
	prUrl?: string;
	prNumber?: number;
	status: PlanStepStatus;
	retryCount?: number;
	continueFromTaskId?: string;
}

export interface Plan {
	id: string;
	repo: string;
	name: string;
	steps: PlanStep[];
	status: PlanStatus;
	branch: string;
	currentStepIndex: number;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface PlanResult {
	id: string;
	repo: string;
	name: string;
	steps: PlanStep[];
	status: PlanStatus;
	branch: string;
	currentStepIndex: number;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface PlanRequest {
	repo: string;
	name: string;
	steps: string[];
	branch?: string;
}

export interface PlanUpdateRequest {
	steps?: Array<{ id?: string; description: string }>;
	name?: string;
}

export type TaskOutcome = "pr_created" | "no_changes" | "error" | "timeout" | "cancelled" | "research_complete";

export interface AuditResult {
	id: string;
	repo: string;
	createdAt: string;
	analysis: string;
	taskId: string;
}

export interface TaskUsageResult {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd: number;
	numTurns: number;
	durationMs?: number;
}

export interface TaskResult {
	id: string;
	status: TaskStatus;
	repo: string;
	task: string;
	branch: string;
	createdAt: string;
	updatedAt: string;
	step?: string;
	logs?: string;
	diff?: string;
	prUrl?: string;
	error?: string;
	summary?: string;
	outcome?: TaskOutcome;
	usage?: TaskUsageResult;
	priorTaskId?: string;
	/** True when this result is a dedup rejection pointing at an existing task */
	duplicate?: boolean;
}

export interface RepoConfig {
	repoUrl: string;
	platform: "railway" | "cloudflare-workers" | "generic";
	defaultBranch: string;
	branchPrefix: string;
	systemPromptOverride?: string;
	deployCommand?: string;
	testCommand?: string;

	railway?: {
		projectId: string;
		environmentId: string;
		serviceIds?: Record<string, string>;
	};

	cloudflare?: {
		accountId: string;
		workerName: string;
	};
}
