/**
 * Thread context refinement for dev agent tasks.
 *
 * Takes a Slack thread and a raw task description (from the LLM's tool call),
 * uses a fast model to distill relevant thread context into a clean, actionable
 * task prompt. Thread logging to R2 is handled by the calling tool handler.
 */

import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";
import { generateText, type ModelMessage } from "ai";

const unified = createUnified();

const REFINE_MODEL = "google-ai-studio/gemini-2.5-flash";

const REFINE_SYSTEM_PROMPT = `You are a task-refinement assistant. You receive:
1. A Slack thread transcript (the conversation that led to this task)
2. A raw task description that an AI assistant produced from that conversation

Your job: produce a single, clean task description that a developer agent (Claude Code) will use to implement the work. The refined prompt should:

- Incorporate any relevant requirements, decisions, constraints, or context from the thread that the raw task might have missed
- Be specific and actionable — include file paths, API shapes, component names, config details, etc. when they appear in the thread
- Remove Slack-isms (mentions, emoji reactions, casual chat) — write it as a technical spec
- Preserve the original task's intent — don't change scope, just enrich it with thread context
- Be concise — aim for a dense paragraph or short bullet list, not an essay

Output ONLY the refined task description. No preamble, no explanation.`;

export interface ThreadMessage {
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

function formatThread(messages: ThreadMessage[]): string {
  return messages
    .map((m) => {
      const who = m.user ? `<user:${m.user}>` : "<bot>";
      const text = (m.text ?? "").replace(/<@([A-Z0-9]+)>/g, "@$1").trim();
      return `${who}: ${text}`;
    })
    .filter((line) => line.length > 10)
    .join("\n");
}

/**
 * Distill a Slack thread + raw task text into a clean, context-enriched task
 * description suitable for a dev agent.
 *
 * If the thread is empty or very short (≤1 message), skips the LLM call and
 * returns the original task text as-is.
 */
export async function refineTaskFromThread(opts: {
  thread: ThreadMessage[];
  rawTask: string;
  kind: "task" | "plan";
  aiGatewayOpts: { accountId: string; gateway: string; apiKey: string };
}): Promise<string> {
  const { thread, rawTask, kind, aiGatewayOpts } = opts;

  if (thread.length <= 1) {
    return rawTask;
  }

  const threadText = formatThread(thread);
  if (threadText.length < 50) {
    return rawTask;
  }

  const userPrompt = `## Slack Thread\n\n${threadText}\n\n## Raw Task Description\n\n${rawTask}`;

  try {
    const gateway = createAiGateway(aiGatewayOpts);
    const { text } = await generateText({
      model: gateway(unified(REFINE_MODEL)),
      system: REFINE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }] as ModelMessage[],
    });

    const refined = text?.trim();
    if (refined && refined.length > 10) {
      console.log(
        `[refineTask] Refined ${kind}: ${rawTask.length} -> ${refined.length} chars`
      );
      return refined;
    }
  } catch (err) {
    console.error("[refineTask] LLM refinement failed, using raw task:", err);
  }

  return rawTask;
}
