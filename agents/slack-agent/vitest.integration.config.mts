import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		include: ["test/messages/integration.spec.ts"],
		poolOptions: {
			workers: {
				miniflare: {
					r2Buckets: ["MESSAGES_BUCKET"],
					d1Databases: ["JOBS_DB"],
					serviceBindings: {
						DEV_AGENT: () => new Response(JSON.stringify({ stubbed: true }), {
							headers: { "Content-Type": "application/json" },
						}),
					},
				},
				main: "./src/index.ts",
				singleWorker: true,
			},
		},
	},
});
