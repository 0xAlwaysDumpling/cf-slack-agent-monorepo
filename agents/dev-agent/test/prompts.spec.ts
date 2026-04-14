import { describe, it, expect, beforeEach } from "vitest";
import { PromptManager } from "../src/prompts";
import type { PlanStepContext } from "../src/prompts";
import { BASE_SYSTEM_PROMPT, BASE_PLAN_SYSTEM_PROMPT } from "../src/prompts/defaults";

class MockR2Object {
  constructor(
    public key: string,
    private body: string,
    public size: number,
    public uploaded: Date,
    public customMetadata?: Record<string, string>,
  ) {}

  async text() {
    return this.body;
  }

  async json() {
    return JSON.parse(this.body);
  }
}

class MockR2Bucket {
  private store = new Map<string, { body: string; metadata?: Record<string, string> }>();

  async get(key: string): Promise<MockR2Object | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return new MockR2Object(key, entry.body, entry.body.length, new Date(), entry.metadata);
  }

  async put(key: string, body: string, opts?: { customMetadata?: Record<string, string> }): Promise<void> {
    this.store.set(key, { body, metadata: opts?.customMetadata });
  }

  async head(key: string): Promise<{ key: string } | null> {
    return this.store.has(key) ? { key } : null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(opts?: { prefix?: string }): Promise<{ objects: MockR2Object[] }> {
    const prefix = opts?.prefix ?? "";
    const objects: MockR2Object[] = [];
    for (const [key, entry] of this.store) {
      if (key.startsWith(prefix)) {
        objects.push(new MockR2Object(key, entry.body, entry.body.length, new Date(), entry.metadata));
      }
    }
    return { objects };
  }
}

describe("PromptManager", () => {
  let bucket: MockR2Bucket;
  let pm: PromptManager;

  beforeEach(() => {
    bucket = new MockR2Bucket();
    pm = new PromptManager(bucket as unknown as R2Bucket);
  });

  describe("load()", () => {
    it("falls back to hardcoded task prompt when R2 is empty", async () => {
      const result = await pm.load("task");
      expect(result.source).toBe("hardcoded");
      expect(result.content).toBe(BASE_SYSTEM_PROMPT);
    });

    it("falls back to hardcoded plan prompt when R2 is empty", async () => {
      const result = await pm.load("plan");
      expect(result.source).toBe("hardcoded");
      expect(result.content).toBe(BASE_PLAN_SYSTEM_PROMPT);
    });

    it("loads default R2 prompt when saved", async () => {
      await pm.save("task", "Custom default prompt");
      const result = await pm.load("task");
      expect(result.source).toBe("default");
      expect(result.content).toBe("Custom default prompt");
    });

    it("loads repo-specific R2 prompt over default", async () => {
      await pm.save("task", "Default prompt");
      await pm.save("task", "Repo-specific prompt", "https://github.com/org/repo");
      const result = await pm.load("task", "https://github.com/org/repo");
      expect(result.source).toBe("repo");
      expect(result.content).toBe("Repo-specific prompt");
    });

    it("falls back to default when repo-specific not found", async () => {
      await pm.save("task", "Default prompt");
      const result = await pm.load("task", "https://github.com/org/other-repo");
      expect(result.source).toBe("default");
      expect(result.content).toBe("Default prompt");
    });
  });

  describe("save() and get()", () => {
    it("saves and retrieves a prompt", async () => {
      await pm.save("plan", "My plan prompt");
      const content = await pm.get("plan");
      expect(content).toBe("My plan prompt");
    });

    it("returns null for missing prompt", async () => {
      const content = await pm.get("task");
      expect(content).toBeNull();
    });
  });

  describe("delete()", () => {
    it("deletes an existing prompt", async () => {
      await pm.save("task", "To delete");
      const deleted = await pm.delete("task");
      expect(deleted).toBe(true);
      const content = await pm.get("task");
      expect(content).toBeNull();
    });

    it("returns false when prompt does not exist", async () => {
      const deleted = await pm.delete("task");
      expect(deleted).toBe(false);
    });
  });

  describe("list()", () => {
    it("lists all stored prompts", async () => {
      await pm.save("task", "Default task");
      await pm.save("plan", "Default plan");
      await pm.save("task", "Repo task", "https://github.com/org/repo");

      const prompts = await pm.list();
      expect(prompts).toHaveLength(3);
      expect(prompts.map((p) => p.type).sort()).toEqual(["plan", "task", "task"]);
    });

    it("returns empty array when no prompts stored", async () => {
      const prompts = await pm.list();
      expect(prompts).toHaveLength(0);
    });
  });

  describe("buildPlanPrompt()", () => {
    it("prepends plan context to base prompt", () => {
      const ctx: PlanStepContext = {
        stepNumber: 2,
        totalSteps: 3,
        planName: "Auth System",
        planId: "plan-abc",
        steps: [
          { id: "s1", description: "Set up database schema", status: "completed", prUrl: "https://github.com/org/repo/pull/42" },
          { id: "s2", description: "Implement login endpoints", status: "running" },
          { id: "s3", description: "Add JWT middleware", status: "pending" },
        ],
        currentStepDescription: "Implement login endpoints",
        previousStepBranch: "dev-agent/task-abc",
      };

      const result = pm.buildPlanPrompt("BASE PROMPT HERE", ctx);

      expect(result).toContain("# Plan Context");
      expect(result).toContain("step 2 of 3");
      expect(result).toContain('"Auth System"');
      expect(result).toContain(">>> 2. [running] Implement login endpoints");
      expect(result).toContain("1. [completed] Set up database schema -- PR: https://github.com/org/repo/pull/42");
      expect(result).toContain("dev-agent/task-abc");
      expect(result).toContain("Do NOT revert or undo changes");
      expect(result).toContain("Focus exclusively on this step");
      expect(result).toContain("BASE PROMPT HERE");
    });

    it("omits working tree section when no previous branch", () => {
      const ctx: PlanStepContext = {
        stepNumber: 1,
        totalSteps: 2,
        planName: "Test Plan",
        planId: "plan-xyz",
        steps: [
          { id: "s1", description: "Step 1", status: "running" },
          { id: "s2", description: "Step 2", status: "pending" },
        ],
        currentStepDescription: "Step 1",
      };

      const result = pm.buildPlanPrompt("BASE", ctx);

      expect(result).not.toContain("Working Tree");
      expect(result).not.toContain("Do NOT revert");
      expect(result).toContain(">>> 1. [running] Step 1");
    });
  });
});
