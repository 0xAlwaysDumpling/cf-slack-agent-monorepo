/**
 * GitHub helpers for sandbox authentication and PR operations.
 *
 * The `gh` CLI reads GH_TOKEN from the environment for auth.
 * Git clone uses the token embedded in the HTTPS URL.
 */

export function buildAuthenticatedCloneUrl(repoUrl: string, token: string): string {
	if (repoUrl.includes("@")) return repoUrl;
	return `https://${token}@${repoUrl.replace("https://", "")}`;
}

export function buildGitCredentialCommands(token: string): string[] {
	return [
		// Set up credentials for both root (clone phase) and agent user (Claude + finalize)
		`git config --global credential.helper store`,
		`echo "https://${token}@github.com" > ~/.git-credentials`,
		`gosu agent git config --global credential.helper store`,
		`mkdir -p /home/agent && echo "https://${token}@github.com" > /home/agent/.git-credentials && chown agent:agent /home/agent/.git-credentials`,
		`gosu agent git config --global safe.directory '*'`,
	];
}

export function buildPRCreateCommand(opts: {
	repoDir: string;
	branchName: string;
	title: string;
	body: string;
	baseBranch?: string;
}): string {
	const escapedTitle = opts.title.replace(/"/g, '\\"');
	const escapedBody = opts.body.replace(/"/g, '\\"');

	const parts = [
		`cd ${opts.repoDir}`,
		`&& gh pr create`,
		`--title "${escapedTitle}"`,
		`--body "${escapedBody}"`,
		`--head ${opts.branchName}`,
	];

	if (opts.baseBranch) {
		parts.push(`--base ${opts.baseBranch}`);
	}

	return parts.join(" ");
}

export function extractOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
	const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
	if (!match) return null;
	return { owner: match[1], repo: match[2] };
}
