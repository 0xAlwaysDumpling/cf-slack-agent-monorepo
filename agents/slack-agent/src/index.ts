import { env } from "cloudflare:workers";
import { SlackAgent } from "./slack";
import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";
import { generateText, tool, stepCountIs, jsonSchema, type ModelMessage } from "ai";
import { getProviderModel } from "./config/providers";
import { PromptManager } from "./config/promptManager";
import { isModelsCommand, formatModelsForSlack } from "./config/models";
import { PromptRegistry } from "./prompts/registry";
import { PromptComposer } from "./prompts/composer";
import { PromptMCPServer } from "./prompts/mcp-server";
import { ToolDiscovery } from "./tools/discovery";
import { EventBasedCache } from "./tools/cache";
import { MCPBridge } from "./tools/mcp-bridge";
import { createPromptMCPTools } from "./tools/mcp-handlers/prompts";
import { createLogsMCPTools } from "./tools/mcp-handlers/logs";
import { createDiscoveryMCPTools } from "./tools/mcp-handlers/discovery";
import { ImageProcessor, supportsImageProcessing } from "./tools/image-processor";
import { createD1MCPTools } from "./tools/mcp-handlers/d1";
import { createAIGatewayMCPTools } from "./tools/mcp-handlers/ai-gateway";
import { createRailwayMCPTools } from "./tools/mcp-handlers/railway";
import { createDevAgentMCPTools } from "./tools/mcp-handlers/dev-agent";
import { createDevPromptMCPTools } from "./tools/mcp-handlers/dev-prompts";
import { createWorkMCPTools } from "./tools/mcp-handlers/work";
import { createGitHubMCPTools } from "./tools/mcp-handlers/github";
import { createPagesMCPTools } from "./tools/mcp-handlers/pages";
import { createResourceMCPTools } from "./tools/mcp-handlers/resources";
import { createHistoryMCPTools } from "./tools/mcp-handlers/history";
import { WorkTracker } from "./work/tracker";
import type { CallbackPayload } from "./work/types";
import { ReportRunner } from "./reports/runner";
import type { ReportConfig } from "./reports/types";
import { MessageStore } from "./messages/store";
import { buildThreadContext, injectCompactSummary } from "./messages/context";
import { compactMessages } from "./messages/compact";
import type { StoreMessageInput } from "./messages/types";
import {
  AGENT_ID,
  DEFAULT_TEAM_ID,
  DEFAULT_REPORT_CHANNEL_ID,
  MAX_AGENT_TOOL_STEPS,
  MAX_TOOL_RESULT_CHARS,
  CONTEXT_BUDGET_TOKENS,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_WIDTH,
  IMAGE_MAX_HEIGHT,
  KV_KEY_REPORT_CONFIGS,
  KV_KEY_TOOL_GRAPH_HASH,
  PROMPT_KEY_MENTIONED,
  PROMPT_KEY_THREAD_REPLY,
  PROMPT_KEY_DAILY_REPORT,
  CHANNEL_CONFIGS,
} from "./config/constants";

const unified = createUnified();

const DEFAULT_REPORT_CONFIGS: ReportConfig[] = [
  {
    id: "apy-farm-daily",
    name: "APY Farm Daily",
    schedule: "0 13 * * *",
    channel: DEFAULT_REPORT_CHANNEL_ID,
    promptKey: PROMPT_KEY_DAILY_REPORT,
    enabled: true,
  },
];

type SlackFile = {
  id: string;
  name: string;
  title?: string;
  mimetype?: string;
  url_private?: string;
  imageData?: string; // base64 data URL after processing
};

type SlackMsg = {
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  files?: SlackFile[];
};

function normalizeForLLM(msgs: SlackMsg[], selfUserId: string, supportsImages: boolean): ModelMessage[] {
  return msgs.map((m) => {
    const role = m.user && m.user !== selfUserId ? "user" as const : "assistant" as const;
    const text = (m.text ?? "").replace(/<@([A-Z0-9]+)>/g, "@$1");
    
    // If model doesn't support images or no files, return text only
    if (!supportsImages || !m.files || m.files.length === 0) {
      return { role, content: text };
    }

    // Build multimodal content with text and images
    const content: any[] = [];
    
    if (text) {
      content.push({ type: 'text', text });
    }

    // Add image parts
    for (const file of m.files) {
      if (file.imageData && file.mimetype?.startsWith('image/')) {
        content.push({
          type: 'image',
          image: file.imageData, // base64 data URL
        });
      }
    }

    return { 
      role, 
      content: content.length > 0 ? content : text 
    };
  });
}

function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  return result.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n[truncated — ${result.length.toLocaleString()} chars total]`;
}

type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  durationMs: number;
  estimatedCost: string;
};

const TOKEN_COSTS: Record<string, { input: number; output: number }> = {
  "anthropic/claude-haiku-4-5":  { input: 0.80, output: 4.00 },
  "anthropic/claude-sonnet-4-5": { input: 3.00, output: 15.00 },
  "anthropic/claude-sonnet-4-6": { input: 3.00, output: 15.00 },
  "anthropic/claude-opus-4-5":   { input: 15.00, output: 75.00 },
  "anthropic/claude-opus-4-6":   { input: 15.00, output: 75.00 },
  "openai/gpt-4o":               { input: 2.50, output: 10.00 },
  "openai/gpt-4o-mini":          { input: 0.15, output: 0.60 },
  "openai/gpt-5-mini":           { input: 1.50, output: 6.00 },
  "google/gemini-2.5-flash":     { input: 0.15, output: 0.60 },
  "google/gemini-2.5-pro":       { input: 1.25, output: 10.00 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): string {
  const rates = TOKEN_COSTS[model];
  if (!rates) return "unknown";
  const cost = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
  if (cost < 0.001) return "<$0.001";
  return `$${cost.toFixed(4)}`;
}

function formatUsageFooter(usage: TokenUsage): string {
  const secs = (usage.durationMs / 1000).toFixed(1);
  return `_${usage.inputTokens.toLocaleString()} in · ${usage.outputTokens.toLocaleString()} out · ${secs}s · ${usage.estimatedCost}_`;
}

function resolveModel(input?: string): string {
  return getProviderModel(input);
}

function formatLLMError(err: unknown): string {
  if (err == null) return "unknown error";
  if (err instanceof Error) {
    const parts = [err.message];
    const anyErr = err as Error & { cause?: unknown; data?: unknown };
    if (anyErr.cause !== undefined) {
      parts.push(`cause: ${formatLLMError(anyErr.cause)}`);
    }
    if (anyErr.data !== undefined) {
      try {
        parts.push(`data: ${JSON.stringify(anyErr.data).slice(0, 400)}`);
      } catch {
        parts.push(`data: [unserializable]`);
      }
    }
    return parts.join(" | ");
  }
  if (typeof err === "object") {
    try {
      return JSON.stringify(err).slice(0, 500);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

export class MyAgent extends SlackAgent {
  private promptManager?: PromptManager;
  private promptRegistry?: PromptRegistry;
  private promptComposer?: PromptComposer;
  private promptMCPServer?: PromptMCPServer;
  private toolCache?: EventBasedCache;
  private toolDiscovery?: ToolDiscovery;
  private mcpBridge?: MCPBridge;
  private imageProcessor?: ImageProcessor;
  private _aigateway?: ReturnType<typeof createAiGateway>;
  private messageStore?: MessageStore;
  private workTracker?: WorkTracker;
  private processingEvents = new Map<string, number>();

  private getEnv(): any {
    return (this as any).env;
  }

  private ensureInitialized() {
    if (this.promptManager) return;

    const e = this.getEnv();

    this._aigateway = createAiGateway({
      accountId: e.CF_ACCOUNT_ID,
      gateway: e.CF_GATEWAY,
      apiKey: e.CF_AIG_TOKEN,
    });

    this.promptManager = new PromptManager(e.PROMPTS_BUCKET);
    this.promptRegistry = new PromptRegistry({ r2Bucket: e.PROMPTS_BUCKET });
    this.promptComposer = new PromptComposer();
    this.promptMCPServer = new PromptMCPServer({
      registry: this.promptRegistry,
      composer: this.promptComposer,
    });

    this.toolCache = new EventBasedCache();
    this.toolDiscovery = new ToolDiscovery(e.PROMPTS_BUCKET, this.toolCache);
    this.mcpBridge = new MCPBridge(this.toolDiscovery, this.toolCache);

    if (e.JOBS_DB) {
      this.workTracker = new WorkTracker(e.JOBS_DB);
    }

    // Register all tools on the bridge once
    const promptTools = createPromptMCPTools(this.promptRegistry, this.promptComposer);
    const logsTools = createLogsMCPTools();
    const discoveryTools = createDiscoveryMCPTools(this.toolDiscovery);
    const d1Tools = e.JOBS_DB ? createD1MCPTools(e.JOBS_DB, "JOBS_DB") : [];
    const gatewayTools = createAIGatewayMCPTools();
    const railwayTools = createRailwayMCPTools();
    const devAgentTools = createDevAgentMCPTools(this.workTracker);
    const devPromptTools = createDevPromptMCPTools();
    const workTools = this.workTracker ? createWorkMCPTools(this.workTracker) : [];
    const githubTools = createGitHubMCPTools();
    const pagesTools = createPagesMCPTools();
    const resourceTools = createResourceMCPTools();
    const historyTools = this.messageStore ? createHistoryMCPTools(this.messageStore) : [];
    this.mcpBridge.registerTools([
      ...promptTools, ...logsTools, ...discoveryTools, ...d1Tools, ...gatewayTools,
      ...railwayTools, ...devAgentTools, ...devPromptTools, ...workTools,
      ...githubTools, ...pagesTools, ...resourceTools, ...historyTools,
    ]);
    
    this.imageProcessor = new ImageProcessor({
      r2Bucket: e.PROMPTS_BUCKET,
      maxSizeBytes: IMAGE_MAX_BYTES,
      maxWidth: IMAGE_MAX_WIDTH,
      maxHeight: IMAGE_MAX_HEIGHT,
    });

    if (e.MESSAGES_BUCKET && e.JOBS_DB) {
      this.messageStore = new MessageStore(e.MESSAGES_BUCKET, e.JOBS_DB);
      this._messageStore = this.messageStore;
    }
  }

  /**
   * Sync registered tool schemas to R2, skipping the write if nothing changed.
   * Returns true if the graph was actually written, false if skipped.
   */
  private async syncToolGraphToR2(force = false): Promise<boolean> {
    const bridge = this.mcpBridge!;
    const tools = bridge.getTools();

    const entries = tools.map((t) => ({
      name: t.name,
      category: (t.name.startsWith("prompts.") || t.name.startsWith("tools.") ? "core" : "shared") as "core" | "shared" | "custom",
      description: t.description,
      priority: 5,
      schema: t.inputSchema,
    }));

    // Stable hash: sort by name so registration order doesn't matter
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    const fingerprint = await this.hashToolFingerprint(sorted);

    if (!force) {
      const stored = await this.ctx.storage.kv.get(KV_KEY_TOOL_GRAPH_HASH);
      if (stored === fingerprint) {
        console.log(`[syncToolGraphToR2] Skipped — ${entries.length} tools unchanged (${fingerprint.slice(0, 8)})`);
        return false;
      }
    }

    const graph = {
      version: 2,
      timestamp: new Date().toISOString(),
      fingerprint,
      tools: entries,
      toolsByCategory: {
        core: entries.filter((e) => e.category === "core"),
        shared: entries.filter((e) => e.category === "shared"),
        custom: [],
      },
    };

    await this.toolDiscovery!.saveGraph(graph);
    await this.ctx.storage.kv.put(KV_KEY_TOOL_GRAPH_HASH, fingerprint);
    console.log(`[syncToolGraphToR2] Published ${entries.length} tools to R2 (${fingerprint.slice(0, 8)})`);
    return true;
  }

  private async hashToolFingerprint(entries: unknown[]): Promise<string> {
    const payload = JSON.stringify(entries);
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ---------------------------------------------------------------------------
  // MCP tool API (called by /mcp/* routes for external tool access)
  // ---------------------------------------------------------------------------

  async listMCPTools(): Promise<{ name: string; description: string; inputSchema: any }[]> {
    this.ensureInitialized();
    return this.mcpBridge!.getTools();
  }

  async getMCPToolSchema(toolName: string): Promise<{ name: string; description: string; inputSchema: any } | null> {
    this.ensureInitialized();
    const tools = this.mcpBridge!.getTools();
    return tools.find((t) => t.name === toolName) ?? null;
  }

  async executeMCPTool(toolName: string, params: Record<string, unknown>): Promise<{ type: string; content: unknown }> {
    this.ensureInitialized();
    return this.mcpBridge!.executeTool(toolName, params, {
      agentId: AGENT_ID,
      teamId: DEFAULT_TEAM_ID,
      env: this.getEnv(),
    });
  }

  async generateAIReply(
    conversation: SlackMsg[],
    modelInput?: string,
    promptKey?: string,
    slackContext?: { channel: string; threadTs: string; userId?: string },
    /** Pass raw thread so tool handlers (e.g. dev agent) can access conversation context. */
    rawThread?: SlackMsg[],
  ): Promise<{ text: string; usage: TokenUsage }> {
    this.ensureInitialized();

    const selfId = await this.ensureAppUserId();
    const resolvedModel = resolveModel(modelInput);
    const supportsImages = supportsImageProcessing(resolvedModel);
    
    // Convert SlackMsg[] to ArchivedMessage-like shape for the context builder
    const archived = conversation.map((m) => ({
      ts: m.ts,
      thread_ts: m.thread_ts,
      channel: "",
      team_id: "",
      user: m.user,
      text: m.text,
      role: (m.user && m.user !== selfId ? "user" : "assistant") as "user" | "assistant",
      files: m.files,
      subtype: m.subtype,
      bot_id: m.bot_id,
      archived_at: "",
    }));
    const ctx = buildThreadContext(archived, CONTEXT_BUDGET_TOKENS);
    let windowedMessages = ctx.messages;

    // If messages were trimmed, try LLM compaction on the dropped portion
    if (ctx.wasTrimmed && ctx.dropped.length > 0) {
      const e = this.getEnv();
      const compactResult = await compactMessages({
        dropped: ctx.dropped,
        threadRoot: ctx.root ?? undefined,
        aiGatewayOpts: {
          accountId: e.CF_ACCOUNT_ID,
          gateway: e.CF_GATEWAY,
          apiKey: e.CF_AIG_TOKEN,
        },
      });

      if (compactResult) {
        windowedMessages = injectCompactSummary(
          windowedMessages,
          compactResult.summary,
          compactResult.droppedCount,
        );
      }
    }

    const asSlack: SlackMsg[] = windowedMessages.map((a) => ({
      ts: a.ts,
      thread_ts: a.thread_ts,
      user: a.user,
      text: a.text,
      subtype: a.subtype,
      bot_id: a.bot_id,
      files: a.files,
    }));
    const messages = normalizeForLLM(asSlack, selfId, supportsImages);

    const prompt = promptKey
      ? await this.promptManager!.getPrompt(promptKey)
      : await this.promptManager!.getPrompt(PROMPT_KEY_MENTIONED);

    if (!prompt) {
      throw new Error(`System prompt not found: ${promptKey}`);
    }

    const bridge = this.mcpBridge!;
    const aiTools: Record<string, any> = {};
    for (const mcpTool of bridge.getTools()) {
      const safeKey = mcpTool.name.replace(/[^a-zA-Z0-9_]/g, "_");
      const originalName = mcpTool.name;
      const rawSchema = { ...mcpTool.inputSchema, type: "object" };
      aiTools[safeKey] = tool({
        description: mcpTool.description,
        inputSchema: jsonSchema(rawSchema as any),
        execute: async (params: any) => {
          const threadMsgs = (rawThread ?? conversation).map((m) => ({
            user: m.user,
            text: m.text,
            ts: m.ts,
            thread_ts: m.thread_ts,
          }));
          const result = await bridge.executeTool(originalName, params, {
            agentId: AGENT_ID,
            teamId: DEFAULT_TEAM_ID,
            env: this.getEnv(),
            slackContext,
            thread: threadMsgs,
          });
          const raw = typeof result.content === 'string'
            ? result.content
            : JSON.stringify(result.content);
          return truncateToolResult(raw);
        },
      } as any);
    }

    const startMs = Date.now();
    try {
      const result = await generateText({
        model: this._aigateway!(unified(resolvedModel)),
        system: prompt.content,
        messages,
        tools: aiTools,
        stopWhen: stepCountIs(MAX_AGENT_TOOL_STEPS),
      });

      if (!result.text) throw new Error("No message from AI (empty response)");

      const durationMs = Date.now() - startMs;
      const u = result.totalUsage ?? result.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const inputTokens = u.inputTokens ?? 0;
      const outputTokens = u.outputTokens ?? 0;

      const usage: TokenUsage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        model: resolvedModel,
        durationMs,
        estimatedCost: estimateCost(resolvedModel, inputTokens, outputTokens),
      };

      console.log(`[generateAIReply] ${resolvedModel} | ${usage.inputTokens} in / ${usage.outputTokens} out | ${(durationMs / 1000).toFixed(1)}s | ${usage.estimatedCost}`);

      return { text: result.text, usage };
    } catch (err) {
      throw new Error(`LLM failed (${resolvedModel}): ${formatLLMError(err)}`);
    }
  }

  async handleDevAgentCallback(payload: Record<string, unknown>): Promise<void> {
    this.ensureInitialized();

    const cb = payload as unknown as CallbackPayload;
    if (!cb.taskId) {
      console.error("[callback] Missing taskId in payload");
      return;
    }

    if (!this.workTracker) {
      console.error("[callback] WorkTracker not initialized");
      return;
    }

    const devId = cb.planId ?? cb.taskId;
    const updated = await this.workTracker.updateStatus(devId, {
      status: cb.status as any,
      outcome: cb.outcome ?? undefined,
      prUrl: cb.prUrl ?? undefined,
      branchName: cb.branchName ?? undefined,
      error: cb.error ?? undefined,
      summary: cb.summary ?? undefined,
    });

    // Also try updating by taskId directly if the plan-level lookup didn't match
    if (!updated && cb.planId) {
      await this.workTracker.updateStatus(cb.taskId, {
        status: cb.status as any,
        outcome: cb.outcome ?? undefined,
        prUrl: cb.prUrl ?? undefined,
        branchName: cb.branchName ?? undefined,
        error: cb.error ?? undefined,
        summary: cb.summary ?? undefined,
      });
    }

    const workItem = updated ?? await this.workTracker.getByDevAgentId(cb.taskId);

    if (workItem?.channel && workItem?.threadTs) {
      const statusEmoji = cb.status === "completed" ? "white_check_mark" :
                          cb.status === "failed" ? "x" :
                          cb.status === "cancelled" ? "no_entry_sign" : "hourglass_flowing_sand";
      const lines = [`:${statusEmoji}: *Task ${cb.status}*`];

      if (cb.outcome) lines.push(`*Outcome:* ${cb.outcome}`);
      if (cb.prUrl) lines.push(`*PR:* ${cb.prUrl}`);
      if (cb.error) lines.push(`*Error:* ${cb.error}`);
      if (cb.summary) {
        const short = cb.summary.length > 300 ? cb.summary.slice(0, 300) + "..." : cb.summary;
        lines.push(`*Summary:* ${short}`);
      }

      // Use getAgentByName to get the team-specific agent for sending
      try {
        await this.sendMessage(lines.join("\n"), {
          channel: workItem.channel,
          thread_ts: workItem.threadTs,
        });
      } catch (err) {
        console.error("[callback] Failed to send Slack notification:", err);
      }
    }
  }

  parseModelDirective(text: string): { model?: string; rest: string } {
    const stripped = text.replace(/<@[A-Z0-9]+>\s*/g, "");
    const match = stripped.match(/^\[([^\]]+)\]\s*/);
    if (match) return { model: match[1], rest: stripped.slice(match[0].length) };
    return { rest: text };
  }

  // ---------------------------------------------------------------------------
  // Scheduled reporting
  // ---------------------------------------------------------------------------

  private async getReportConfigs(): Promise<ReportConfig[]> {
    const raw = await this.ctx.storage.kv.get(KV_KEY_REPORT_CONFIGS);
    if (!raw) {
      await this.saveReportConfigs(DEFAULT_REPORT_CONFIGS);
      return [...DEFAULT_REPORT_CONFIGS];
    }
    try {
      const configs = JSON.parse(raw as string) as ReportConfig[];
      if (configs.length === 0) {
        await this.saveReportConfigs(DEFAULT_REPORT_CONFIGS);
        return [...DEFAULT_REPORT_CONFIGS];
      }
      return configs;
    } catch {
      await this.saveReportConfigs(DEFAULT_REPORT_CONFIGS);
      return [...DEFAULT_REPORT_CONFIGS];
    }
  }

  private async saveReportConfigs(configs: ReportConfig[]) {
    await this.ctx.storage.kv.put(KV_KEY_REPORT_CONFIGS, JSON.stringify(configs));
  }

  async onStart() {
    this.ensureInitialized();

    // Publish tool catalog to R2 so other workers can discover available tools
    await this.syncToolGraphToR2();

    // One-time migration: fix stale config id from "apyfarm-daily" -> "apy-farm-daily"
    const migrated = await this.ctx.storage.kv.get("report_config_migrated_v1");
    if (!migrated) {
      await this.ctx.storage.kv.delete(KV_KEY_REPORT_CONFIGS);
      await this.ctx.storage.kv.put("report_config_migrated_v1", "true");
    }

    let configs = await this.getReportConfigs();

    if (configs.length === 0) {
      configs = DEFAULT_REPORT_CONFIGS;
      await this.saveReportConfigs(configs);
      console.log(`[onStart] Seeded ${configs.length} default report config(s)`);
    }

    const existingSchedules = this.getSchedules();

    for (const config of configs) {
      if (!config.enabled) continue;

      const alreadyScheduled = existingSchedules.some(
        (s) => s.callback === "runReport" && (s.payload as any)?.reportId === config.id
      );
      if (alreadyScheduled) continue;

      await this.schedule(config.schedule, "runReport", { reportId: config.id });
      console.log(`[onStart] Scheduled report "${config.name}" (${config.schedule}) -> #${config.channel}`);
    }
  }

  async runReport(payload: { reportId: string }) {
    this.ensureInitialized();

    const configs = await this.getReportConfigs();
    const config = configs.find((c) => c.id === payload.reportId);
    if (!config || !config.enabled) {
      console.log(`[runReport] Report ${payload.reportId} not found or disabled, skipping`);
      return;
    }

    console.log(`[runReport] Generating report "${config.name}" for channel ${config.channel}`);

    try {
      await this.keepAliveWhile(async () => {
        const runner = new ReportRunner({
          env: this.getEnv(),
          promptManager: this.promptManager!,
        });

        const result = await runner.run(config);
        console.log(`[runReport] Report generated in ${result.durationMs}ms, tools used: ${result.toolsUsed.join(", ")}`);

        await this.sendMessage(result.text, { channel: config.channel });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack?.split("\n").slice(0, 4).join("\n") : "";
      console.error(`[runReport] Failed to generate report ${payload.reportId}:`, err);
      await this.sendMessage(
        `*Report ${config.name} failed*\n\`\`\`\n${msg}${stack ? "\n" + stack : ""}\n\`\`\``,
        { channel: config.channel },
      );
    }
  }

  private async handleScheduleCommand(
    text: string,
    channel: string,
    threadTs: string,
  ): Promise<boolean> {
    const stripped = text.replace(/<@[A-Z0-9]+>/g, "").trim();
    const lower = stripped.toLowerCase();

    if (lower === "list reports") {
      const configs = await this.getReportConfigs();
      const schedules = this.getSchedules();

      if (configs.length === 0) {
        await this.sendMessage("No reports configured.", { channel, thread_ts: threadTs });
        return true;
      }

      const lines = configs.map((c) => {
        const sched = schedules.find(
          (s) => s.callback === "runReport" && (s.payload as any)?.reportId === c.id
        );
        const nextRun = sched ? new Date(sched.time * 1000).toISOString() : "not scheduled";
        const status = c.enabled ? "active" : "paused";
        return `• *${c.name}* — \`${c.schedule}\` — ${status} — next: ${nextRun}`;
      });

      await this.sendMessage(lines.join("\n"), { channel, thread_ts: threadTs });
      return true;
    }

    // Match case-insensitively but extract values from original text to preserve case
    const scheduleMatch = stripped.match(
      /^schedule report\s+"([^"]+)"\s+(\S+)\s+(\S+)\s+(.+)$/i
    );
    if (scheduleMatch) {
      const [, name, channelId, promptKey, cronExpr] = scheduleMatch;
      const id = name.replace(/\s+/g, "-").toLowerCase();

      const configs = await this.getReportConfigs();
      const existing = configs.findIndex((c) => c.id === id);
      const config: ReportConfig = {
        id,
        name,
        schedule: cronExpr,
        channel: channelId,
        promptKey,
        enabled: true,
      };

      if (existing >= 0) {
        configs[existing] = config;
      } else {
        configs.push(config);
      }

      await this.saveReportConfigs(configs);
      await this.schedule(cronExpr, "runReport", { reportId: id });
      await this.sendMessage(
        `Report *${name}* scheduled: \`${cronExpr}\` -> <#${channelId}> using prompt \`${promptKey}\``,
        { channel, thread_ts: threadTs },
      );
      return true;
    }

    const stopMatch = stripped.match(/^stop report\s+"?([^"]+)"?$/i);
    if (stopMatch) {
      const name = stopMatch[1].trim();
      const id = name.replace(/\s+/g, "-").toLowerCase();

      const configs = await this.getReportConfigs();
      const config = configs.find((c) => c.id === id);
      if (!config) {
        await this.sendMessage(`Report "${name}" not found.`, { channel, thread_ts: threadTs });
        return true;
      }

      config.enabled = false;
      await this.saveReportConfigs(configs);

      const schedules = this.getSchedules();
      for (const s of schedules) {
        if (s.callback === "runReport" && (s.payload as any)?.reportId === id) {
          await this.cancelSchedule(s.id);
        }
      }

      await this.sendMessage(`Report *${config.name}* stopped.`, { channel, thread_ts: threadTs });
      return true;
    }

    if (lower === "sync tools") {
      const wrote = await this.syncToolGraphToR2(true);
      const tools = this.mcpBridge!.getTools();
      await this.sendMessage(
        wrote
          ? `Synced *${tools.length}* tools to R2 discovery graph.`
          : `Tool graph already up to date (${tools.length} tools).`,
        { channel, thread_ts: threadTs },
      );
      return true;
    }

    const runMatch = stripped.match(/^run report\s+"?([^"]+)"?$/i);
    if (runMatch) {
      const name = runMatch[1].trim();
      const id = name.replace(/\s+/g, "-").toLowerCase();

      const configs = await this.getReportConfigs();
      const config = configs.find((c) => c.id === id);
      if (!config) {
        await this.sendMessage(`Report "${name}" not found. Use \`list reports\` to see available reports.`, { channel, thread_ts: threadTs });
        return true;
      }

      await this.sendMessage(`Running report *${config.name}* now...`, { channel, thread_ts: threadTs });
      try {
        await this.runReport({ reportId: config.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.sendMessage(`Report failed: \`${msg}\``, { channel, thread_ts: threadTs });
      }
      return true;
    }

    return false;
  }

  async isBotMentionedInThread(
    channel: string,
    threadTs: string,
    selfUserId: string
  ): Promise<boolean> {
    const thread = await this.fetchThread(channel, threadTs);
    const botMention = `<@${selfUserId}>`;
    return thread.some((msg) => (msg.text || "").includes(botMention));
  }

  hasMentionOfOtherUser(text: string, selfUserId: string): boolean {
    const mentions = text.match(/<@([A-Z0-9]+)>/g) || [];
    return mentions.some((mention) => !mention.includes(selfUserId));
  }

  getPromptKeyForChannel(channelId: string): string | undefined {
    // Extract channel name from ID if needed (format: C123456789)
    // For now, we'll check if the channel ID maps to a configured channel
    for (const [channelName, config] of Object.entries(CHANNEL_CONFIGS)) {
      if (config.promptKey && channelId.includes(channelName)) {
        return config.promptKey;
      }
    }
    return undefined;
  }

  async onSlackEvent(event: { type: string } & Record<string, unknown>) {
    const payload = event as Record<string, unknown>;
    const replyChannel = typeof payload.channel === "string" ? payload.channel : undefined;
    const replyThreadTs =
      typeof payload.ts === "string"
        ? typeof payload.thread_ts === "string"
          ? payload.thread_ts
          : payload.ts
        : undefined;

    try {
      if (event.bot_id) return;
      // Only skip system/bot message subtypes — user messages can have subtype (e.g. file_share).
      const skipSubtypes = new Set([
        "bot_message",
        "message_changed",
        "message_deleted",
        "channel_join",
        "channel_leave",
        "channel_topic",
        "channel_purpose",
        "channel_name",
        "channel_archive",
        "channel_unarchive",
        "channel_posting_permissions",
        "joiner_notification",
        "pinned_item",
        "unpinned_item",
        "reminder_add",
        "ekm_subheader",
        "tombstone",
      ]);
      const st = event.subtype as string | undefined;
      if (st && skipSubtypes.has(st)) return;

      // Dedup: Slack sends both "message" and "app_mention" events for @-mentions.
      // Track by message ts to only process the first one.
      const eventTs = event.ts as string | undefined;
      if (eventTs) {
        if (this.processingEvents.has(eventTs)) {
          console.log(`[dedup] Skipping duplicate event for ts=${eventTs} (type=${event.type})`);
          return;
        }
        this.processingEvents.set(eventTs, Date.now());
        // Prune entries older than 60s
        for (const [ts, time] of this.processingEvents) {
          if (Date.now() - time > 60_000) this.processingEvents.delete(ts);
        }
      }

      this.ensureInitialized();
      const selfUserId = await this.ensureAppUserId();

      // Backfill team_id for installations that predate the archive system
      if (typeof event.team === "string") {
        const storedTid = await this.getTeamId();
        if (!storedTid) {
          this.ctx.storage.kv.put("team_id", event.team as string);
        }
      }

      // app_mention and message share the same shape (channel, user, text, ts, thread_ts).
      // Many workspaces only subscribe to app_mention for @mentions; ignoring it meant no reply.
      if (event.type === "message" || event.type === "app_mention") {
        const e = event as unknown as any & { channel: string };

        // Archive inbound message to R2 + D1
        if (this.messageStore && e.ts && e.channel) {
          const tid = await this.getTeamId();
          if (tid) {
            try {
              await this.messageStore.store({
                ts: e.ts,
                thread_ts: e.thread_ts,
                channel: e.channel,
                team_id: tid,
                user: e.user,
                text: e.text,
                role: "user",
                files: e.files,
                subtype: e.subtype,
                bot_id: e.bot_id,
              });
            } catch (err) {
              console.error("[archive] Failed to store inbound message:", err);
            }
          }
        }

        const isDM = (e.channel || "").startsWith("D");
        // app_mention always targets this app; text match alone failed when auth.test used an un-awaited token.
        const mentioned =
          event.type === "app_mention" || (e.text || "").includes(`<@${selfUserId}>`);
        const isInThread = !!e.thread_ts;
        const hasOtherMentions = this.hasMentionOfOtherUser(e.text || "", selfUserId);

        let shouldRespond = false;

        if (isDM || mentioned) {
          shouldRespond = true;
        } else if (isInThread && !hasOtherMentions && e.thread_ts) {
          shouldRespond = await this.isBotMentionedInThread(
            e.channel,
            e.thread_ts,
            selfUserId
          );
        }

        if (!shouldRespond) return;

        // Always reply in a thread — use existing thread or start one from this message
        const threadTs = e.thread_ts || e.ts;

        if (isModelsCommand(e.text || "")) {
          await this.sendMessage(formatModelsForSlack(), {
            channel: e.channel,
            thread_ts: threadTs,
          });
          return;
        }

        const handled = await this.handleScheduleCommand(e.text || "", e.channel, threadTs);
        if (handled) return;

        const { model } = this.parseModelDirective(e.text || "");
        let thread = await this.fetchThread(e.channel, threadTs);
        const rawThread = [...thread];

        // Process images if model supports them
        const resolvedModel = resolveModel(model);
        if (supportsImageProcessing(resolvedModel)) {
          console.log(`[onSlackEvent] Model ${resolvedModel} supports images, processing...`);
          const token = await this.token; // Get token value
          const processedThread = [];
          
          for (const msg of thread) {
            if (msg.files && msg.files.length > 0) {
              const processedFiles = [];
              for (const file of msg.files) {
                const processed = await this.downloadImage(file, token as string, this.imageProcessor);
                if (processed) {
                  processedFiles.push(processed);
                }
              }
              processedThread.push({ ...msg, files: processedFiles });
            } else {
              processedThread.push(msg);
            }
          }
          thread = processedThread;
        } else {
          console.log(`[onSlackEvent] Model ${resolvedModel} does not support images, skipping image processing`);
        }

        const promptKey = isInThread && !mentioned ? PROMPT_KEY_THREAD_REPLY : this.getPromptKeyForChannel(e.channel);
        const { text: content, usage } = await this.generateAIReply(thread, model, promptKey, {
          channel: e.channel,
          threadTs: threadTs,
          userId: e.user,
        }, rawThread);

        if (content.trim() === "SKIP") {
          console.log(`[SKIP] Thread reply skipped - channel: ${e.channel}, thread_ts: ${threadTs}`);
          return;
        }

        const footer = formatUsageFooter(usage);
        await this.sendMessage(`${content}\n\n${footer}`, {
          channel: e.channel,
          thread_ts: threadTs,
        });
        return;
      }
    } catch (err) {
      console.error("[onSlackEvent] Error processing event:", err);
      if (replyChannel && replyThreadTs) {
        const msg = err instanceof Error ? err.message : String(err);
        const safe = msg.replace(/`/g, "'").slice(0, 280);
        try {
          await this.sendMessage(
            `I couldn't complete that request. \`${safe}\``,
            { channel: replyChannel, thread_ts: replyThreadTs },
          );
        } catch (sendErr) {
          console.error("[onSlackEvent] Failed to send error reply:", sendErr);
        }
      }
    }
  }
}

export default MyAgent.listen({
  clientId: env.SLACK_CLIENT_ID,
  clientSecret: env.SLACK_CLIENT_SECRET,
  slackSigningSecret: env.SLACK_SIGNING_SECRET,
  scopes: [
    "chat:write",
    "chat:write.public",
    "channels:history",
    "groups:history", // private channels (e.g. #ideas) — reinstall app after adding
    "app_mentions:read",
    "im:write",
    "im:history",
    "files:read", // Required for accessing file URLs and metadata
  ],
});
