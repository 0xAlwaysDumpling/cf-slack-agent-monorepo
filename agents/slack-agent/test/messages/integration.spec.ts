import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { MessageStore } from "../../src/messages/store";

describe("MessageStore integration", () => {
  let store: MessageStore;

  beforeEach(async () => {
    // @ts-expect-error - env bindings from wrangler.jsonc
    store = new MessageStore(env.MESSAGES_BUCKET, env.JOBS_DB);
    // Reset the D1 table for a clean slate
    // @ts-expect-error - env bindings
    await env.JOBS_DB.prepare("DROP TABLE IF EXISTS messages").run();
    // Force table re-creation
    (store as any).tableReady = false;
    await store.ensureTable();
  });

  it("should round-trip store and retrieve a message", async () => {
    await store.store({
      ts: "1700000001.000000",
      channel: "C_INT_TEST",
      team_id: "T_INT",
      user: "U_INT",
      text: "integration test message",
      role: "user",
    });

    const msg = await store.getMessage("C_INT_TEST", "1700000001.000000", "T_INT");
    expect(msg).not.toBeNull();
    expect(msg!.ts).toBe("1700000001.000000");
    expect(msg!.text).toBe("integration test message");
    expect(msg!.role).toBe("user");
    expect(msg!.user).toBe("U_INT");
    expect(msg!.archived_at).toBeDefined();
  });

  it("should assemble a thread from multiple messages", async () => {
    const threadTs = "1700000010.000000";

    await store.store({
      ts: threadTs,
      channel: "C_INT_TEST",
      team_id: "T_INT",
      user: "U1",
      text: "thread root",
      role: "user",
    });

    for (let i = 1; i <= 4; i++) {
      await store.store({
        ts: `170000001${i}.000000`,
        thread_ts: threadTs,
        channel: "C_INT_TEST",
        team_id: "T_INT",
        user: i % 2 === 0 ? "U1" : "U2",
        text: `reply ${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
      });
    }

    const thread = await store.getThread("C_INT_TEST", threadTs, "T_INT");
    expect(thread).toHaveLength(5);
    expect(thread[0].text).toBe("thread root");
    expect(thread[4].text).toBe("reply 4");

    // Verify ordering
    for (let i = 0; i < thread.length - 1; i++) {
      expect(parseFloat(thread[i].ts)).toBeLessThan(parseFloat(thread[i + 1].ts));
    }
  });

  it("should search messages by text", async () => {
    await store.store({
      ts: "1700000020.000000",
      channel: "C_INT_TEST",
      team_id: "T_INT",
      user: "U1",
      text: "deploy the new version to staging",
      role: "user",
    });

    await store.store({
      ts: "1700000021.000000",
      channel: "C_INT_TEST",
      team_id: "T_INT",
      user: "U2",
      text: "check the production logs",
      role: "user",
    });

    const results = await store.search("staging");
    expect(results.length).toBe(1);
    expect(results[0].text_preview).toContain("staging");
    expect(results[0].ts).toBe("1700000020.000000");
  });

  it("should be idempotent on duplicate store", async () => {
    const input = {
      ts: "1700000030.000000",
      channel: "C_INT_TEST",
      team_id: "T_INT",
      user: "U1",
      text: "should be unique",
      role: "user" as const,
    };

    await store.store(input);
    await store.store(input);

    const results = await store.search("should be unique");
    expect(results).toHaveLength(1);

    // Verify R2 has the object
    const msg = await store.getMessage("C_INT_TEST", "1700000030.000000", "T_INT");
    expect(msg).not.toBeNull();
  });

  it("should get channel history", async () => {
    for (let i = 0; i < 5; i++) {
      await store.store({
        ts: `170000004${i}.000000`,
        channel: "C_CHAN_TEST",
        team_id: "T_INT",
        user: "U1",
        text: `channel msg ${i}`,
        role: "user",
      });
    }

    const results = await store.getChannel("C_CHAN_TEST", "T_INT", { limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("should track existing timestamps", async () => {
    await store.store({
      ts: "1700000050.000000",
      channel: "C_TS_TEST",
      team_id: "T_INT",
      user: "U1",
      text: "exists",
      role: "user",
    });

    const existing = await store.existingTimestamps("C_TS_TEST", [
      "1700000050.000000",
      "1700000051.000000",
    ]);

    expect(existing.has("1700000050.000000")).toBe(true);
    expect(existing.has("1700000051.000000")).toBe(false);
  });

  it("should batch store and skip existing", async () => {
    await store.store({
      ts: "1700000060.000000",
      channel: "C_BATCH",
      team_id: "T_INT",
      user: "U1",
      text: "already here",
      role: "user",
    });

    const count = await store.storeBatch([
      {
        ts: "1700000060.000000",
        channel: "C_BATCH",
        team_id: "T_INT",
        user: "U1",
        text: "already here",
        role: "user",
      },
      {
        ts: "1700000061.000000",
        channel: "C_BATCH",
        team_id: "T_INT",
        user: "U2",
        text: "brand new",
        role: "user",
      },
    ]);

    expect(count).toBe(1);

    const msg = await store.getMessage("C_BATCH", "1700000061.000000", "T_INT");
    expect(msg).not.toBeNull();
    expect(msg!.text).toBe("brand new");
  });
});
