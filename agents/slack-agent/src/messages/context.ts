import type { ArchivedMessage } from "./types";
import {
  CONTEXT_BUDGET_TOKENS,
  CHARS_PER_TOKEN_ESTIMATE,
} from "../config/constants";

/**
 * Estimate token count for a message using a simple chars/4 heuristic.
 * Good enough for budgeting; the actual tokenizer runs server-side.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function messageTokenCost(msg: ArchivedMessage): number {
  let chars = (msg.text ?? "").length;
  if (msg.files) {
    for (const f of msg.files) {
      if (f.imageData) chars += 1000;
      chars += (f.name ?? "").length;
    }
  }
  return estimateTokens(String(chars > 0 ? msg.text ?? "" : ""));
}

export interface ThreadContextResult {
  messages: ArchivedMessage[];
  /** Messages that were dropped from the middle to fit the budget. Empty if everything fit. */
  dropped: ArchivedMessage[];
  /** The thread root message (always preserved). */
  root: ArchivedMessage | null;
  /** Whether any messages were trimmed. */
  wasTrimmed: boolean;
}

/**
 * Build a context window from a thread of archived messages.
 *
 * Strategy: always keep the first message (thread root) and pack as many
 * recent messages as fit within the token budget, working backwards from
 * the end. If messages were trimmed from the middle, a synthetic marker
 * is inserted so the model knows context was elided.
 *
 * Returns both the windowed messages and the dropped messages so callers
 * can optionally run LLM compaction on the dropped portion.
 */
export function buildThreadContext(
  messages: ArchivedMessage[],
  tokenBudget: number = CONTEXT_BUDGET_TOKENS
): ThreadContextResult {
  if (messages.length === 0)
    return { messages: [], dropped: [], root: null, wasTrimmed: false };
  if (messages.length === 1)
    return { messages, dropped: [], root: messages[0], wasTrimmed: false };

  const sorted = [...messages].sort(
    (a, b) => parseFloat(a.ts) - parseFloat(b.ts)
  );

  const first = sorted[0];
  const rest = sorted.slice(1);
  const firstCost = messageTokenCost(first);

  let remaining = tokenBudget - firstCost;

  // Walk from the end, accumulating messages that fit
  const included: ArchivedMessage[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = messageTokenCost(rest[i]);
    if (remaining - cost < 0) break;
    remaining -= cost;
    included.unshift(rest[i]);
  }

  // If everything fit, return as-is
  if (included.length === rest.length) {
    return { messages: sorted, dropped: [], root: first, wasTrimmed: false };
  }

  const droppedCount = rest.length - included.length;
  const dropped = rest.slice(0, droppedCount);

  const marker: ArchivedMessage = {
    ts: "0",
    channel: first.channel,
    team_id: first.team_id,
    role: "assistant",
    text: `[${droppedCount} earlier messages omitted for context length]`,
    archived_at: first.archived_at,
  };

  return {
    messages: [first, marker, ...included],
    dropped,
    root: first,
    wasTrimmed: true,
  };
}

/**
 * Replace the omission marker in a windowed context with a compaction summary.
 */
export function injectCompactSummary(
  messages: ArchivedMessage[],
  summary: string,
  droppedCount: number,
): ArchivedMessage[] {
  return messages.map((m) => {
    if (m.ts === "0" && m.text?.includes("earlier messages omitted")) {
      return {
        ...m,
        text: `[Summary of ${droppedCount} earlier messages]\n\n${summary}`,
      };
    }
    return m;
  });
}
