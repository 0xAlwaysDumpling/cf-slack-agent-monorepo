import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
			"test/messages/store.spec.ts",
			"test/messages/context.spec.ts",
			"test/messages/history-tools.spec.ts",
			"test/tools/discovery.spec.ts",
			"test/tools/cache.spec.ts",
			"test/prompts/**/*.spec.ts",
			"test/work/**/*.spec.ts",
		],
	},
});
