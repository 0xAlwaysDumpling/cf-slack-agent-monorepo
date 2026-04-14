/**
 * Thread compaction — LLM-based summarization of dropped middle messages.
 *
 * When a thread exceeds the token budget, buildThreadContext preserves the
 * root + recent tail and drops middle messages. This module summarises those
 * dropped messages so the model retains meaningful context instead of a bare
 * "[N earlier messages omitted]" marker.
 *
 * Prompt structure follows the Claude Code compact pattern:
 *   <analysis> (scratchpad, stripped before insertion) → <summary>
 */

import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";
import { generateText, type ModelMessage } from "ai";
import type { ArchivedMessage } from "./types";
import {
  COMPACT_MODEL,
  COMPACT_MIN_DROPPED_MESSAGES,
  CHARS_PER_TOKEN_ESTIMATE,
} from "../config/constants";

const unified = createUnified();

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const COMPACT_SYSTEM_PROMPT = `You are summarizing the middle portion of a Slack thread that was dropped to fit a context window. The thread root and recent messages are preserved separately — your summary bridges the gap so nothing important is lost.

Before providing your summary, wrap your reasoning in <analysis> tags. In your analysis:

1. Walk through the dropped messages chronologically. For each section identify:
   - What the user asked or said
   - What the assistant answered, did, or decided
   - Key facts, data, or links shared
   - Tool calls and their outcomes (task created, PR opened, deploy status, etc.)
   - Errors encountered and how they were resolved
   - Any decisions or conclusions reached
2. Note which details are still likely relevant to the ongoing conversation vs. stale.

Then provide your final output inside <summary> tags with the following sections:

1. **Discussion Overview**: 1-2 sentence recap of what this portion of the thread covered.
2. **Key Decisions & Conclusions**: Bullet list of decisions made, answers given, or conclusions reached.
3. **Actions Taken**: Tool calls, tasks created, PRs opened, deploys triggered — anything that changed state.
4. **Important Context**: Technical details, links, data, code snippets, or config that might be referenced later.
5. **Unresolved Items**: Open questions or pending work from this section (if any).

Guidelines:
- Be concise but preserve specifics — IDs, URLs, branch names, error messages, repo names.
- If a tool was called and returned a result, note both the action and the outcome.
- Omit small talk, greetings, acknowledgements, and redundant back-and-forth.
- Do NOT invent information that isn't in the messages.
- Write in third person ("The user asked…", "The assistant created…").

Output ONLY the <analysis> and <summary> blocks. No other text.`;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatMessagesForCompaction(messages: ArchivedMessage[]): string {
  return messages
    .map((m) => {
      const who = m.role === "user" ? `[user${m.user ? `:${m.user}` : ""}]` : "[assistant]";
      const text = (m.text ?? "").replace(/<@([A-Z0-9]+)>/g, "@$1").trim();
      return `${who} ${text}`;
    })
    .filter((line) => line.length > 15)
    .join("\n");
}

/**
 * Strip the <analysis> scratchpad and extract <summary> content.
 * Mirrors the Claude Code formatCompactSummary pattern.
 */
export function formatCompactSummary(raw: string): string {
  let result = raw;

  result = result.replace(/<analysis>[\s\S]*?<\/analysis>/, "");

  const summaryMatch = result.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    result = summaryMatch[1] ?? "";
  }

  return result.replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// Main compaction function
// ---------------------------------------------------------------------------

export interface CompactResult {
  summary: string;
  droppedCount: number;
  modelUsed: string;
}

/**
 * Summarise a batch of dropped messages using a fast LLM.
 *
 * Returns null if the input is too small to bother summarising (fewer than
 * COMPACT_MIN_DROPPED_MESSAGES or very short text).
 */
export async function compactMessages(opts: {
  dropped: ArchivedMessage[];
  threadRoot?: ArchivedMessage;
  aiGatewayOpts: { accountId: string; gateway: string; apiKey: string };
}): Promise<CompactResult | null> {
  const { dropped, threadRoot, aiGatewayOpts } = opts;

  if (dropped.length < COMPACT_MIN_DROPPED_MESSAGES) {
    return null;
  }

  const formatted = formatMessagesForCompaction(dropped);
  if (formatted.length < 80) {
    return null;
  }

  const rootContext = threadRoot
    ? `## Thread Root\n\n${(threadRoot.text ?? "").trim()}\n\n`
    : "";

  const userPrompt = `${rootContext}## Dropped Messages (${dropped.length} messages)\n\n${formatted}`;

  try {
    const gateway = createAiGateway(aiGatewayOpts);
    const { text } = await generateText({
      model: gateway(unified(COMPACT_MODEL)),
      system: COMPACT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }] as ModelMessage[],
    });

    const summary = formatCompactSummary(text ?? "");
    if (summary.length < 20) {
      return null;
    }

    console.log(
      `[compact] Summarised ${dropped.length} messages (${formatted.length} chars → ${summary.length} chars)`
    );

    return {
      summary,
      droppedCount: dropped.length,
      modelUsed: COMPACT_MODEL,
    };
  } catch (err) {
    console.error("[compact] LLM summarisation failed, falling back to omission marker:", err);
    return null;
  }
}

/**
 * Estimate the token cost of the compaction summary itself so callers can
 * account for it in the overall token budget.
 */
export function estimateSummaryTokens(summary: string): number {
  return Math.ceil(summary.length / CHARS_PER_TOKEN_ESTIMATE);
}
