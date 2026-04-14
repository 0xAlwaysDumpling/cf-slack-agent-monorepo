import { describe, it, expect, beforeEach, vi } from "vitest";
import { MessageStore } from "../../src/messages/store";
import type { StoreMessageInput } from "../../src/messages/types";

function makeMockR2() {
  const objects = new Map<string, string>();
  return {
    put: vi.fn(async (key: string, body: string) => {
      objects.set(key, body);
    }),
    get: vi.fn(async (key: string) => {
      const val = objects.get(key);
      if (!val) return null;
      return {
        text: async () => val,
        json: async () => JSON.parse(val),
      };
    }),
    head: vi.fn(async (key: string) => {
      return objects.has(key) ? { key } : null;
    }),
    list: vi.fn(async () => ({ objects: [] })),
    _objects: objects,
  };
}

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
      if (lastSql.includes("INSERT OR REPLACE")) {
        const existing = rows.findIndex(
          (r) => r.channel === lastBinds[2] && r.ts === lastBinds[0]
        );
        const row = {
          ts: lastBinds[0],
          thread_ts: lastBinds[1],
          channel: lastBinds[2],
          team_id: lastBinds[3],
          user_id: lastBinds[4],
          role: lastBinds[5],
          text_preview: lastBinds[6],
          r2_key: lastBinds[7],
          created_at: lastBinds[8],
        };
        if (existing >= 0) {
          rows[existing] = row;
        } else {
          rows.push(row);
        }
      }
      return { success: true };
    }),
    all: vi.fn(async () => {
      let filtered = [...rows];
      if (lastSql.includes("thread_ts = ?") || lastSql.includes("ts = ?")) {
        const threadTs = lastBinds[1];
        filtered = rows.filter(
          (r) =>
            r.channel === lastBinds[0] &&
            (r.thread_ts === threadTs || r.ts === threadTs)
        );
      } else if (lastSql.includes("text_preview LIKE")) {
        const query = lastBinds[0].replace(/%/g, "");
        filtered = rows.filter(
          (r) => r.text_preview && r.text_preview.includes(query)
        );
      } else if (
        lastSql.includes("channel = ?") &&
        lastSql.includes("team_id = ?")
      ) {
        filtered = rows.filter(
          (r) => r.channel === lastBinds[0] && r.team_id === lastBinds[1]
        );
      } else if (lastSql.includes("ts IN")) {
        const channel = lastBinds[0];
        const timestamps = lastBinds.slice(1);
        filtered = rows.filter(
          (r) => r.channel === channel && timestamps.includes(r.ts)
        );
      }
      return { results: filtered };
    }),
  };

  return {
    exec: vi.fn(async () => {}),
    prepare: vi.fn((sql: string) => {
      lastSql = sql;
      lastBinds = [];
      return stmt;
    }),
    _rows: rows,
    _stmt: stmt,
  };
}

function makeInput(overrides: Partial<StoreMessageInput> = {}): StoreMessageInput {
  return {
    ts: "1700000000.000001",
    channel: "C123",
    team_id: "T456",
    user: "U789",
    text: "Hello world",
    role: "user",
    ...overrides,
  };
}

describe("MessageStore", () => {
  let mockR2: ReturnType<typeof makeMockR2>;
  let mockD1: ReturnType<typeof makeMockD1>;
  let store: MessageStore;

  beforeEach(() => {
    mockR2 = makeMockR2();
    mockD1 = makeMockD1();
    store = new MessageStore(mockR2 as any, mockD1 as any);
  });

  describe("r2Key", () => {
    it("should generate correct key with date partition", () => {
      // 1700000000 = 2023-11-14T22:13:20Z
      const key = MessageStore.r2Key("T456", "C123", "1700000000.000001");
      expect(key).toBe("messages/T456/C123/2023-11-14/1700000000.000001.json");
    });

    it("should handle different timestamps", () => {
      // 1609459200 = 2021-01-01T00:00:00Z
      const key = MessageStore.r2Key("T1", "C1", "1609459200.000000");
      expect(key).toBe("messages/T1/C1/2021-01-01/1609459200.000000.json");
    });
  });

  describe("ensureTable", () => {
    it("should run CREATE TABLE on first use", async () => {
      await store.ensureTable();
      // 3 prepare calls: CREATE TABLE + 2 CREATE INDEX
      expect(mockD1.prepare).toHaveBeenCalledTimes(3);
      const firstSql = mockD1.prepare.mock.calls[0][0];
      expect(firstSql).toContain("CREATE TABLE IF NOT EXISTS messages");
    });

    it("should not re-create on subsequent calls", async () => {
      await store.ensureTable();
      const callCount = mockD1.prepare.mock.calls.length;
      await store.ensureTable();
      // No additional prepare calls
      expect(mockD1.prepare).toHaveBeenCalledTimes(callCount);
    });
  });

  describe("store", () => {
    it("should write to R2 with correct key", async () => {
      const input = makeInput();
      await store.store(input);

      expect(mockR2.put).toHaveBeenCalledTimes(1);
      const [key, body] = mockR2.put.mock.calls[0];
      expect(key).toContain("messages/T456/C123/");
      expect(key).toContain("1700000000.000001.json");

      const parsed = JSON.parse(body);
      expect(parsed.ts).toBe("1700000000.000001");
      expect(parsed.text).toBe("Hello world");
      expect(parsed.archived_at).toBeDefined();
    });

    it("should upsert D1 index row", async () => {
      const input = makeInput();
      await store.store(input);

      expect(mockD1._stmt.bind).toHaveBeenCalled();
      expect(mockD1._stmt.run).toHaveBeenCalled();
      expect(mockD1._rows).toHaveLength(1);
      expect(mockD1._rows[0].ts).toBe("1700000000.000001");
      expect(mockD1._rows[0].text_preview).toBe("Hello world");
    });

    it("should truncate text_preview to limit", async () => {
      const longText = "a".repeat(600);
      await store.store(makeInput({ text: longText }));

      expect(mockD1._rows[0].text_preview.length).toBe(500);
    });

    it("should handle null text", async () => {
      await store.store(makeInput({ text: undefined }));
      expect(mockD1._rows[0].text_preview).toBeNull();
    });

    it("should be idempotent (INSERT OR REPLACE)", async () => {
      const input = makeInput();
      await store.store(input);
      await store.store(input);

      expect(mockD1._rows).toHaveLength(1);
    });

    it("should store thread_ts when present", async () => {
      await store.store(makeInput({ thread_ts: "1700000000.000000" }));

      expect(mockD1._rows[0].thread_ts).toBe("1700000000.000000");
    });
  });

  describe("getMessage", () => {
    it("should return message from R2", async () => {
      await store.store(makeInput());

      const msg = await store.getMessage("C123", "1700000000.000001", "T456");
      expect(msg).not.toBeNull();
      expect(msg!.text).toBe("Hello world");
      expect(msg!.role).toBe("user");
    });

    it("should return null for missing message", async () => {
      const msg = await store.getMessage("C123", "9999999999.000000", "T456");
      expect(msg).toBeNull();
    });
  });

  describe("getThread", () => {
    it("should return all messages in a thread sorted by ts", async () => {
      const threadTs = "1700000000.000000";
      await store.store(makeInput({ ts: threadTs, text: "root" }));
      await store.store(
        makeInput({ ts: "1700000001.000000", thread_ts: threadTs, text: "reply 1" })
      );
      await store.store(
        makeInput({ ts: "1700000002.000000", thread_ts: threadTs, text: "reply 2" })
      );

      const thread = await store.getThread("C123", threadTs, "T456");
      expect(thread).toHaveLength(3);
      expect(thread[0].text).toBe("root");
      expect(thread[1].text).toBe("reply 1");
      expect(thread[2].text).toBe("reply 2");
    });

    it("should return empty array for non-existent thread", async () => {
      const thread = await store.getThread("C123", "9999999999.000000", "T456");
      expect(thread).toHaveLength(0);
    });
  });

  describe("search", () => {
    it("should find messages by text content", async () => {
      await store.store(makeInput({ ts: "1700000001.000000", text: "deploy the app" }));
      await store.store(makeInput({ ts: "1700000002.000000", text: "check the logs" }));

      const results = await store.search("deploy");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.text_preview?.includes("deploy"))).toBe(true);
    });

    it("should return empty for no matches", async () => {
      await store.store(makeInput({ text: "hello world" }));
      const results = await store.search("nonexistent");
      expect(results).toHaveLength(0);
    });
  });

  describe("storeBatch", () => {
    it("should skip messages that already exist in R2", async () => {
      await store.store(makeInput({ ts: "1700000001.000000", text: "existing" }));

      const count = await store.storeBatch([
        makeInput({ ts: "1700000001.000000", text: "existing" }),
        makeInput({ ts: "1700000002.000000", text: "new one" }),
      ]);

      expect(count).toBe(1);
    });

    it("should return 0 for empty input", async () => {
      const count = await store.storeBatch([]);
      expect(count).toBe(0);
    });
  });

  describe("existingTimestamps", () => {
    it("should return set of existing timestamps", async () => {
      await store.store(makeInput({ ts: "1700000001.000000" }));
      await store.store(makeInput({ ts: "1700000002.000000" }));

      const existing = await store.existingTimestamps("C123", [
        "1700000001.000000",
        "1700000002.000000",
        "1700000003.000000",
      ]);

      expect(existing.has("1700000001.000000")).toBe(true);
      expect(existing.has("1700000002.000000")).toBe(true);
      expect(existing.has("1700000003.000000")).toBe(false);
    });

    it("should return empty set for empty input", async () => {
      const existing = await store.existingTimestamps("C123", []);
      expect(existing.size).toBe(0);
    });
  });
});
