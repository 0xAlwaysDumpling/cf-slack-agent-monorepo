import type { RepoConfig } from "./types";
import { DEFAULT_BRANCH_PREFIX, DEFAULT_GIT_BRANCH } from "./config/constants";
import { BASE_SYSTEM_PROMPT } from "./prompts/defaults";

export const PLATFORM_PROMPTS: Record<RepoConfig["platform"], string> = {
	railway: [
		"This project is deployed on Railway.",
		"You have the Railway CLI available via `railway`.",
		"Use `railway logs` to check runtime logs and `railway status` for deployment info.",
		"The project is linked via RAILWAY_TOKEN env var.",
		"Check railway.json or Procfile for deployment config.",
	].join(" "),

	"cloudflare-workers": [
		"This is a Cloudflare Workers project.",
		"Use wrangler for deployment.",
		"Check wrangler.jsonc for bindings and configuration.",
		"You have access to CF API tools for logs.",
	].join(" "),

	generic: "",
};

/**
 * Append platform-specific and repo-override snippets to a base prompt.
 * Used by both the legacy path and the new PromptManager integration.
 */
export function appendRepoContext(basePrompt: string, config: RepoConfig | null): string {
	const parts = [basePrompt];

	if (config) {
		const platformPrompt = PLATFORM_PROMPTS[config.platform];
		if (platformPrompt) parts.push(platformPrompt);
		if (config.systemPromptOverride) parts.push(config.systemPromptOverride);
	}

	return parts.join("\n\n");
}

/**
 * @deprecated Use PromptManager.load() + appendRepoContext() instead.
 * Kept for backward compatibility during migration.
 */
export function getSystemPromptForRepo(config: RepoConfig | null): string {
	return appendRepoContext(BASE_SYSTEM_PROMPT, config);
}

export function extractRepoName(repoUrl: string): string {
	const cleaned = repoUrl.replace(/\.git$/, "");
	const name = cleaned.split("/").pop() ?? "repo";
	return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function buildBranchName(config: RepoConfig | null, taskId: string): string {
	const prefix = config?.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
	return `${prefix}${taskId}`;
}

export function getDefaultBranch(config: RepoConfig | null): string {
	return config?.defaultBranch ?? DEFAULT_GIT_BRANCH;
}
