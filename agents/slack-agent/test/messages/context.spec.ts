import { describe, it, expect } from "vitest";
import {
  buildThreadContext,
  estimateTokens,
  injectCompactSummary,
} from "../../src/messages/context";
import type { ArchivedMessage } from "../../src/messages/types";

function makeMessage(
  ts: string,
  text: string,
  overrides: Partial<ArchivedMessage> = {}
): ArchivedMessage {
  return {
    ts,
    channel: "C123",
    team_id: "T456",
    role: "user",
    text,
    archived_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("estimateTokens", () => {
  it("should estimate ~1 token per 4 chars", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("a")).toBe(1);
  });

  it("should return 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("buildThreadContext", () => {
  it("should return empty result for empty input", () => {
    const result = buildThreadContext([]);
    expect(result.messages).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.root).toBeNull();
    expect(result.wasTrimmed).toBe(false);
  });

  it("should return single message as-is", () => {
    const msgs = [makeMessage("1.0", "hello")];
    const result = buildThreadContext(msgs);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe("hello");
    expect(result.root?.text).toBe("hello");
    expect(result.dropped).toHaveLength(0);
    expect(result.wasTrimmed).toBe(false);
  });

  it("should return all messages when under budget", () => {
    const msgs = [
      makeMessage("1.0", "first"),
      makeMessage("2.0", "second"),
      makeMessage("3.0", "third"),
    ];
    const result = buildThreadContext(msgs, 100000);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].text).toBe("first");
    expect(result.messages[2].text).toBe("third");
    expect(result.dropped).toHaveLength(0);
    expect(result.wasTrimmed).toBe(false);
  });

  it("should preserve first message and recent messages when over budget", () => {
    const msgs: ArchivedMessage[] = [];
    msgs.push(makeMessage("1.0", "thread root"));
    for (let i = 1; i <= 100; i++) {
      msgs.push(makeMessage(`${i + 1}.0`, "x".repeat(100)));
    }

    const result = buildThreadContext(msgs, 500);

    expect(result.messages[0].text).toBe("thread root");
    expect(result.messages[1].text).toContain("earlier messages omitted");
    expect(result.messages.length).toBeGreaterThan(2);
    expect(result.messages.length).toBeLessThan(msgs.length);
    expect(result.messages[result.messages.length - 1].ts).toBe("101.0");
    expect(result.wasTrimmed).toBe(true);
    expect(result.root?.text).toBe("thread root");
  });

  it("should return dropped messages when trimming", () => {
    const msgs: ArchivedMessage[] = [];
    msgs.push(makeMessage("1.0", "thread root"));
    for (let i = 1; i <= 100; i++) {
      msgs.push(makeMessage(`${i + 1}.0`, "x".repeat(100)));
    }

    const result = buildThreadContext(msgs, 500);

    expect(result.dropped.length).toBeGreaterThan(0);
    expect(result.dropped.length + result.messages.length - 2).toBe(100);
    // Dropped messages should be from the beginning (after root)
    expect(parseFloat(result.dropped[0].ts)).toBeLessThan(
      parseFloat(result.messages[result.messages.length - 1].ts)
    );
  });

  it("should sort messages by ts before processing", () => {
    const msgs = [
      makeMessage("3.0", "third"),
      makeMessage("1.0", "first"),
      makeMessage("2.0", "second"),
    ];
    const result = buildThreadContext(msgs, 100000);
    expect(result.messages[0].text).toBe("first");
    expect(result.messages[1].text).toBe("second");
    expect(result.messages[2].text).toBe("third");
  });

  it("should always include first message even if it alone exceeds budget", () => {
    const bigText = "x".repeat(10000);
    const msgs = [makeMessage("1.0", bigText), makeMessage("2.0", "small")];
    const result = buildThreadContext(msgs, 10);

    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.messages[0].text).toBe(bigText);
  });

  it("should insert marker showing count of omitted messages", () => {
    const msgs: ArchivedMessage[] = [];
    for (let i = 0; i < 50; i++) {
      msgs.push(makeMessage(`${i + 1}.0`, "y".repeat(200)));
    }

    const result = buildThreadContext(msgs, 200);

    const marker = result.messages.find((m) => m.text?.includes("omitted"));
    expect(marker).toBeDefined();
    expect(marker!.text).toMatch(/\d+ earlier messages omitted/);
  });

  it("should not insert marker when all messages fit", () => {
    const msgs = [
      makeMessage("1.0", "a"),
      makeMessage("2.0", "b"),
      makeMessage("3.0", "c"),
    ];
    const result = buildThreadContext(msgs, 100000);
    const marker = result.messages.find((m) => m.text?.includes("omitted"));
    expect(marker).toBeUndefined();
    expect(result.wasTrimmed).toBe(false);
  });
});

describe("injectCompactSummary", () => {
  it("should replace the omission marker with a summary", () => {
    const messages: ArchivedMessage[] = [
      makeMessage("1.0", "root"),
      {
        ...makeMessage("0", "[5 earlier messages omitted for context length]"),
        ts: "0",
        role: "assistant",
      },
      makeMessage("10.0", "recent"),
    ];

    const result = injectCompactSummary(messages, "Here is a summary.", 5);

    expect(result[1].text).toContain("Summary of 5 earlier messages");
    expect(result[1].text).toContain("Here is a summary.");
    expect(result[0].text).toBe("root");
    expect(result[2].text).toBe("recent");
  });

  it("should not modify messages without an omission marker", () => {
    const messages: ArchivedMessage[] = [
      makeMessage("1.0", "root"),
      makeMessage("2.0", "middle"),
      makeMessage("3.0", "recent"),
    ];

    const result = injectCompactSummary(messages, "Summary", 0);

    expect(result[0].text).toBe("root");
    expect(result[1].text).toBe("middle");
    expect(result[2].text).toBe("recent");
  });
});
