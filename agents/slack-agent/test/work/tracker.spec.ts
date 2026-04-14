import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkTracker } from "../../src/work/tracker";

function makeMockD1() {
  const rows: Record<string, any>[] = [];
  let lastSql = "";
  let lastBinds: any[] = [];

  const stmt = {
    bind: vi.fn((...args: any[]) => {
      lastBinds = args;
      return stmt;
    }),
    run: vi.fn(async () => {
      if (lastSql.includes("INSERT INTO")) {
        rows.push({
          id: lastBinds[0],
          type: lastBinds[1],
          dev_agent_id: lastBinds[2],
          repo: lastBinds[3],
          description: lastBinds[4],
          status: lastBinds[5],
          channel: lastBinds[6],
          thread_ts: lastBinds[7],
          team_id: lastBinds[8],
          created_by: lastBinds[9],
          created_at: lastBinds[10],
          updated_at: lastBinds[11],
        });
      } else if (lastSql.includes("UPDATE")) {
        const devAgentId = lastBinds[lastBinds.length - 1];
        const row = rows.find((r) => r.dev_agent_id === devAgentId);
        if (row) {
          if (lastBinds[0] != null) row.status = lastBinds[0];
          if (lastBinds[1] != null) row.outcome = lastBinds[1];
          if (lastBinds[2] != null) row.pr_url = lastBinds[2];
          if (lastBinds[3] != null) row.branch_name = lastBinds[3];
          if (lastBinds[4] != null) row.error = lastBinds[4];
          if (lastBinds[5] != null) row.summary = lastBinds[5];
          row.updated_at = lastBinds[6];
        }
      }
      return { success: true };
    }),
    first: vi.fn(async () => {
      if (lastSql.includes("WHERE dev_agent_id")) {
        return rows.find((r) => r.dev_agent_id === lastBinds[0]) ?? null;
      }
      return null;
    }),
    all: vi.fn(async () => {
      let filtered = [...rows];
      if (lastSql.includes("WHERE channel = ? AND thread_ts = ?")) {
        filtered = rows.filter(
          (r) => r.channel === lastBinds[0] && r.thread_ts === lastBinds[1],
        );
      } else if (lastSql.includes("status IN")) {
        filtered = rows.filter(
          (r) => r.status === "pending" || r.status === "running",
        );
      } else if (lastSql.includes("WHERE") && lastBinds.length > 0) {
        // General search - simplified filter
        if (lastSql.includes("repo LIKE")) {
          const repoQuery = (lastBinds[0] as string).replace(/%/g, "");
          filtered = rows.filter((r) => r.repo?.includes(repoQuery));
        }
      }
      return { results: filtered };
    }),
  };

  return {
    prepare: vi.fn((sql: string) => {
      lastSql = sql;
      lastBinds = [];
      return stmt;
    }),
    _rows: rows,
    _stmt: stmt,
  };
}

describe("WorkTracker", () => {
  let db: ReturnType<typeof makeMockD1>;
  let tracker: WorkTracker;

  beforeEach(() => {
    db = makeMockD1();
    tracker = new WorkTracker(db as unknown as D1Database);
  });

  describe("track()", () => {
    it("creates a work item and stores it in D1", async () => {
      const item = await tracker.track({
        type: "task",
        devAgentId: "task-abc123",
        repo: "https://github.com/org/repo",
        description: "Implement auth system",
        channel: "C123",
        threadTs: "1234.5678",
        teamId: "T001",
        createdBy: "U001",
      });

      expect(item.id).toBeTruthy();
      expect(item.type).toBe("task");
      expect(item.devAgentId).toBe("task-abc123");
      expect(item.status).toBe("pending");
      expect(item.channel).toBe("C123");
      expect(item.threadTs).toBe("1234.5678");
      expect(item.createdBy).toBe("U001");
      expect(db._rows).toHaveLength(1);
    });
  });

  describe("updateStatus()", () => {
    it("updates status and outcome for an existing work item", async () => {
      await tracker.track({
        type: "task",
        devAgentId: "task-xyz",
        repo: "https://github.com/org/repo",
        description: "Build feature",
        channel: "C123",
        threadTs: "1234.5678",
        teamId: "T001",
      });

      const updated = await tracker.updateStatus("task-xyz", {
        status: "completed",
        outcome: "pr_created",
        prUrl: "https://github.com/org/repo/pull/42",
      });

      expect(updated).toBeTruthy();
      const row = db._rows.find((r) => r.dev_agent_id === "task-xyz");
      expect(row?.status).toBe("completed");
      expect(row?.outcome).toBe("pr_created");
      expect(row?.pr_url).toBe("https://github.com/org/repo/pull/42");
    });

    it("returns null for non-existent work item", async () => {
      const result = await tracker.updateStatus("nonexistent", {
        status: "completed",
      });
      expect(result).toBeNull();
    });
  });

  describe("getByDevAgentId()", () => {
    it("retrieves a work item by dev agent ID", async () => {
      await tracker.track({
        type: "plan",
        devAgentId: "plan-abc",
        repo: "https://github.com/org/repo",
        description: "Plan: Auth System",
        channel: "C123",
        threadTs: "1234.5678",
        teamId: "T001",
      });

      const item = await tracker.getByDevAgentId("plan-abc");
      expect(item).toBeTruthy();
      expect(item!.type).toBe("plan");
      expect(item!.devAgentId).toBe("plan-abc");
    });

    it("returns null for missing ID", async () => {
      const item = await tracker.getByDevAgentId("nonexistent");
      expect(item).toBeNull();
    });
  });

  describe("getByThread()", () => {
    it("returns all work items for a thread", async () => {
      await tracker.track({
        type: "task",
        devAgentId: "task-1",
        repo: "https://github.com/org/repo",
        description: "Task 1",
        channel: "C123",
        threadTs: "1234.5678",
        teamId: "T001",
      });

      await tracker.track({
        type: "task",
        devAgentId: "task-2",
        repo: "https://github.com/org/repo",
        description: "Task 2",
        channel: "C123",
        threadTs: "1234.5678",
        teamId: "T001",
      });

      await tracker.track({
        type: "task",
        devAgentId: "task-3",
        repo: "https://github.com/org/repo",
        description: "Different thread",
        channel: "C456",
        threadTs: "9999.0000",
        teamId: "T001",
      });

      const items = await tracker.getByThread("C123", "1234.5678");
      expect(items).toHaveLength(2);
    });
  });

  describe("getActive()", () => {
    it("returns only pending and running items", async () => {
      await tracker.track({
        type: "task",
        devAgentId: "running-task",
        repo: "https://github.com/org/repo",
        description: "Running",
        channel: "C123",
        threadTs: "1234.5678",
        teamId: "T001",
      });

      // Manually set status on the row to simulate completed
      db._rows.push({
        id: "old",
        type: "task",
        dev_agent_id: "completed-task",
        repo: "https://github.com/org/repo",
        description: "Completed",
        status: "completed",
        channel: "C123",
        thread_ts: "1234.5678",
        team_id: "T001",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const active = await tracker.getActive();
      expect(active).toHaveLength(1);
      expect(active[0].devAgentId).toBe("running-task");
    });
  });

  describe("search()", () => {
    it("searches by repo", async () => {
      await tracker.track({
        type: "task",
        devAgentId: "task-1",
        repo: "https://github.com/org/auth-service",
        description: "Auth feature",
        channel: "C123",
        threadTs: "1234.5678",
        teamId: "T001",
      });

      const results = await tracker.search({ repo: "auth-service" });
      expect(results).toHaveLength(1);
    });
  });

  describe("ensureTable()", () => {
    it("creates the table and indexes", async () => {
      await tracker.ensureTable();
      const calls = db.prepare.mock.calls.map((c) => c[0] as string);
      expect(calls.some((sql) => sql.includes("CREATE TABLE"))).toBe(true);
      expect(calls.some((sql) => sql.includes("idx_work_status"))).toBe(true);
      expect(calls.some((sql) => sql.includes("idx_work_channel"))).toBe(true);
      expect(calls.some((sql) => sql.includes("idx_work_repo"))).toBe(true);
      expect(calls.some((sql) => sql.includes("idx_work_dev_agent_id"))).toBe(true);
    });

    it("only creates table once", async () => {
      await tracker.ensureTable();
      await tracker.ensureTable();
      const createCalls = db.prepare.mock.calls.filter(
        (c) => (c[0] as string).includes("CREATE TABLE"),
      );
      expect(createCalls).toHaveLength(1);
    });
  });
});
