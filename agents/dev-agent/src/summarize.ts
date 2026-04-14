import { ANTHROPIC_API_BASE_URL } from "./config/constants";

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string;
}

async function callAnthropic(
	apiKey: string,
	system: string,
	messages: AnthropicMessage[],
): Promise<string> {
	const res = await fetch(`${ANTHROPIC_API_BASE_URL}/v1/messages`, {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: "claude-sonnet-4-20250514",
			max_tokens: 1024,
			system,
			messages,
		}),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Anthropic API error ${res.status}: ${text}`);
	}

	const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
	return data.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("");
}

/**
 * Generate a rich PR description from the task, diff, and Claude's logs.
 * Returns markdown suitable for a GitHub PR body.
 */
export async function generatePRSummary(
	apiKey: string,
	task: string,
	diff: string,
	logs: string,
): Promise<string> {
	const trimmedDiff = diff.slice(0, 8000);
	const trimmedLogs = logs.slice(-4000);

	const system = `You are a senior engineer writing a clear, concise GitHub PR description. 
Output ONLY the markdown body — no title, no fences. Use these sections:
## Summary
Brief explanation of what was changed and why.
## Changes
Bullet list of specific changes made (reference file names).
## Notes
Any caveats, trade-offs, or follow-up items. Omit this section if there are none.`;

	const userMsg = `Task requested: ${task}

Git diff (may be truncated):
\`\`\`
${trimmedDiff}
\`\`\`

Agent logs (tail):
\`\`\`
${trimmedLogs}
\`\`\``;

	return callAnthropic(apiKey, system, [{ role: "user", content: userMsg }]);
}

/**
 * When Claude made no changes, generate an explanation of why.
 */
export async function generateNoSolutionReason(
	apiKey: string,
	task: string,
	logs: string,
): Promise<string> {
	const trimmedLogs = logs.slice(-6000);

	const system = `You are a senior engineer explaining why an automated agent was unable to complete a task.
Be honest and specific. Output a short (2-5 sentence) explanation. Include:
- What the agent attempted
- Why it couldn't make changes (couldn't reproduce, unclear requirements, etc.)
- Suggested next steps`;

	const userMsg = `Task requested: ${task}

Agent logs (tail):
\`\`\`
${trimmedLogs}
\`\`\`

The agent exited without making any code changes. Explain why.`;

	return callAnthropic(apiKey, system, [{ role: "user", content: userMsg }]);
}
