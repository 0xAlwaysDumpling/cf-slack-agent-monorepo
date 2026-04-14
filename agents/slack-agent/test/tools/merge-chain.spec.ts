import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGitHubMCPTools } from "../../src/tools/mcp-handlers/github";
import type { ToolContext, ToolExecutionParams } from "../../src/tools/types";

function makePlan(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-001",
    repo: "https://github.com/org/repo",
    name: "test plan",
    status: "completed",
    branch: "main",
    steps: [
      { id: "s1", description: "step 1", prNumber: 1, status: "completed" },
      { id: "s2", description: "step 2", prNumber: 2, status: "completed" },
      { id: "s3", description: "step 3", prNumber: 3, status: "completed" },
    ],
    ...overrides,
  };
}

interface FetchMockOpts {
  conflictPR?: number;
  closedPR?: number;
  alreadyMergedPR?: number;
  retargetFailPR?: number;
  benign422PR?: number;
  mergeVerifyFailPR?: number;
}

function buildFetchMock(opts: FetchMockOpts = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  const mergedPRs: number[] = [];
  const retargetedBases = new Map<number, string>();

  const mock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method });

    if (url.includes("/update-branch") && method === "PUT") {
      const prMatch = url.match(/pulls\/(\d+)\/update-branch/);
      const prNum = prMatch ? parseInt(prMatch[1]) : 0;
      if (opts.conflictPR && prNum === opts.conflictPR) {
        return new Response(JSON.stringify({ message: "merge conflict between branches" }), { status: 422 });
      }
      if (opts.benign422PR && prNum === opts.benign422PR) {
        return new Response(JSON.stringify({ message: "There are no new commits on the base branch, already up to date." }), { status: 422 });
      }
      return new Response(JSON.stringify({ message: "Updating pull request branch." }), { status: 202 });
    }
    if (url.includes("/merge") && method === "PUT") {
      const prMatch = url.match(/pulls\/(\d+)\/merge/);
      if (prMatch) {
        const num = parseInt(prMatch[1]);
        mergedPRs.push(num);
      }
      return new Response(JSON.stringify({ merged: true }), { status: 200 });
    }
    if (method === "PATCH" && url.includes("/pulls/")) {
      const prMatch = url.match(/pulls\/(\d+)/);
      if (prMatch && init?.body) {
        const body = JSON.parse(init.body as string);
        if (body.base) retargetedBases.set(parseInt(prMatch[1]), body.base);
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (method === "GET" && url.match(/\/pulls\/\d+$/)) {
      const prMatch = url.match(/pulls\/(\d+)/);
      const num = prMatch ? parseInt(prMatch[1]) : 0;

      if (opts.alreadyMergedPR === num) {
        return new Response(JSON.stringify({
          state: "closed", merged: true,
          head: { sha: `sha-${num}`, ref: `branch-${num}` },
          base: { ref: "main" },
        }), { status: 200 });
      }
      if (opts.closedPR === num) {
        return new Response(JSON.stringify({
          state: "closed", merged: false,
          head: { sha: `sha-${num}`, ref: `branch-${num}` },
          base: { ref: `stacked-${num}` },
        }), { status: 200 });
      }
      if (opts.retargetFailPR === num) {
        return new Response(JSON.stringify({
          state: "open", merged: false,
          head: { sha: `sha-${num}`, ref: `branch-${num}` },
          base: { ref: `stacked-${num}` },
        }), { status: 200 });
      }
      if (opts.mergeVerifyFailPR === num && mergedPRs.includes(num)) {
        return new Response(JSON.stringify({
          state: "closed", merged: true,
          head: { sha: `sha-${num}`, ref: `branch-${num}` },
          base: { ref: `stacked-${num}` },
        }), { status: 200 });
      }

      const base = retargetedBases.get(num) ?? "main";
      const isMerged = mergedPRs.includes(num);
      return new Response(JSON.stringify({
        state: isMerged ? "closed" : "open",
        merged: isMerged,
        head: { sha: `sha-${num}`, ref: `branch-${num}` },
        base: { ref: base },
      }), { status: 200 });
    }
    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  return { mock, calls, mergedPRs };
}

describe("github.merge-chain", () => {
  let mergeChainTool: ReturnType<typeof createGitHubMCPTools>[number];

  beforeEach(() => {
    vi.useFakeTimers();
    const tools = createGitHubMCPTools();
    mergeChainTool = tools.find((t) => t.name === "github.merge-chain")!;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function makeContext(plan: unknown): ToolContext {
    return {
      env: {
        GITHUB_TOKEN: "ghp_test",
        DEV_AGENT: {
          fetch: vi.fn(async (url: string) => {
            if (url.includes("/merged")) {
              return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            return new Response(JSON.stringify(plan), { status: 200 });
          }),
        },
      },
    } as unknown as ToolContext;
  }

  async function runWithTimerAdvance<T>(fn: () => Promise<T>): Promise<T> {
    const promise = fn();
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(3000);
    }
    return promise;
  }

  it("merges stacked PRs sequentially", async () => {
    const plan = makePlan();
    const context = makeContext(plan);
    const { mock, mergedPRs } = buildFetchMock();
    vi.stubGlobal("fetch", mock);

    const result = await runWithTimerAdvance(() =>
      mergeChainTool.handler({ planId: "plan-001" } as ToolExecutionParams, context)
    );
    const parsed = JSON.parse(result.content);

    expect(parsed.ok).toBe(true);
    expect(parsed.merged_count).toBe(3);
    expect(parsed.total_prs).toBe(3);
    expect(mergedPRs).toEqual([1, 2, 3]);
  }, 15000);

  it("skips already-merged steps", async () => {
    const plan = makePlan({
      steps: [
        { id: "s1", description: "step 1", prNumber: 1, status: "merged" },
        { id: "s2", description: "step 2", prNumber: 2, status: "completed" },
        { id: "s3", description: "step 3", prNumber: 3, status: "completed" },
      ],
    });
    const context = makeContext(plan);
    const { mock, mergedPRs } = buildFetchMock({ alreadyMergedPR: 1 });
    vi.stubGlobal("fetch", mock);

    const result = await runWithTimerAdvance(() =>
      mergeChainTool.handler({ planId: "plan-001" } as ToolExecutionParams, context)
    );
    const parsed = JSON.parse(result.content);

    expect(parsed.ok).toBe(true);
    expect(parsed.merged_count).toBe(3);
    expect(parsed.results[0].skipped).toBe(true);
    expect(mergedPRs).toEqual([2, 3]);
  }, 15000);

  it("calls update-branch before merging", async () => {
    const plan = makePlan({
      steps: [
        { id: "s1", description: "step 1", prNumber: 1, status: "completed" },
        { id: "s2", description: "step 2", prNumber: 2, status: "completed" },
      ],
    });
    const context = makeContext(plan);
    const { mock, calls } = buildFetchMock();
    vi.stubGlobal("fetch", mock);

    await runWithTimerAdvance(() =>
      mergeChainTool.handler({ planId: "plan-001" } as ToolExecutionParams, context)
    );

    const updateBranchCalls = calls
      .filter((c) => c.url.includes("/update-branch") && c.method === "PUT")
      .map((c) => {
        const m = c.url.match(/pulls\/(\d+)\/update-branch/);
        return m ? parseInt(m[1]) : 0;
      });

    expect(updateBranchCalls).toEqual([1, 2]);
  }, 15000);

  it("stops on conflict during update-branch", async () => {
    const plan = makePlan({
      steps: [
        { id: "s1", description: "step 1", prNumber: 1, status: "completed" },
        { id: "s2", description: "step 2", prNumber: 2, status: "completed" },
      ],
    });
    const context = makeContext(plan);
    const { mock, mergedPRs } = buildFetchMock({ conflictPR: 2 });
    vi.stubGlobal("fetch", mock);

    const result = await runWithTimerAdvance(() =>
      mergeChainTool.handler({ planId: "plan-001" } as ToolExecutionParams, context)
    );
    const parsed = JSON.parse(result.content);

    expect(parsed.ok).toBe(false);
    expect(parsed.merged_count).toBe(1);
    expect(parsed.results[1].merged).toBe(false);
    expect(parsed.results[1].error).toContain("Conflict");
    expect(mergedPRs).toEqual([1]);
  }, 15000);

  it("reports merged PRs to dev-agent", async () => {
    const plan = makePlan({
      steps: [
        { id: "s1", description: "step 1", prNumber: 1, status: "completed" },
      ],
    });
    const context = makeContext(plan);
    const { mock } = buildFetchMock();
    vi.stubGlobal("fetch", mock);

    await runWithTimerAdvance(() =>
      mergeChainTool.handler({ planId: "plan-001" } as ToolExecutionParams, context)
    );

    const devAgent = context.env!.DEV_AGENT as unknown as { fetch: ReturnType<typeof vi.fn> };
    const mergedCall = devAgent.fetch.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/merged")
    );

    expect(mergedCall).toBeDefined();
    const body = JSON.parse((mergedCall![1] as RequestInit).body as string);
    expect(body.merged).toEqual([{ prNumber: 1 }]);
  }, 15000);

  it("rejects non-completed plans", async () => {
    const plan = makePlan({ status: "running" });
    const context = makeContext(plan);

    const result = await mergeChainTool.handler({ planId: "plan-001" } as ToolExecutionParams, context);
    const parsed = JSON.parse(result.content);

    expect(parsed.error).toContain("must be \"completed\"");
  });

  // ── New tests for resilience fixes ──

  it("stops chain when a PR is closed without merging", async () => {
    const plan = makePlan({
      steps: [
        { id: "s1", description: "step 1", prNumber: 1, status: "completed" },
        { id: "s2", description: "step 2", prNumber: 2, status: "completed" },
        { id: "s3", description: "step 3", prNumber: 3, status: "completed" },
      ],
    });
    const context = makeContext(plan);
    const { mock, mergedPRs } = buildFetchMock({ closedPR: 2 });
    vi.stubGlobal("fetch", mock);

    const result = await runWithTimerAdvance(() =>
      mergeChainTool.handler({ planId: "plan-001" } as ToolExecutionParams, context)
    );
    const parsed = JSON.parse(result.content);

    expect(parsed.ok).toBe(false);
    expect(parsed.merged_count).toBe(1);
    expect(mergedPRs).toEqual([1]);
    expect(parsed.results[1].merged).toBe(false);
    expect(parsed.results[1].error).toContain("closed without merging");
    expect(parsed.results[1].remaining).toEqual([3]);
  }, 15000);

  it("proceeds on benign 422 (already up to date)", async () => {
    const plan = makePlan({
      steps: [
        { id: "s1", description: "step 1", prNumber: 1, status: "completed" },
        { id: "s2", description: "step 2", prNumber: 2, status: "completed" },
      ],
    });
    const context = makeContext(plan);
    const { mock, mergedPRs } = buildFetchMock({ benign422PR: 1 });
    vi.stubGlobal("fetch", mock);

    const result = await runWithTimerAdvance(() =>
      mergeChainTool.handler({ planId: "plan-001" } as ToolExecutionParams, context)
    );
    const parsed = JSON.parse(result.content);

    expect(parsed.ok).toBe(true);
    expect(parsed.merged_count).toBe(2);
    expect(mergedPRs).toEqual([1, 2]);
  }, 15000);

  it("skips PR already merged on GitHub even if plan says completed", async () => {
    const plan = makePlan({
      steps: [
        { id: "s1", description: "step 1", prNumber: 1, status: "completed" },
        { id: "s2", description: "step 2", prNumber: 2, status: "completed" },
        { id: "s3", description: "step 3", prNumber: 3, status: "completed" },
      ],
    });
    const context = makeContext(plan);
    const { mock, mergedPRs } = buildFetchMock({ alreadyMergedPR: 2 });
    vi.stubGlobal("fetch", mock);

    const result = await runWithTimerAdvance(() =>
      mergeChainTool.handler({ planId: "plan-001" } as ToolExecutionParams, context)
    );
    const parsed = JSON.parse(result.content);

    expect(parsed.ok).toBe(true);
    expect(parsed.merged_count).toBe(3);
    expect(parsed.results[1].skipped).toBe(true);
    expect(mergedPRs).toEqual([1, 3]);
  }, 15000);

  it("stops chain when retarget verification fails", async () => {
    const plan = makePlan({
      steps: [
        { id: "s1", description: "step 1", prNumber: 1, status: "completed" },
        { id: "s2", description: "step 2", prNumber: 2, status: "completed" },
      ],
    });
    const context = makeContext(plan);
    const { mock, mergedPRs } = buildFetchMock({ retargetFailPR: 2 });
    vi.stubGlobal("fetch", mock);

    const result = await runWithTimerAdvance(() =>
      mergeChainTool.handler({ planId: "plan-001" } as ToolExecutionParams, context)
    );
    const parsed = JSON.parse(result.content);

    expect(parsed.ok).toBe(false);
    expect(parsed.merged_count).toBe(1);
    expect(mergedPRs).toEqual([1]);
    expect(parsed.results[1].merged).toBe(false);
    expect(parsed.results[1].error).toContain("Retarget failed");
  }, 15000);

  it("stops chain when merge verification shows wrong base", async () => {
    const plan = makePlan({
      steps: [
        { id: "s1", description: "step 1", prNumber: 1, status: "completed" },
        { id: "s2", description: "step 2", prNumber: 2, status: "completed" },
      ],
    });
    const context = makeContext(plan);
    const { mock, mergedPRs } = buildFetchMock({ mergeVerifyFailPR: 2 });
    vi.stubGlobal("fetch", mock);

    const result = await runWithTimerAdvance(() =>
      mergeChainTool.handler({ planId: "plan-001" } as ToolExecutionParams, context)
    );
    const parsed = JSON.parse(result.content);

    expect(parsed.ok).toBe(false);
    expect(parsed.merged_count).toBe(1);
    expect(mergedPRs).toEqual([1, 2]);
    expect(parsed.results[1].merged).toBe(false);
    expect(parsed.results[1].error).toContain("Merge verification failed");
  }, 15000);
});
