/**
 * MCP handlers for Cloudflare Pages project management.
 * Creates Pages projects connected to GitHub repos for auto-deploy on push.
 */

import type { ToolDefinition, ToolContext, ToolExecutionParams, MCPToolResult } from "../types";
import { GITHUB_ORG } from "../../config/constants";

function text(content: string): MCPToolResult {
  return { type: "text", content };
}

function getCFHeaders(env: any): Record<string, string> | null {
  const token = env.CF_API_TOKEN || env.CF_AIG_TOKEN;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export function createPagesMCPTools(): ToolDefinition[] {
  return [
    {
      name: "pages.create-project",
      description:
        `Create a Cloudflare Pages project linked to a GitHub repo for auto-deploy on push. Supports monorepos — set root_dir to the app subfolder (e.g. "packages/web"). The repo must already exist and the Cloudflare Pages GitHub App must be installed on the org (${GITHUB_ORG}). Use this for existing repos or when github.create-repo didn't auto-create a Pages project.`,
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Pages project name (usually same as repo name). Becomes <name>.pages.dev.",
          },
          repo_name: {
            type: "string",
            description: "GitHub repo name (without org prefix).",
          },
          owner: {
            type: "string",
            description: `GitHub org or user that owns the repo. Defaults to ${GITHUB_ORG}.`,
          },
          production_branch: {
            type: "string",
            description: "Branch for production deploys. Defaults to main.",
          },
          build_command: {
            type: "string",
            description: 'Build command. Defaults to "pnpm build".',
          },
          build_output_dir: {
            type: "string",
            description: 'Build output directory relative to root_dir. Defaults to "dist".',
          },
          root_dir: {
            type: "string",
            description:
              'Root directory of the app within the repo (for monorepos). E.g. "packages/web" or "apps/frontend". Defaults to "/" (repo root). The build_command runs from this directory.',
          },
        },
        required: ["name", "repo_name"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const env = context.env;
        const headers = getCFHeaders(env);
        if (!headers || !env.CF_ACCOUNT_ID) {
          return text(JSON.stringify({ error: "CF_API_TOKEN / CF_ACCOUNT_ID not configured" }));
        }

        const name = (params.name as string).trim();
        const repoName = (params.repo_name as string).trim();
        const owner = ((params.owner as string | undefined)?.trim() || GITHUB_ORG);
        const branch = ((params.production_branch as string | undefined)?.trim() || "main");
        const buildCmd = ((params.build_command as string | undefined)?.trim() || "pnpm build");
        const outputDir = ((params.build_output_dir as string | undefined)?.trim() || "dist");
        const rootDir = ((params.root_dir as string | undefined)?.trim() || "/");

        const body = {
          name,
          production_branch: branch,
          source: {
            type: "github",
            config: {
              owner,
              repo_name: repoName,
              production_branch: branch,
              pr_comments_enabled: true,
              deployments_enabled: true,
              production_deployment_enabled: true,
              preview_deployment_setting: "all",
            },
          },
          build_config: {
            build_command: buildCmd,
            destination_dir: outputDir,
            root_dir: rootDir,
          },
        };

        try {
          const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects`;
          const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          });

          const data = await res.json() as {
            success: boolean;
            result?: {
              name: string;
              subdomain: string;
              domains: string[];
              source?: { type: string };
              build_config?: { build_command: string };
            };
            errors?: Array<{ code: number; message: string }>;
          };

          if (!data.success) {
            const errMsg = data.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || "Unknown error";
            return text(JSON.stringify({ error: "Failed to create Pages project", details: errMsg }));
          }

          return text(
            JSON.stringify({
              ok: true,
              name: data.result!.name,
              url: `https://${data.result!.subdomain}`,
              domains: data.result!.domains,
              source: data.result!.source?.type,
              build_command: data.result!.build_config?.build_command,
            })
          );
        } catch (error) {
          return text(
            JSON.stringify({
              error: "Failed to create Pages project",
              details: error instanceof Error ? error.message : String(error),
            })
          );
        }
      },
    },
  ];
}
