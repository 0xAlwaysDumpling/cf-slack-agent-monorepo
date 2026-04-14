import type { ServiceConfig } from "../index";
import { GITHUB_API_BASE_URL } from "../../config/constants";

export const githubService: ServiceConfig = {
	target: GITHUB_API_BASE_URL,

	validate: (req) =>
		req.headers.get("Authorization")?.replace("Bearer ", "") ?? null,

	transform: async (req, ctx) => {
		req.headers.set("Authorization", `Bearer ${ctx.env.GITHUB_TOKEN}`);
		return req;
	},
};
