/**
 * Augments the Wrangler-generated Env interface with secrets (set via
 * `wrangler secret put`) and marks bindings that are always present at
 * runtime as non-optional.
 *
 * wrangler types marks DO/service bindings as optional because they
 * *could* differ per environment, but in practice they're always bound.
 * Secrets never appear in wrangler.jsonc so they're missing entirely.
 */

interface Env {
	// Secrets (wrangler secret put)
	ANTHROPIC_API_KEY: string;
	FIREWORKS_API_KEY: string;
	GITHUB_TOKEN: string;
	PROXY_JWT_SECRET: string;
	RAILWAY_API_TOKEN?: string;

	// Override optional → required for bindings that are always present
	Sandbox: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
	DevAgent: DurableObjectNamespace<import("./agent").DevAgent>;
	SLACK_AGENT: Fetcher;
	SESSIONS_BUCKET: R2Bucket;
}
