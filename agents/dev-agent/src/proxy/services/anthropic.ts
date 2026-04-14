import type { ServiceConfig } from "../index";
import { ANTHROPIC_API_BASE_URL } from "../../config/constants";

export const anthropicService: ServiceConfig = {
	target: ANTHROPIC_API_BASE_URL,

	validate: (req) =>
		req.headers.get("x-api-key") ?? null,

	transform: async (req, ctx) => {
		req.headers.set("x-api-key", ctx.env.ANTHROPIC_API_KEY);
		return req;
	},
};
