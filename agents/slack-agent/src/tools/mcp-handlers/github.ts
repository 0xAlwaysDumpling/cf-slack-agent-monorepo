/**
 * MCP handlers for GitHub integration.
 * Uses the GitHub REST API to search/list repos and get repo info.
 */

import type { ToolDefinition, ToolContext, ToolExecutionParams, MCPToolResult } from "../types";
import {
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  GITHUB_ORG,
  AGENT_ID,
  GITHUB_REPOS_PER_PAGE,
  GITHUB_BRANCHES_PER_PAGE,
  GITHUB_OPEN_PRS_PER_PAGE,
} from "../../config/constants";
import sodium from "libsodium-wrappers";

function text(content: string): MCPToolResult {
  return { type: "text", content };
}

async function githubRequest<T = unknown>(
  token: string,
  path: string
): Promise<T> {
  const res = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": AGENT_ID,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error (${res.status}): ${body}`);
  }

  return res.json() as Promise<T>;
}

async function githubPost<T = unknown>(
  token: string,
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": AGENT_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GitHub API error (${res.status}): ${errBody}`);
  }

  return res.json() as Promise<T>;
}

async function githubPut(
  token: string,
  path: string,
  body: Record<string, unknown>
): Promise<void> {
  const res = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    method: "PUT",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": AGENT_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GitHub API error (${res.status}): ${errBody}`);
  }
}

async function githubPatch<T = unknown>(
  token: string,
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": AGENT_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GitHub API error (${res.status}): ${errBody}`);
  }

  return res.json() as Promise<T>;
}

async function setRepoSecret(
  token: string,
  repo: string,
  secretName: string,
  secretValue: string,
): Promise<void> {
  await sodium.ready;

  const { key, key_id } = await githubRequest<{ key: string; key_id: string }>(
    token,
    `/repos/${repo}/actions/secrets/public-key`,
  );

  const keyBytes = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const messageBytes = sodium.from_string(secretValue);
  const encryptedBytes = sodium.crypto_box_seal(messageBytes, keyBytes);
  const encrypted = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);

  await githubPut(token, `/repos/${repo}/actions/secrets/${secretName}`, {
    encrypted_value: encrypted,
    key_id,
  });
}

type GHRepo = {
  full_name: string;
  html_url: string;
  description: string | null;
  default_branch: string;
  private: boolean;
  language: string | null;
  updated_at: string;
};

export function createGitHubMCPTools(): ToolDefinition[] {
  return [
    {
      name: "github.repos",
      description:
        "List repositories for an organization or the authenticated user. Use this to find repo URLs before creating dev tasks.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          org: {
            type: "string",
            description: `GitHub org name (e.g. ${GITHUB_ORG}). If omitted, lists repos for the authenticated user.`,
          },
          query: {
            type: "string",
            description: "Optional search/filter term to match against repo names.",
          },
        },
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.GITHUB_TOKEN;
        if (!token) return text(JSON.stringify({ error: "GITHUB_TOKEN not configured" }));

        try {
          const org = params.org as string | undefined;
          const query = (params.query as string | undefined)?.toLowerCase();

          const path = org
            ? `/orgs/${org}/repos?per_page=${GITHUB_REPOS_PER_PAGE}&sort=updated&direction=desc`
            : `/user/repos?per_page=${GITHUB_REPOS_PER_PAGE}&sort=updated&direction=desc&affiliation=owner,organization_member`;

          const repos = await githubRequest<GHRepo[]>(token, path);

          let filtered = repos;
          if (query) {
            filtered = repos.filter(
              (r) =>
                r.full_name.toLowerCase().includes(query) ||
                (r.description?.toLowerCase().includes(query) ?? false)
            );
          }

          const summary = filtered.slice(0, 25).map((r) => ({
            name: r.full_name,
            url: r.html_url,
            description: r.description,
            default_branch: r.default_branch,
            private: r.private,
            language: r.language,
            updated: r.updated_at,
          }));

          return text(JSON.stringify({ count: summary.length, repos: summary }));
        } catch (error) {
          return text(
            JSON.stringify({
              error: "Failed to list repos",
              details: error instanceof Error ? error.message : String(error),
            })
          );
        }
      },
    },

    {
      name: "github.repo-info",
      description: "Get detailed info about a specific GitHub repository including branches, recent commits, and open PRs.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: `Full repo name (e.g. ${GITHUB_ORG}/apyfarm) or URL`,
          },
        },
        required: ["repo"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.GITHUB_TOKEN;
        if (!token) return text(JSON.stringify({ error: "GITHUB_TOKEN not configured" }));

        try {
          let repo = params.repo as string;
          // Accept full URLs too
          const urlMatch = repo.match(/github\.com\/([^/]+\/[^/.]+)/);
          if (urlMatch) repo = urlMatch[1];

          const [repoInfo, branches, pulls] = await Promise.all([
            githubRequest<GHRepo>(token, `/repos/${repo}`),
            githubRequest<Array<{ name: string }>>(token, `/repos/${repo}/branches?per_page=${GITHUB_BRANCHES_PER_PAGE}`),
            githubRequest<Array<{ number: number; title: string; state: string; html_url: string; user: { login: string } }>>(
              token,
              `/repos/${repo}/pulls?state=open&per_page=${GITHUB_OPEN_PRS_PER_PAGE}&sort=updated`
            ),
          ]);

          return text(
            JSON.stringify({
              name: repoInfo.full_name,
              url: repoInfo.html_url,
              description: repoInfo.description,
              default_branch: repoInfo.default_branch,
              private: repoInfo.private,
              language: repoInfo.language,
              branches: branches.map((b) => b.name),
              open_prs: pulls.map((p) => ({
                number: p.number,
                title: p.title,
                author: p.user.login,
                url: p.html_url,
              })),
            })
          );
        } catch (error) {
          return text(
            JSON.stringify({
              error: "Failed to get repo info",
              details: error instanceof Error ? error.message : String(error),
            })
          );
        }
      },
    },

    {
      name: "github.create-repo",
      description: `Create a new repository in the ${GITHUB_ORG} org. By default scaffolds a pnpm monorepo from cf-app-template (apps/web = Cloudflare Pages, workers/api = Worker, packages/shared = shared types) and auto-creates a Cloudflare Pages project linked to apps/web for deploy-on-push. Set template=false for a plain repo. Confirm name and public/private with the user first.`,
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Repository name (without org prefix), e.g. my-new-app",
          },
          org: {
            type: "string",
            description: `GitHub organization login. Defaults to ${GITHUB_ORG} if omitted.`,
          },
          description: {
            type: "string",
            description: "Short description for the repository.",
          },
          private: {
            type: "boolean",
            description: "If true (default), create a private repository.",
          },
          template: {
            type: "boolean",
            description:
              "If true (default), scaffold a pnpm monorepo from cf-app-template (apps/web, workers/api, packages/shared) and auto-create a Cloudflare Pages project for apps/web. If false, create a plain repo with an initial README only (no Pages project).",
          },
        },
        required: ["name"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.GITHUB_REPO_CREATE_TOKEN;
        if (!token) {
          return text(JSON.stringify({ error: "GITHUB_REPO_CREATE_TOKEN not configured" }));
        }

        const name = (params.name as string)?.trim();
        if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
          return text(
            JSON.stringify({
              error: "Invalid repo name",
              details: "Use letters, numbers, dots, underscores, and hyphens only.",
            })
          );
        }

        const org = ((params.org as string | undefined)?.trim() || GITHUB_ORG).replace(/^\/+|\/+$/g, "");
        const description = (params.description as string | undefined)?.trim() || undefined;
        const isPrivate = params.private !== false;
        const useTemplate = params.template !== false;

        try {
          let created: {
            full_name: string;
            html_url: string;
            clone_url: string;
            default_branch: string;
            private: boolean;
          };

          if (useTemplate) {
            created = await githubPost(token, `/repos/${encodeURIComponent(GITHUB_ORG)}/cf-app-template/generate`, {
              owner: org,
              name,
              ...(description ? { description } : {}),
              private: isPrivate,
              include_all_branches: false,
            });
          } else {
            created = await githubPost(token, `/orgs/${encodeURIComponent(org)}/repos`, {
              name,
              ...(description ? { description } : {}),
              private: isPrivate,
              auto_init: true,
            });

            return text(
              JSON.stringify({
                ok: true,
                full_name: created.full_name,
                html_url: created.html_url,
                clone_url: created.clone_url,
                default_branch: created.default_branch,
                private: created.private,
                from_template: null,
                pages_project: null,
              })
            );
          }

          // Auto-create Cloudflare Pages project linked to the new repo
          let pagesResult: Record<string, unknown> | null = null;
          const cfToken = context.env?.CF_API_TOKEN || context.env?.CF_AIG_TOKEN;
          const cfAccountId = context.env?.CF_ACCOUNT_ID;
          if (cfToken && cfAccountId) {
            try {
              const pagesBody = {
                name,
                production_branch: created.default_branch || "main",
                source: {
                  type: "github",
                  config: {
                    owner: org,
                    repo_name: name,
                    production_branch: created.default_branch || "main",
                    pr_comments_enabled: true,
                    deployments_enabled: true,
                    production_deployment_enabled: true,
                    preview_deployment_setting: "all",
                  },
                },
                build_config: {
                  build_command: "pnpm build",
                  destination_dir: "dist",
                  root_dir: "apps/web",
                },
              };

              const pagesRes = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/pages/projects`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${cfToken}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(pagesBody),
                }
              );

              const pagesData = (await pagesRes.json()) as {
                success: boolean;
                result?: { name: string; subdomain: string; domains: string[] };
                errors?: Array<{ code: number; message: string }>;
              };

              if (pagesData.success && pagesData.result) {
                pagesResult = {
                  name: pagesData.result.name,
                  url: `https://${pagesData.result.subdomain}`,
                  domains: pagesData.result.domains,
                  auto_deploy: true,
                };
              } else {
                pagesResult = {
                  error: "Pages project creation failed",
                  details: pagesData.errors?.map((e) => `${e.code}: ${e.message}`).join("; "),
                };
              }
            } catch (pagesErr) {
              pagesResult = {
                error: "Pages API call failed",
                details: pagesErr instanceof Error ? pagesErr.message : String(pagesErr),
              };
            }
          } else {
            pagesResult = { skipped: true, reason: "CF_API_TOKEN or CF_ACCOUNT_ID not set" };
          }

          // Auto-set Cloudflare secrets on the repo for GitHub Actions worker deploys
          let secretsResult: Record<string, unknown> | null = null;
          const repoFullName = `${org}/${name}`;
          if (cfToken && cfAccountId) {
            try {
              await setRepoSecret(token, repoFullName, "CLOUDFLARE_API_TOKEN", cfToken);
              await setRepoSecret(token, repoFullName, "CLOUDFLARE_ACCOUNT_ID", cfAccountId);
              secretsResult = { ok: true, secrets_set: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] };
            } catch (secretsErr) {
              secretsResult = {
                error: "Failed to set repo secrets",
                details: secretsErr instanceof Error ? secretsErr.message : String(secretsErr),
              };
            }
          } else {
            secretsResult = { skipped: true, reason: "CF_API_TOKEN or CF_ACCOUNT_ID not set" };
          }

          return text(
            JSON.stringify({
              ok: true,
              full_name: created.full_name,
              html_url: created.html_url,
              clone_url: created.clone_url,
              default_branch: created.default_branch,
              private: created.private,
              from_template: "cf-app-template",
              pages_project: pagesResult,
              repo_secrets: secretsResult,
            })
          );
        } catch (error) {
          return text(
            JSON.stringify({
              error: "Failed to create repository",
              details: error instanceof Error ? error.message : String(error),
            })
          );
        }
      },
    },
    {
      name: "github.pr-checks",
      description:
        `Get check runs, deployment statuses, and deploy preview URLs for a pull request. Use this when checking on a dev task PR or any PR to see CI status and Cloudflare Pages preview links.`,
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: `Full repo name (e.g. ${GITHUB_ORG}/my-app) or GitHub URL.`,
          },
          pr_number: {
            type: "number",
            description: "Pull request number.",
          },
        },
        required: ["repo", "pr_number"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.GITHUB_TOKEN;
        if (!token) return text(JSON.stringify({ error: "GITHUB_TOKEN not configured" }));

        try {
          let repo = params.repo as string;
          const urlMatch = repo.match(/github\.com\/([^/]+\/[^/.]+)/);
          if (urlMatch) repo = urlMatch[1];
          const prNumber = params.pr_number as number;

          type GHPull = {
            number: number;
            title: string;
            state: string;
            html_url: string;
            head: { sha: string; ref: string };
            mergeable_state?: string;
            merged: boolean;
            user: { login: string };
          };

          type GHCheckRun = {
            name: string;
            status: string;
            conclusion: string | null;
            html_url: string;
            details_url: string | null;
          };

          type GHDeployment = {
            id: number;
            environment: string;
            ref: string;
            created_at: string;
          };

          type GHDeploymentStatus = {
            state: string;
            environment_url: string | null;
            description: string | null;
            created_at: string;
          };

          const pr = await githubRequest<GHPull>(token, `/repos/${repo}/pulls/${prNumber}`);

          const [checkRunsData, deployments] = await Promise.all([
            githubRequest<{ total_count: number; check_runs: GHCheckRun[] }>(
              token,
              `/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=50`
            ),
            githubRequest<GHDeployment[]>(
              token,
              `/repos/${repo}/deployments?sha=${pr.head.sha}&per_page=20`
            ),
          ]);

          const checks = checkRunsData.check_runs.map((c) => ({
            name: c.name,
            status: c.status,
            conclusion: c.conclusion,
            url: c.html_url,
            details_url: c.details_url,
          }));

          const deploys: Array<{
            environment: string;
            state: string;
            url: string | null;
            created_at: string;
          }> = [];

          for (const dep of deployments) {
            const statuses = await githubRequest<GHDeploymentStatus[]>(
              token,
              `/repos/${repo}/deployments/${dep.id}/statuses?per_page=1`
            );
            const latest = statuses[0];
            if (latest) {
              deploys.push({
                environment: dep.environment,
                state: latest.state,
                url: latest.environment_url || null,
                created_at: latest.created_at,
              });
            }
          }

          const previewUrls = deploys
            .filter((d) => d.url && d.state === "success")
            .map((d) => d.url!);

          return text(
            JSON.stringify({
              pr: {
                number: pr.number,
                title: pr.title,
                state: pr.state,
                author: pr.user.login,
                branch: pr.head.ref,
                sha: pr.head.sha,
                merged: pr.merged,
                url: pr.html_url,
              },
              checks,
              deployments: deploys,
              preview_urls: previewUrls,
            })
          );
        } catch (error) {
          return text(
            JSON.stringify({
              error: "Failed to get PR checks",
              details: error instanceof Error ? error.message : String(error),
            })
          );
        }
      },
    },

    {
      name: "github.pr-diff",
      description:
        `Get the code diff for a pull request. Use this to review what changed before merging. Returns the raw unified diff.`,
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: `Full repo name (e.g. ${GITHUB_ORG}/my-app) or GitHub URL.`,
          },
          pr_number: {
            type: "number",
            description: "Pull request number.",
          },
        },
        required: ["repo", "pr_number"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.GITHUB_TOKEN;
        if (!token) return text(JSON.stringify({ error: "GITHUB_TOKEN not configured" }));

        try {
          let repo = params.repo as string;
          const urlMatch = repo.match(/github\.com\/([^/]+\/[^/.]+)/);
          if (urlMatch) repo = urlMatch[1];
          const prNumber = params.pr_number as number;

          const res = await fetch(`${GITHUB_API_BASE_URL}/repos/${repo}/pulls/${prNumber}`, {
            headers: {
              Accept: "application/vnd.github.v3.diff",
              Authorization: `Bearer ${token}`,
              "X-GitHub-Api-Version": GITHUB_API_VERSION,
              "User-Agent": AGENT_ID,
            },
          });

          if (!res.ok) {
            const body = await res.text();
            throw new Error(`GitHub API error (${res.status}): ${body}`);
          }

          const diff = await res.text();

          const pr = await githubRequest<{
            number: number;
            title: string;
            additions: number;
            deletions: number;
            changed_files: number;
            body: string | null;
          }>(token, `/repos/${repo}/pulls/${prNumber}`);

          return text(
            JSON.stringify({
              pr: {
                number: pr.number,
                title: pr.title,
                description: pr.body,
                additions: pr.additions,
                deletions: pr.deletions,
                changed_files: pr.changed_files,
              },
              diff,
            })
          );
        } catch (error) {
          return text(
            JSON.stringify({
              error: "Failed to get PR diff",
              details: error instanceof Error ? error.message : String(error),
            })
          );
        }
      },
    },

    {
      name: "github.merge-pr",
      description:
        `Merge a pull request. Defaults to squash merge with branch auto-delete. Use github_pr_diff to review the code first, then merge if it looks good.`,
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: `Full repo name (e.g. ${GITHUB_ORG}/my-app) or GitHub URL.`,
          },
          pr_number: {
            type: "number",
            description: "Pull request number.",
          },
          merge_method: {
            type: "string",
            enum: ["squash", "merge", "rebase"],
            description: 'Merge strategy. Defaults to "squash".',
          },
          commit_title: {
            type: "string",
            description: "Custom commit title. Defaults to the PR title.",
          },
        },
        required: ["repo", "pr_number"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.GITHUB_TOKEN;
        if (!token) return text(JSON.stringify({ error: "GITHUB_TOKEN not configured" }));

        try {
          let repo = params.repo as string;
          const urlMatch = repo.match(/github\.com\/([^/]+\/[^/.]+)/);
          if (urlMatch) repo = urlMatch[1];
          const prNumber = params.pr_number as number;
          const mergeMethod = (params.merge_method as string | undefined) || "squash";
          const commitTitle = params.commit_title as string | undefined;

          const pr = await githubRequest<{
            number: number;
            title: string;
            state: string;
            merged: boolean;
            head: { ref: string };
            mergeable: boolean | null;
            mergeable_state: string;
          }>(token, `/repos/${repo}/pulls/${prNumber}`);

          if (pr.merged) {
            return text(JSON.stringify({ error: "PR is already merged" }));
          }
          if (pr.state !== "open") {
            return text(JSON.stringify({ error: `PR is ${pr.state}, not open` }));
          }

          const mergeBody: Record<string, unknown> = {
            merge_method: mergeMethod,
          };
          if (commitTitle) {
            mergeBody.commit_title = commitTitle;
          }

          const mergeResult = await githubPut(
            token,
            `/repos/${repo}/pulls/${prNumber}/merge`,
            mergeBody,
          ).then(() => ({ merged: true })).catch(async (err) => {
            throw err;
          });

          // Auto-delete the head branch
          let branchDeleted = false;
          try {
            const delRes = await fetch(
              `${GITHUB_API_BASE_URL}/repos/${repo}/git/refs/heads/${encodeURIComponent(pr.head.ref)}`,
              {
                method: "DELETE",
                headers: {
                  Accept: "application/vnd.github+json",
                  Authorization: `Bearer ${token}`,
                  "X-GitHub-Api-Version": GITHUB_API_VERSION,
                  "User-Agent": AGENT_ID,
                },
              }
            );
            branchDeleted = delRes.ok || delRes.status === 204;
          } catch {
            // branch delete is best-effort
          }

          return text(
            JSON.stringify({
              ok: true,
              merged: true,
              pr_number: prNumber,
              title: pr.title,
              merge_method: mergeMethod,
              branch_deleted: branchDeleted,
              branch: pr.head.ref,
            })
          );
        } catch (error) {
          return text(
            JSON.stringify({
              error: "Failed to merge PR",
              details: error instanceof Error ? error.message : String(error),
            })
          );
        }
      },
    },

    {
      name: "github.pr-comment",
      description:
        `Post a comment on a pull request. Use this to leave review feedback, ask questions, or note issues found during code review.`,
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: `Full repo name (e.g. ${GITHUB_ORG}/my-app) or GitHub URL.`,
          },
          pr_number: {
            type: "number",
            description: "Pull request number.",
          },
          body: {
            type: "string",
            description: "Comment body (Markdown supported).",
          },
        },
        required: ["repo", "pr_number", "body"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.GITHUB_TOKEN;
        if (!token) return text(JSON.stringify({ error: "GITHUB_TOKEN not configured" }));

        try {
          let repo = params.repo as string;
          const urlMatch = repo.match(/github\.com\/([^/]+\/[^/.]+)/);
          if (urlMatch) repo = urlMatch[1];
          const prNumber = params.pr_number as number;
          const body = params.body as string;

          const comment = await githubPost<{ id: number; html_url: string; created_at: string }>(
            token,
            `/repos/${repo}/issues/${prNumber}/comments`,
            { body },
          );

          return text(
            JSON.stringify({
              ok: true,
              comment_id: comment.id,
              url: comment.html_url,
            })
          );
        } catch (error) {
          return text(
            JSON.stringify({
              error: "Failed to post comment",
              details: error instanceof Error ? error.message : String(error),
            })
          );
        }
      },
    },

    {
      name: "github.merge-chain",
      description:
        `Merge a chain of stacked PRs bottom-up into main. Takes a plan ID, fetches the plan from the dev agent to get the ordered list of PRs, then merges them sequentially: merge PR 1 into main, update PR 2's base to main, merge PR 2, and so on. Use this after a plan completes successfully.`,
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          planId: {
            type: "string",
            description: "Plan ID to merge. The plan must be in 'completed' status.",
          },
        },
        required: ["planId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.GITHUB_TOKEN;
        if (!token) return text(JSON.stringify({ error: "GITHUB_TOKEN not configured" }));

        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return text(JSON.stringify({ error: "DEV_AGENT service binding not configured" }));

        try {
          const planId = params.planId as string;

          const planRes = await devAgent.fetch(`https://dev-agent/plans/${planId}`);
          const plan = await planRes.json() as {
            id: string;
            repo: string;
            name: string;
            status: string;
            branch: string;
            steps: Array<{
              id: string;
              description: string;
              prUrl?: string;
              prNumber?: number;
              status: string;
            }>;
            error?: string;
          };

          if (!plan || plan.error) {
            return text(JSON.stringify({ error: plan?.error ?? "Plan not found" }));
          }

          if (plan.status !== "completed") {
            return text(JSON.stringify({
              error: `Plan is "${plan.status}" — must be "completed" to merge`,
              plan_id: plan.id,
            }));
          }

          let repo = plan.repo;
          const urlMatch = repo.match(/github\.com\/([^/]+\/[^/.]+)/);
          if (urlMatch) repo = urlMatch[1];

          const stepsWithPRs = plan.steps.filter(
            (s) => s.prNumber && (s.status === "completed" || s.status === "merged")
          );
          if (stepsWithPRs.length === 0) {
            return text(JSON.stringify({ error: "No PRs to merge in this plan" }));
          }

          type MergeResult = {
            step: string;
            pr_number: number;
            merged: boolean;
            skipped?: boolean;
            error?: string;
            remaining?: number[];
          };

          const targetBranch = plan.branch || "main";
          const results: MergeResult[] = [];

          for (let i = 0; i < stepsWithPRs.length; i++) {
            const step = stepsWithPRs[i];
            const prNumber = step.prNumber!;
            const label = step.description.slice(0, 80);

            // ── Pre-check: verify actual PR state on GitHub ──
            type PRState = {
              state: string;
              merged: boolean;
              head: { sha: string; ref: string };
              base: { ref: string };
            };

            let ghPR: PRState;
            try {
              ghPR = await githubRequest<PRState>(token, `/repos/${repo}/pulls/${prNumber}`);
            } catch (err) {
              results.push({
                step: label, pr_number: prNumber, merged: false,
                error: `Failed to fetch PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
              });
              break;
            }

            if (ghPR.merged) {
              results.push({ step: label, pr_number: prNumber, merged: true, skipped: true });
              continue;
            }

            if (ghPR.state === "closed") {
              const remaining = stepsWithPRs.slice(i + 1).map((s) => s.prNumber!);
              results.push({
                step: label, pr_number: prNumber, merged: false,
                error: `PR #${prNumber} is closed without merging — chain is broken. Remaining PRs need a recovery branch.`,
                remaining,
              });
              break;
            }

            try {
              // ── Retarget onto targetBranch ──
              await githubPatch(token, `/repos/${repo}/pulls/${prNumber}`, {
                base: targetBranch,
              });

              // Verify retarget succeeded
              const afterRetarget = await githubRequest<PRState>(
                token, `/repos/${repo}/pulls/${prNumber}`
              );
              if (afterRetarget.base.ref !== targetBranch) {
                results.push({
                  step: label, pr_number: prNumber, merged: false,
                  error: `Retarget failed: PR #${prNumber} base is "${afterRetarget.base.ref}", expected "${targetBranch}"`,
                });
                break;
              }

              // ── Update branch (merge target into PR head) ──
              const updateRes = await fetch(
                `${GITHUB_API_BASE_URL}/repos/${repo}/pulls/${prNumber}/update-branch`,
                {
                  method: "PUT",
                  headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${token}`,
                    "X-GitHub-Api-Version": GITHUB_API_VERSION,
                    "User-Agent": AGENT_ID,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ expected_head_sha: afterRetarget.head.sha }),
                }
              );

              if (!updateRes.ok) {
                const updateBody = await updateRes.text();
                const benign = /already up.to.date|no new commits/i.test(updateBody);
                if (updateRes.status === 422 && !benign) {
                  results.push({
                    step: label, pr_number: prNumber, merged: false,
                    error: `Conflict updating branch — needs manual rebase. GitHub: ${updateBody}`,
                  });
                  break;
                }
                // Benign 422 ("already up to date") or other non-422 — proceed
              }

              // Brief pause for GitHub to process the branch update
              await new Promise((r) => setTimeout(r, 2000));

              // ── Squash merge ──
              await githubPut(token, `/repos/${repo}/pulls/${prNumber}/merge`, {
                merge_method: "squash",
              });

              // Verify merge landed on the correct branch
              const afterMerge = await githubRequest<PRState>(
                token, `/repos/${repo}/pulls/${prNumber}`
              );
              if (!afterMerge.merged || afterMerge.base.ref !== targetBranch) {
                results.push({
                  step: label, pr_number: prNumber, merged: false,
                  error: `Merge verification failed: merged=${afterMerge.merged}, base="${afterMerge.base.ref}" (expected "${targetBranch}")`,
                });
                break;
              }

              // ── Clean up head branch (best-effort) ──
              try {
                await fetch(
                  `${GITHUB_API_BASE_URL}/repos/${repo}/git/refs/heads/${encodeURIComponent(afterRetarget.head.ref)}`,
                  {
                    method: "DELETE",
                    headers: {
                      Accept: "application/vnd.github+json",
                      Authorization: `Bearer ${token}`,
                      "X-GitHub-Api-Version": GITHUB_API_VERSION,
                      "User-Agent": AGENT_ID,
                    },
                  }
                );
              } catch {
                // branch delete is best-effort
              }

              results.push({ step: label, pr_number: prNumber, merged: true });
            } catch (mergeErr) {
              results.push({
                step: label, pr_number: prNumber, merged: false,
                error: mergeErr instanceof Error ? mergeErr.message : String(mergeErr),
              });
              break;
            }
          }

          const allMerged = results.every((r) => r.merged);
          const mergedPRs = results.filter((r) => r.merged);

          if (mergedPRs.length > 0) {
            try {
              await devAgent.fetch(`https://dev-agent/plans/${planId}/merged`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  merged: mergedPRs.map((r) => ({ prNumber: r.pr_number })),
                }),
              });
            } catch (err) {
              console.error(`[merge-chain] Failed to update dev-agent plan state:`, err);
            }
          }

          return text(JSON.stringify({
            ok: allMerged,
            plan_id: plan.id,
            plan_name: plan.name,
            merged_count: mergedPRs.length,
            total_prs: stepsWithPRs.length,
            results,
          }));
        } catch (error) {
          return text(
            JSON.stringify({
              error: "Failed to merge chain",
              details: error instanceof Error ? error.message : String(error),
            })
          );
        }
      },
    },
    {
      name: "github.tree",
      description:
        `Get the file tree of a GitHub repository. Returns a flat list of file paths, types, and sizes. Use this to understand project structure before planning work. Optionally filter by a path prefix (e.g. "src/").`,
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: `Full repo name (e.g. ${GITHUB_ORG}/my-app) or GitHub URL.`,
          },
          ref: {
            type: "string",
            description: "Branch, tag, or commit SHA. Defaults to the repo's default branch.",
          },
          filter: {
            type: "string",
            description: "Optional path prefix to filter results (e.g. 'src/' to only show files under src/).",
          },
        },
        required: ["repo"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.GITHUB_TOKEN;
        if (!token) return text(JSON.stringify({ error: "GITHUB_TOKEN not configured" }));

        try {
          let repo = params.repo as string;
          const urlMatch = repo.match(/github\.com\/([^/]+\/[^/.]+)/);
          if (urlMatch) repo = urlMatch[1];
          const filter = (params.filter as string | undefined)?.replace(/^\/+/, "");

          let ref = params.ref as string | undefined;
          if (!ref) {
            const repoInfo = await githubRequest<{ default_branch: string }>(token, `/repos/${repo}`);
            ref = repoInfo.default_branch;
          }

          const treeData = await githubRequest<{
            sha: string;
            tree: Array<{ path: string; type: string; size?: number }>;
            truncated: boolean;
          }>(token, `/repos/${repo}/git/trees/${ref}?recursive=1`);

          let entries = treeData.tree;
          if (filter) {
            entries = entries.filter((e) => e.path.startsWith(filter));
          }

          const MAX_ENTRIES = 500;
          const truncatedByUs = entries.length > MAX_ENTRIES;
          if (truncatedByUs) entries = entries.slice(0, MAX_ENTRIES);

          const files = entries.map((e) => ({
            path: e.path,
            type: e.type === "blob" ? "file" : "dir",
            ...(e.size !== undefined ? { size: e.size } : {}),
          }));

          return text(JSON.stringify({
            repo,
            ref,
            total_entries: treeData.tree.length,
            shown_entries: files.length,
            truncated: treeData.truncated || truncatedByUs,
            ...(filter ? { filter } : {}),
            files,
          }));
        } catch (error) {
          return text(JSON.stringify({
            error: "Failed to get repo tree",
            details: error instanceof Error ? error.message : String(error),
          }));
        }
      },
    },

    {
      name: "github.file",
      description:
        `Read the contents of a file from a GitHub repository. Decodes base64 content automatically. Use this to inspect specific files (package.json, configs, source files) when planning or reviewing code.`,
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: `Full repo name (e.g. ${GITHUB_ORG}/my-app) or GitHub URL.`,
          },
          path: {
            type: "string",
            description: "Path to the file within the repo (e.g. 'src/index.ts' or 'package.json').",
          },
          ref: {
            type: "string",
            description: "Branch, tag, or commit SHA. Defaults to the repo's default branch.",
          },
        },
        required: ["repo", "path"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.GITHUB_TOKEN;
        if (!token) return text(JSON.stringify({ error: "GITHUB_TOKEN not configured" }));

        try {
          let repo = params.repo as string;
          const urlMatch = repo.match(/github\.com\/([^/]+\/[^/.]+)/);
          if (urlMatch) repo = urlMatch[1];
          const filePath = params.path as string;
          const ref = params.ref as string | undefined;

          const queryParam = ref ? `?ref=${encodeURIComponent(ref)}` : "";
          const res = await fetch(
            `${GITHUB_API_BASE_URL}/repos/${repo}/contents/${encodeURIComponent(filePath)}${queryParam}`,
            {
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": GITHUB_API_VERSION,
                "User-Agent": AGENT_ID,
              },
            },
          );

          if (!res.ok) {
            const body = await res.text();
            if (res.status === 404) {
              return text(JSON.stringify({ error: "File not found", path: filePath, repo }));
            }
            throw new Error(`GitHub API error (${res.status}): ${body}`);
          }

          const data = await res.json() as {
            type: string;
            encoding?: string;
            content?: string;
            size: number;
            sha: string;
            name: string;
            path: string;
          };

          if (data.type === "dir") {
            return text(JSON.stringify({
              error: "Path is a directory, not a file. Use github.tree to list directory contents.",
              path: filePath,
            }));
          }

          const MAX_CONTENT_SIZE = 100_000;
          let content: string;
          let truncated = false;

          if (data.encoding === "base64" && data.content) {
            content = atob(data.content.replace(/\n/g, ""));
            if (content.length > MAX_CONTENT_SIZE) {
              content = content.slice(0, MAX_CONTENT_SIZE);
              truncated = true;
            }
          } else if (data.size > 1_000_000) {
            // Large files: use the Blob API
            const blobData = await githubRequest<{ content: string; encoding: string }>(
              token,
              `/repos/${repo}/git/blobs/${data.sha}`,
            );
            content = atob(blobData.content.replace(/\n/g, ""));
            if (content.length > MAX_CONTENT_SIZE) {
              content = content.slice(0, MAX_CONTENT_SIZE);
              truncated = true;
            }
          } else {
            content = data.content ?? "";
          }

          return text(JSON.stringify({
            repo,
            path: data.path,
            size: data.size,
            truncated,
            content,
          }));
        } catch (error) {
          return text(JSON.stringify({
            error: "Failed to read file",
            details: error instanceof Error ? error.message : String(error),
          }));
        }
      },
    },

    {
      name: "github.search-code",
      description:
        `Search for code in a GitHub repository. Returns matching file paths and text fragments. Rate limited to 10 requests/minute — use sparingly and prefer github.tree + github.file for targeted exploration.`,
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: `Full repo name (e.g. ${GITHUB_ORG}/my-app) or GitHub URL.`,
          },
          query: {
            type: "string",
            description: "Search query (code, function names, imports, etc.).",
          },
          path_filter: {
            type: "string",
            description: "Optional path filter to restrict search scope (e.g. 'src/' or 'packages/shared').",
          },
        },
        required: ["repo", "query"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const token = context.env?.GITHUB_TOKEN;
        if (!token) return text(JSON.stringify({ error: "GITHUB_TOKEN not configured" }));

        try {
          let repo = params.repo as string;
          const urlMatch = repo.match(/github\.com\/([^/]+\/[^/.]+)/);
          if (urlMatch) repo = urlMatch[1];
          const query = params.query as string;
          const pathFilter = params.path_filter as string | undefined;

          let q = `${query} repo:${repo}`;
          if (pathFilter) q += ` path:${pathFilter}`;

          const data = await githubRequest<{
            total_count: number;
            incomplete_results: boolean;
            items: Array<{
              name: string;
              path: string;
              html_url: string;
              text_matches?: Array<{
                fragment: string;
                matches: Array<{ text: string; indices: number[] }>;
              }>;
            }>;
          }>(token, `/search/code?q=${encodeURIComponent(q)}&per_page=20`);

          const results = data.items.map((item) => ({
            file: item.path,
            url: item.html_url,
            matches: item.text_matches?.map((tm) => tm.fragment) ?? [],
          }));

          return text(JSON.stringify({
            repo,
            query,
            total_count: data.total_count,
            shown: results.length,
            incomplete: data.incomplete_results,
            results,
          }));
        } catch (error) {
          return text(JSON.stringify({
            error: "Failed to search code",
            details: error instanceof Error ? error.message : String(error),
          }));
        }
      },
    },
  ];
}
