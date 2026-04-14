/**
 * Generic report runner.
 * Collects available data-source tools based on env bindings,
 * runs an AI generation pass with those tools, and returns the report text.
 */

import { generateText, tool, stepCountIs, jsonSchema } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";
import { getProviderModel } from "../config/providers";
import { PromptManager } from "../config/promptManager";
import { createLogsMCPTools } from "../tools/mcp-handlers/logs";
import { createD1MCPTools } from "../tools/mcp-handlers/d1";
import { createAIGatewayMCPTools } from "../tools/mcp-handlers/ai-gateway";
import { MCPBridge } from "../tools/mcp-bridge";
import { ToolDiscovery } from "../tools/discovery";
import { EventBasedCache } from "../tools/cache";
import type { ToolDefinition } from "../tools/types";
import type { ReportConfig, ReportResult } from "./types";
import { AGENT_ID, DEFAULT_TEAM_ID, MAX_REPORT_TOOL_STEPS } from "../config/constants";

const unified = createUnified();

interface RunnerDeps {
  env: any;
  promptManager: PromptManager;
}

export class ReportRunner {
  private env: any;
  private promptManager: PromptManager;

  constructor(deps: RunnerDeps) {
    this.env = deps.env;
    this.promptManager = deps.promptManager;
  }

  /**
   * Collect all available data-source tools based on what bindings exist.
   */
  private collectTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    if (this.env.JOBS_DB) {
      tools.push(...createD1MCPTools(this.env.JOBS_DB, "JOBS_DB"));
    }

    tools.push(...createLogsMCPTools());
    tools.push(...createAIGatewayMCPTools());

    return tools;
  }

  async run(config: ReportConfig): Promise<ReportResult> {
    const start = Date.now();
    const allTools = this.collectTools();

    const cache = new EventBasedCache();
    const discovery = new ToolDiscovery(this.env.PROMPTS_BUCKET, cache);
    const bridge = new MCPBridge(discovery, cache);
    bridge.registerTools(allTools);

    const aiTools: Record<string, any> = {};
    const toolNames: string[] = [];
    for (const mcpTool of bridge.getTools()) {
      // AI Gateway / unified API requires tool names ^[a-zA-Z0-9_-]{1,128}$ (no dots).
      const safeKey = mcpTool.name.replace(/[^a-zA-Z0-9_]/g, "_");
      toolNames.push(safeKey);
      const rawSchema = { ...mcpTool.inputSchema, type: "object" };
      const originalName = mcpTool.name;
      aiTools[safeKey] = tool({
        description: mcpTool.description,
        inputSchema: jsonSchema(rawSchema as any),
        execute: async (params: any) => {
          const result = await bridge.executeTool(originalName, params, {
            agentId: AGENT_ID,
            teamId: DEFAULT_TEAM_ID,
            env: this.env,
          });
          return typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content);
        },
      } as any);
    }

    const prompt = await this.promptManager.getPrompt(config.promptKey);
    if (!prompt) {
      throw new Error(`Report prompt not found: ${config.promptKey}`);
    }

    const gateway = createAiGateway({
      accountId: this.env.CF_ACCOUNT_ID,
      gateway: this.env.CF_GATEWAY,
      apiKey: this.env.CF_AIG_TOKEN,
    });

    const resolvedModel = getProviderModel();

    let text: string;
    let steps: any[];

    try {
      const result = await generateText({
        model: gateway(unified(resolvedModel)),
        system: prompt.content,
        messages: [
          {
            role: "user",
            content: `Generate the daily report now. Today is ${new Date().toISOString().split("T")[0]}.`,
          },
        ],
        tools: aiTools,
        stopWhen: stepCountIs(MAX_REPORT_TOOL_STEPS),
      });
      text = result.text;
      steps = result.steps;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`AI generation failed (model: ${resolvedModel}): ${msg}`);
    }

    const usedTools = new Set<string>();
    const stepTrace: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const calls = step.toolCalls || [];
      for (const tc of calls) {
        usedTools.add(tc.toolName);
      }
      const callNames = calls.map((tc: any) => tc.toolName).join(", ");
      const hasText = !!step.text;
      stepTrace.push(`Step ${i + 1}: ${callNames ? `tools=[${callNames}]` : "no tools"}${hasText ? " +text" : ""}`);
    }

    console.log(`[ReportRunner] Trace:\n${stepTrace.join("\n")}`);

    let reportText = text;
    if (!reportText) {
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].text) {
          reportText = steps[i].text;
          break;
        }
      }
    }

    if (!reportText) {
      const trace = stepTrace.join("\n");
      reportText = `_Report ran ${steps.length} step(s) but produced no summary._\n\n*Trace:*\n\`\`\`\n${trace}\n\`\`\``;
    }

    console.log(`[ReportRunner] Completed: ${steps.length} steps, ${usedTools.size} tools used, text length: ${reportText.length}`);

    return {
      reportId: config.id,
      text: reportText,
      toolsUsed: [...usedTools],
      durationMs: Date.now() - start,
    };
  }
}
