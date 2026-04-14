import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					serviceBindings: {
						DEV_AGENT: () => new Response(JSON.stringify({ stubbed: true }), {
							headers: { "Content-Type": "application/json" },
						}),
					},
				},
			},
		},
	},
});
