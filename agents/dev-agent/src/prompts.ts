import type { PlanStep } from "./types";
import { BASE_SYSTEM_PROMPT, BASE_PLAN_SYSTEM_PROMPT, GUARDRAILS } from "./prompts/defaults";

const R2_PREFIX = "prompts";

export interface PlanStepContext {
	stepNumber: number;
	totalSteps: number;
	planName: string;
	planId: string;
	steps: PlanStep[];
	currentStepDescription: string;
	previousStepBranch?: string;
}

export interface StoredPromptMeta {
	key: string;
	type: string;
	scope: string;
	size: number;
	updatedAt: string;
}

function repoKey(repoUrl: string): string {
	return repoUrl
		.replace(/^https?:\/\//, "")
		.replace(/\.git$/, "")
		.replace(/\//g, "-")
		.toLowerCase();
}

function r2Key(type: "task" | "plan", repo?: string): string {
	const scope = repo ? repoKey(repo) : "default";
	return `${R2_PREFIX}/${type}/${scope}.md`;
}

function parseR2Key(key: string): { type: string; scope: string } | null {
	const match = key.match(/^prompts\/(task|plan)\/(.+)\.md$/);
	if (!match) return null;
	return { type: match[1], scope: match[2] };
}

export class PromptManager {
	constructor(private bucket: R2Bucket) {}

	/**
	 * Load prompt with fallback chain:
	 *   1. Per-repo R2 prompt
	 *   2. Default R2 prompt
	 *   3. Hardcoded constant
	 */
	async load(
		type: "task" | "plan",
		repoUrl?: string,
	): Promise<{ content: string; source: "repo" | "default" | "hardcoded" }> {
		if (repoUrl) {
			const repoPrompt = await this.get(type, repoUrl);
			if (repoPrompt) return { content: repoPrompt + GUARDRAILS, source: "repo" };
		}

		const defaultPrompt = await this.get(type);
		if (defaultPrompt) return { content: defaultPrompt + GUARDRAILS, source: "default" };

		const hardcoded = type === "plan" ? BASE_PLAN_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT;
		return { content: hardcoded, source: "hardcoded" };
	}

	async get(type: "task" | "plan", repoUrl?: string): Promise<string | null> {
		try {
			const obj = await this.bucket.get(r2Key(type, repoUrl));
			if (!obj) return null;
			return obj.text();
		} catch {
			return null;
		}
	}

	async save(type: "task" | "plan", content: string, repoUrl?: string): Promise<void> {
		const key = r2Key(type, repoUrl);
		await this.bucket.put(key, content, {
			customMetadata: {
				type,
				scope: repoUrl ? repoKey(repoUrl) : "default",
				updatedAt: new Date().toISOString(),
			},
		});
	}

	async delete(type: "task" | "plan", repoUrl?: string): Promise<boolean> {
		const key = r2Key(type, repoUrl);
		const exists = await this.bucket.head(key);
		if (!exists) return false;
		await this.bucket.delete(key);
		return true;
	}

	async list(): Promise<StoredPromptMeta[]> {
		const listed = await this.bucket.list({ prefix: `${R2_PREFIX}/` });
		const results: StoredPromptMeta[] = [];

		for (const obj of listed.objects) {
			const parsed = parseR2Key(obj.key);
			if (!parsed) continue;
			results.push({
				key: obj.key,
				type: parsed.type,
				scope: parsed.scope,
				size: obj.size,
				updatedAt: obj.uploaded.toISOString(),
			});
		}

		return results;
	}

	async saveTaskPrompt(taskId: string, content: string): Promise<void> {
		await this.bucket.put(`${R2_PREFIX}/tasks/${taskId}.md`, content);
	}

	async loadTaskPrompt(taskId: string): Promise<string | null> {
		try {
			const obj = await this.bucket.get(`${R2_PREFIX}/tasks/${taskId}.md`);
			return obj ? obj.text() : null;
		} catch {
			return null;
		}
	}

	async deleteTaskPrompt(taskId: string): Promise<void> {
		try { await this.bucket.delete(`${R2_PREFIX}/tasks/${taskId}.md`); } catch { /* best effort */ }
	}

	/**
	 * Build the full system prompt for a plan step.
	 * Prepends plan context to the base prompt.
	 */
	buildPlanPrompt(basePrompt: string, ctx: PlanStepContext): string {
		const stepLines = ctx.steps.map((s, i) => {
			const num = i + 1;
			const marker = num === ctx.stepNumber ? ">>>" : "   ";
			const prInfo = s.prUrl ? ` -- PR: ${s.prUrl}` : "";
			return `${marker} ${num}. [${s.status}] ${s.description}${prInfo}`;
		});

		const planContext = [
			"# Plan Context",
			"",
			`You are executing step ${ctx.stepNumber} of ${ctx.totalSteps} in plan "${ctx.planName}" (${ctx.planId}).`,
			"",
			"## All Steps",
			...stepLines,
			"",
		];

		if (ctx.previousStepBranch) {
			planContext.push(
				"## Working Tree",
				`The previous step's changes are already in your working tree (branched from \`${ctx.previousStepBranch}\`).`,
				"Do NOT revert or undo changes from previous steps unless they are broken.",
				"",
			);
		}

		planContext.push(
			`## Your Assignment`,
			`Focus exclusively on this step: ${ctx.currentStepDescription}`,
			"Do not implement future steps.",
			"",
			"---",
			"",
		);

		return planContext.join("\n") + basePrompt;
	}
}
