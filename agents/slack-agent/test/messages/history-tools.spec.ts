import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHistoryMCPTools } from "../../src/tools/mcp-handlers/history";
import type { ToolDefinition } from "../../src/tools/types";

function makeMockStore() {
  return {
    search: vi.fn(async () => [
      {
        ts: "1700000001.000000",
        thread_ts: "1700000000.000000",
        channel: "C123",
        user_id: "U789",
        role: "user",
        text_preview: "deploy the app to production",
        created_at: "2023-11-14T22:13:21Z",
        r2_key: "messages/T456/C123/2023-11-14/1700000001.000000.json",
      },
    ]),
    getThread: vi.fn(async () => [
      {
        ts: "1700000000.000000",
        channel: "C123",
        team_id: "T456",
        user: "U789",
        role: "user",
        text: "thread root",
        archived_at: "2024-01-01T00:00:00Z",
      },
      {
        ts: "1700000001.000000",
        thread_ts: "1700000000.000000",
        channel: "C123",
        team_id: "T456",
        role: "assistant",
        text: "reply from bot",
        archived_at: "2024-01-01T00:00:01Z",
      },
    ]),
    getChannel: vi.fn(async () => [
      {
        ts: "1700000005.000000",
        thread_ts: null,
        channel: "C123",
        user_id: "U789",
        role: "user",
        text_preview: "latest message",
        created_at: "2023-11-14T22:13:25Z",
        r2_key: "messages/T456/C123/2023-11-14/1700000005.000000.json",
      },
    ]),
    ensureTable: vi.fn(),
    store: vi.fn(),
    getMessage: vi.fn(),
    storeBatch: vi.fn(),
    existingTimestamps: vi.fn(),
  };
}

describe("History MCP Tools", () => {
  let tools: ToolDefinition[];
  let mockStore: ReturnType<typeof makeMockStore>;

  beforeEach(() => {
    mockStore = makeMockStore();
    tools = createHistoryMCPTools(mockStore as any);
  });

  it("should create 3 tools", () => {
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual([
      "history.search",
      "history.get_thread",
      "history.recent",
    ]);
  });

  describe("history.search", () => {
    it("should call store.search with query and filters", async () => {
      const tool = tools.find((t) => t.name === "history.search")!;
      const result = await tool.handler(
        { query: "deploy", channel: "C123", limit: 10 },
        { agentId: "test", teamId: "T456" }
      );

      expect(mockStore.search).toHaveBeenCalledWith("deploy", {
        query: undefined,
        channel: "C123",
        user: undefined,
        after: undefined,
        before: undefined,
        limit: 10,
      });

      const parsed = JSON.parse(result.content as string);
      expect(parsed.query).toBe("deploy");
      expect(parsed.count).toBe(1);
      expect(parsed.messages[0].preview).toBe("deploy the app to production");
    });

    it("should handle errors gracefully", async () => {
      mockStore.search.mockRejectedValue(new Error("DB error"));
      const tool = tools.find((t) => t.name === "history.search")!;

      const result = await tool.handler(
        { query: "test" },
        { agentId: "test", teamId: "T456" }
      );

      const parsed = JSON.parse(result.content as string);
      expect(parsed.error).toBe("DB error");
    });
  });

  describe("history.get_thread", () => {
    it("should call store.getThread and return formatted messages", async () => {
      const tool = tools.find((t) => t.name === "history.get_thread")!;
      const result = await tool.handler(
        { channel: "C123", thread_ts: "1700000000.000000", team_id: "T456" },
        { agentId: "test", teamId: "T456" }
      );

      expect(mockStore.getThread).toHaveBeenCalledWith(
        "C123",
        "1700000000.000000",
        "T456"
      );

      const parsed = JSON.parse(result.content as string);
      expect(parsed.count).toBe(2);
      expect(parsed.messages[0].text).toBe("thread root");
      expect(parsed.messages[1].text).toBe("reply from bot");
    });

    it("should use default team_id when not provided", async () => {
      const tool = tools.find((t) => t.name === "history.get_thread")!;
      await tool.handler(
        { channel: "C123", thread_ts: "1700000000.000000" },
        { agentId: "test", teamId: "T456" }
      );

      expect(mockStore.getThread).toHaveBeenCalledWith(
        "C123",
        "1700000000.000000",
        "default"
      );
    });

    it("should handle errors gracefully", async () => {
      mockStore.getThread.mockRejectedValue(new Error("R2 error"));
      const tool = tools.find((t) => t.name === "history.get_thread")!;

      const result = await tool.handler(
        { channel: "C123", thread_ts: "1.0" },
        { agentId: "test", teamId: "T456" }
      );

      const parsed = JSON.parse(result.content as string);
      expect(parsed.error).toBe("R2 error");
    });
  });

  describe("history.recent", () => {
    it("should call store.getChannel with correct params", async () => {
      const tool = tools.find((t) => t.name === "history.recent")!;
      const result = await tool.handler(
        { channel: "C123", limit: 20 },
        { agentId: "test", teamId: "T456" }
      );

      expect(mockStore.getChannel).toHaveBeenCalledWith("C123", "default", {
        limit: 20,
        after: undefined,
        before: undefined,
      });

      const parsed = JSON.parse(result.content as string);
      expect(parsed.count).toBe(1);
      expect(parsed.messages[0].preview).toBe("latest message");
    });

    it("should handle errors gracefully", async () => {
      mockStore.getChannel.mockRejectedValue(new Error("timeout"));
      const tool = tools.find((t) => t.name === "history.recent")!;

      const result = await tool.handler(
        { channel: "C123" },
        { agentId: "test", teamId: "T456" }
      );

      const parsed = JSON.parse(result.content as string);
      expect(parsed.error).toBe("timeout");
    });
  });
});
