/**
 * MCP handlers for dev agent integration.
 * Proxies task creation/status and plan CRUD to cf-dev-agent via service binding.
 * When a WorkTracker is provided, automatically records work items on task/plan creation.
 */

import type { ToolDefinition, ToolContext, ToolExecutionParams, MCPToolResult } from "../types";
import type { WorkTracker } from "../../work/tracker";
import { refineTaskFromThread } from "../thread-context";

function text(content: string): MCPToolResult {
  return { type: "text", content };
}

function noBinding(): MCPToolResult {
  return text(JSON.stringify({ error: "DEV_AGENT service binding not configured" }));
}

function getAiGatewayOpts(env: any) {
  return {
    accountId: env.CF_ACCOUNT_ID,
    gateway: env.CF_GATEWAY,
    apiKey: env.CF_AIG_TOKEN,
  };
}

async function callDevAgent(
  devAgent: Fetcher,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<MCPToolResult> {
  try {
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await devAgent.fetch(`https://dev-agent${path}`, opts);
    const data = await res.json();
    return text(JSON.stringify(data));
  } catch (error) {
    return text(JSON.stringify({
      error: `Dev agent request failed: ${path}`,
      details: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function createDevAgentMCPTools(workTracker?: WorkTracker): ToolDefinition[] {
  return [
    // =====================================================================
    // Task tools
    // =====================================================================
    {
      name: "dev.create-task",
      description:
        "Create a development task: clones a GitHub repo, runs Claude Code to implement the task, and creates a PR with the changes. Returns a task ID for tracking progress. The 'repo' parameter must be a full GitHub URL (e.g. https://github.com/org/repo). If the user only provides a repo name, use github.repos first to look up the full URL.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo URL, e.g. https://github.com/org/repo" },
          task: { type: "string", description: "Task description for Claude Code to implement" },
          branch: { type: "string", description: "Base branch to work from (defaults to main)" },
        },
        required: ["repo", "task"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();

        let taskText = params.task as string;

        // Refine task with thread context if available
        if (context.thread && context.thread.length > 1 && context.env) {
          try {
            taskText = await refineTaskFromThread({
              thread: context.thread,
              rawTask: taskText,
              kind: "task",
              aiGatewayOpts: getAiGatewayOpts(context.env),
            });
          } catch (err) {
            console.error("[dev.create-task] Thread refinement failed, using raw task:", err);
          }
        }

        const result = await callDevAgent(devAgent, "/tasks", "POST", {
          repo: params.repo,
          task: taskText,
          branch: params.branch,
        });

        // Save thread log keyed by actual task ID
        if (context.thread && context.thread.length > 1 && context.env?.PROMPTS_BUCKET && result.type === "text") {
          try {
            const data = JSON.parse(result.content as string);
            if (data.id && !data.error) {
              const bucket = context.env.PROMPTS_BUCKET as R2Bucket;
              bucket.put(`threads/task/${data.id}.json`, JSON.stringify({
                devAgentId: data.id,
                kind: "task",
                savedAt: new Date().toISOString(),
                refinedTask: taskText,
                originalTask: params.task,
                messageCount: context.thread.length,
                messages: context.thread.map((m: any) => ({ user: m.user, text: m.text, ts: m.ts })),
              }), { httpMetadata: { contentType: "application/json" } }).catch(() => {});
            }
          } catch { /* best effort */ }
        }

        if (workTracker && context.slackContext && result.type === "text") {
          try {
            const data = JSON.parse(result.content as string);
            if (data.id && !data.duplicate && !data.error) {
              await workTracker.track({
                type: "task",
                devAgentId: data.id,
                repo: params.repo as string,
                description: params.task as string,
                channel: context.slackContext.channel,
                threadTs: context.slackContext.threadTs,
                teamId: context.teamId,
                createdBy: context.slackContext.userId,
              });
            }
          } catch {
            // tracking failure should not block the response
          }
        }

        return result;
      },
    },

    {
      name: "dev.task-status",
      description:
        "Check the status of a development task. Returns current status, logs, diff, and PR URL when complete.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID returned by dev.create-task" },
        },
        required: ["taskId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();
        return callDevAgent(devAgent, `/tasks/${params.taskId}`);
      },
    },

    {
      name: "dev.list-tasks",
      description: "List recent development tasks and their statuses.",
      category: "shared",
      version: 1,
      inputSchema: { type: "object", properties: {} },
      handler: async (_params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();
        return callDevAgent(devAgent, "/tasks");
      },
    },

    // =====================================================================
    // Plan tools
    // =====================================================================
    {
      name: "dev.create-plan",
      description:
        "Create a development plan: breaks a feature into ordered steps that will execute sequentially as stacked PRs. Returns a plan ID. The plan starts in 'draft' status — show it to the user and wait for approval before running. Each step becomes a dev task that branches off the previous step's head.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo URL, e.g. https://github.com/org/repo" },
          name: { type: "string", description: "Short label for the plan, e.g. 'auth system'" },
          steps: {
            type: "array",
            items: { type: "string" },
            description: "Ordered list of step descriptions. Each becomes a dev task.",
          },
          branch: { type: "string", description: "Base branch (defaults to main)" },
        },
        required: ["repo", "name", "steps"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();

        const result = await callDevAgent(devAgent, "/plans", "POST", {
          repo: params.repo,
          name: params.name,
          steps: params.steps,
          branch: params.branch,
        });

        // Save thread log keyed by plan ID
        if (context.thread && context.thread.length > 1 && context.env?.PROMPTS_BUCKET && result.type === "text") {
          try {
            const data = JSON.parse(result.content as string);
            if (data.id && !data.error) {
              const bucket = context.env.PROMPTS_BUCKET as R2Bucket;
              bucket.put(`threads/plan/${data.id}.json`, JSON.stringify({
                devAgentId: data.id,
                kind: "plan",
                savedAt: new Date().toISOString(),
                planName: params.name,
                steps: params.steps,
                messageCount: context.thread.length,
                messages: context.thread.map((m: any) => ({ user: m.user, text: m.text, ts: m.ts })),
              }), { httpMetadata: { contentType: "application/json" } }).catch(() => {});
            }
          } catch { /* best effort */ }
        }

        if (workTracker && context.slackContext && result.type === "text") {
          try {
            const data = JSON.parse(result.content as string);
            if (data.id && !data.error) {
              await workTracker.track({
                type: "plan",
                devAgentId: data.id,
                repo: params.repo as string,
                description: `Plan: ${params.name as string}`,
                channel: context.slackContext.channel,
                threadTs: context.slackContext.threadTs,
                teamId: context.teamId,
                createdBy: context.slackContext.userId,
              });
            }
          } catch {
            // tracking failure should not block the response
          }
        }

        return result;
      },
    },

    {
      name: "dev.plan-status",
      description:
        "Get the status of a plan by ID. Shows all steps, which are done, current progress, PR URLs, and any errors.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          planId: { type: "string", description: "Plan ID returned by dev.create-plan" },
        },
        required: ["planId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();
        return callDevAgent(devAgent, `/plans/${params.planId}`);
      },
    },

    {
      name: "dev.update-plan",
      description:
        "Update a draft plan: reorder, add, remove, or edit step descriptions. Only works on plans in 'draft' status. Pass the full steps array in the desired order.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          planId: { type: "string", description: "Plan ID to update" },
          name: { type: "string", description: "New plan name (optional)" },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Existing step ID (omit for new steps)" },
                description: { type: "string", description: "Step description" },
              },
              required: ["description"],
            },
            description: "Full ordered list of steps. Existing steps keep their IDs; omitted steps are removed.",
          },
        },
        required: ["planId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();
        const body: Record<string, unknown> = {};
        if (params.name) body.name = params.name;
        if (params.steps) body.steps = params.steps;
        return callDevAgent(devAgent, `/plans/${params.planId}`, "PATCH", body);
      },
    },

    {
      name: "dev.run-plan",
      description:
        "Execute a draft plan. Starts the first step as a dev task. Subsequent steps auto-start when the previous one completes. Each step branches from the previous step's head branch, creating stacked PRs.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          planId: { type: "string", description: "Plan ID to execute" },
        },
        required: ["planId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();
        return callDevAgent(devAgent, `/plans/${params.planId}/run`, "POST");
      },
    },

    {
      name: "dev.list-plans",
      description: "List recent development plans and their statuses.",
      category: "shared",
      version: 1,
      inputSchema: { type: "object", properties: {} },
      handler: async (_params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();
        return callDevAgent(devAgent, "/plans");
      },
    },

    {
      name: "dev.reconcile-plan",
      description:
        "Reconcile a plan by checking actual task states against step states. Fixes stale 'running' steps whose tasks have already completed or failed. Call this if a plan appears stuck.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          planId: { type: "string", description: "Plan ID to reconcile" },
        },
        required: ["planId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();
        return callDevAgent(devAgent, `/plans/${params.planId}/reconcile`, "POST");
      },
    },

    {
      name: "dev.reset-plan",
      description:
        "Reset a failed plan back to draft status so steps can be adjusted and re-run. Completed steps are preserved; only failed/pending steps are reset.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          planId: { type: "string", description: "Plan ID to reset" },
        },
        required: ["planId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();
        return callDevAgent(devAgent, `/plans/${params.planId}/reset`, "POST");
      },
    },

    // =====================================================================
    // Additional task tools
    // =====================================================================
    {
      name: "dev.cancel-task",
      description:
        "Cancel a running or pending development task. Salvages any work-in-progress by checkpointing to the remote branch before destroying the sandbox.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID to cancel" },
        },
        required: ["taskId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();
        return callDevAgent(devAgent, `/tasks/${params.taskId}/cancel`, "POST");
      },
    },

    {
      name: "dev.continue-task",
      description:
        "Continue a failed or timed-out development task from where it left off. Reuses the prior task's branch and injects the previous session's context (diff, logs, error) so Claude can resume work instead of starting over.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID of the failed/timed-out task to continue" },
        },
        required: ["taskId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();

        const result = await callDevAgent(devAgent, `/tasks/${params.taskId}/continue`, "POST");

        if (workTracker && context.slackContext && result.type === "text") {
          try {
            const data = JSON.parse(result.content as string);
            if (data.id && !data.duplicate && !data.error) {
              await workTracker.track({
                type: "task",
                devAgentId: data.id,
                repo: data.repo as string,
                description: `Continue: ${(data.task as string)?.slice(0, 80)}`,
                channel: context.slackContext.channel,
                threadTs: context.slackContext.threadTs,
                teamId: context.teamId,
                createdBy: context.slackContext.userId,
              });
            }
          } catch {
            // tracking failure should not block the response
          }
        }

        return result;
      },
    },

    {
      name: "dev.task-logs",
      description:
        "Get the full Claude Code logs for a development task. Useful for debugging failures or understanding what the agent did.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID to get logs for" },
        },
        required: ["taskId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();
        try {
          const res = await devAgent.fetch(`https://dev-agent/tasks/${params.taskId}/logs`);
          if (!res.ok) {
            return text(JSON.stringify({ error: `Failed to get logs: ${res.status}` }));
          }
          const logs = await res.text();
          const truncated = logs.length > 8000 ? logs.slice(-8000) + "\n\n[...truncated, showing last 8000 chars]" : logs;
          return text(truncated);
        } catch (error) {
          return text(JSON.stringify({
            error: "Failed to get task logs",
            details: error instanceof Error ? error.message : String(error),
          }));
        }
      },
    },

    {
      name: "dev.task-session",
      description:
        "Get the full archived session for a completed development task from R2. Includes logs, diff, summary, and metadata.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID to get session for" },
        },
        required: ["taskId"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();
        return callDevAgent(devAgent, `/tasks/${params.taskId}/session`);
      },
    },

    // =====================================================================
    // Research / Audit tools
    // =====================================================================
    {
      name: "dev.repo-audit",
      description:
        "Trigger a deep codebase audit for a repository. Clones the repo in a sandbox and runs Claude to produce a comprehensive analysis (project structure, tech stack, architecture, patterns, dependencies). The audit is stored in R2 and can be retrieved later with dev.get-audit. Use this when github.tree and github.file aren't enough to understand a complex codebase before planning.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo URL, e.g. https://github.com/org/repo" },
          focus: { type: "string", description: "Optional: specific area or question to focus the analysis on (e.g. 'authentication flow' or 'database schema and migrations')" },
          branch: { type: "string", description: "Branch to analyze (defaults to main)" },
        },
        required: ["repo"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();

        const result = await callDevAgent(devAgent, "/research", "POST", {
          repo: params.repo,
          task: params.focus,
          branch: params.branch,
        });

        if (workTracker && context.slackContext && result.type === "text") {
          try {
            const data = JSON.parse(result.content as string);
            if (data.id && !data.error) {
              await workTracker.track({
                type: "task",
                devAgentId: data.id,
                repo: params.repo as string,
                description: `Research: ${(params.focus as string)?.slice(0, 80) ?? "full audit"}`,
                channel: context.slackContext.channel,
                threadTs: context.slackContext.threadTs,
                teamId: context.teamId,
                createdBy: context.slackContext.userId,
              });
            }
          } catch {
            // tracking failure should not block the response
          }
        }

        return result;
      },
    },

    {
      name: "dev.get-audit",
      description:
        "Retrieve a cached codebase audit for a repository. Returns the most recent audit's analysis. Use this to check if an audit already exists before triggering a new one with dev.repo-audit.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo URL, e.g. https://github.com/org/repo" },
        },
        required: ["repo"],
      },
      handler: async (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult> => {
        const devAgent = context.env?.DEV_AGENT;
        if (!devAgent) return noBinding();

        const repo = params.repo as string;
        return callDevAgent(devAgent, `/audits/latest?repo=${encodeURIComponent(repo)}`);
      },
    },
  ];
}
