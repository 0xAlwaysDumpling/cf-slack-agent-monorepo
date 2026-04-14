/**
 * Prompt MCP Server - Standalone MCP server for prompt management.
 * Can be used internally by the agent or exposed externally via HTTP.
 */

import type { PromptPart, ComposedPrompt } from "./types";
import { PromptRegistry } from "./registry";
import { PromptComposer } from "./composer";
import type {
  MCPToolResult,
  MCPResource,
  ToolContext,
} from "../tools/types";

export interface MCPServerOptions {
  registry: PromptRegistry;
  composer: PromptComposer;
}

export class PromptMCPServer {
  private registry: PromptRegistry;
  private composer: PromptComposer;

  constructor(options: MCPServerOptions) {
    this.registry = options.registry;
    this.composer = options.composer;
  }

  /**
   * List all available MCP resources (prompts and parts).
   */
  async listResources(): Promise<MCPResource[]> {
    const resources: MCPResource[] = [];

    // Add part collections
    resources.push({
      uri: "prompts://parts/system",
      name: "System Prompt Parts",
      description: "All system-level prompt parts",
      mimeType: "application/json",
    });

    resources.push({
      uri: "prompts://parts/user",
      name: "User Prompt Parts",
      description: "All user-level prompt parts",
      mimeType: "application/json",
    });

    resources.push({
      uri: "prompts://parts/context",
      name: "Context Prompt Parts",
      description: "All context-level prompt parts",
      mimeType: "application/json",
    });

    resources.push({
      uri: "prompts://composed",
      name: "Composed Prompts",
      description: "All composed prompts",
      mimeType: "application/json",
    });

    // Add individual system parts
    const systemParts = await this.registry.listParts("system");
    for (const part of systemParts) {
      resources.push({
        uri: `prompts://parts/system/${part.key}`,
        name: part.name,
        description: part.metadata.description,
        mimeType: "application/json",
      });
    }

    // Add individual user parts
    const userParts = await this.registry.listParts("user");
    for (const part of userParts) {
      resources.push({
        uri: `prompts://parts/user/${part.key}`,
        name: part.name,
        description: part.metadata.description,
        mimeType: "application/json",
      });
    }

    // Add individual context parts
    const contextParts = await this.registry.listParts("context");
    for (const part of contextParts) {
      resources.push({
        uri: `prompts://parts/context/${part.key}`,
        name: part.name,
        description: part.metadata.description,
        mimeType: "application/json",
      });
    }

    return resources;
  }

  /**
   * Read a resource by URI.
   */
  async readResource(uri: string): Promise<string> {
    // Parse URI format: prompts://parts/[type]/[key] or prompts://parts/[type]
    if (!uri.startsWith("prompts://")) {
      throw new Error(`Invalid resource URI: ${uri}`);
    }

    const path = uri.replace("prompts://", "");

    if (path === "composed") {
      // Return empty composed prompts list (would need to implement composed prompt storage)
      return JSON.stringify({ prompts: [] });
    }

    // Handle parts collection: parts/system, parts/user, parts/context
    const partsMatch = path.match(/^parts\/(system|user|context)$/);
    if (partsMatch) {
      const type = partsMatch[1] as "system" | "user" | "context";
      const parts = await this.registry.listParts(type);
      return JSON.stringify({
        type,
        count: parts.length,
        parts: parts.map((p) => ({
          key: p.key,
          name: p.name,
          version: p.version,
          description: p.metadata.description,
        })),
      });
    }

    // Handle individual parts: parts/system/[key]
    const partMatch = path.match(/^parts\/(system|user|context)\/(.+)$/);
    if (partMatch) {
      const [, type, key] = partMatch;
      const part = await this.registry.getPart(type as "system" | "user" | "context", key);

      if (!part) {
        throw new Error(`Prompt part not found: ${uri}`);
      }

      return JSON.stringify(part);
    }

    throw new Error(`Unknown resource URI: ${uri}`);
  }

  /**
   * Execute an MCP tool.
   */
  async executeTool(
    toolName: string,
    params: Record<string, unknown>,
    context?: ToolContext
  ): Promise<MCPToolResult> {
    switch (toolName) {
      case "prompts.list":
        return this.handlePromptsList(params);

      case "prompts.get":
        return this.handlePromptsGet(params);

      case "prompts.compose":
        return this.handlePromptsCompose(params);

      case "prompts.create":
        return this.handlePromptsCreate(params);

      case "prompts.update":
        return this.handlePromptsUpdate(params);

      case "prompts.delete":
        return this.handlePromptsDelete(params);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private async handlePromptsList(
    params: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const type = params.type as string | undefined;

    if (type && !["system", "user", "context"].includes(type)) {
      return {
        type: "text",
        content: JSON.stringify({
          error: 'Invalid type. Must be "system", "user", or "context"',
        }),
      };
    }

    if (type) {
      const parts = await this.registry.listParts(type as "system" | "user" | "context");
      return {
        type: "text",
        content: JSON.stringify({
          type,
          count: parts.length,
          parts: parts.map((p) => ({
            key: p.key,
            name: p.name,
            version: p.version,
          })),
        }),
      };
    }

    const system = await this.registry.listParts("system");
    const user = await this.registry.listParts("user");
    const context = await this.registry.listParts("context");

    return {
      type: "text",
      content: JSON.stringify({
        system: system.map((p) => ({ key: p.key, name: p.name })),
        user: user.map((p) => ({ key: p.key, name: p.name })),
        context: context.map((p) => ({ key: p.key, name: p.name })),
      }),
    };
  }

  private async handlePromptsGet(
    params: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const { type, key } = params as { type: string; key: string };

    if (!type || !key) {
      return {
        type: "text",
        content: JSON.stringify({ error: "Missing required fields: type, key" }),
      };
    }

    if (!["system", "user", "context"].includes(type)) {
      return {
        type: "text",
        content: JSON.stringify({ error: 'Invalid type. Must be "system", "user", or "context"' }),
      };
    }

    const part = await this.registry.getPart(type as "system" | "user" | "context", key);

    if (!part) {
      return {
        type: "text",
        content: JSON.stringify({ error: `Prompt part not found: ${type}/${key}` }),
      };
    }

    return {
      type: "text",
      content: JSON.stringify(part),
    };
  }

  private async handlePromptsCompose(
    params: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const result = this.composer.compose({
      system: params.system as string | undefined,
      user: params.user as string | undefined,
      context: params.context as string | undefined,
    });

    return {
      type: "text",
      content: JSON.stringify(result),
    };
  }

  private async handlePromptsCreate(
    params: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const { type, key, name, content, description } = params as Record<string, string>;

    if (!type || !key || !name || !content) {
      return {
        type: "text",
        content: JSON.stringify({
          error: "Missing required fields: type, key, name, content",
        }),
      };
    }

    if (!["system", "user", "context"].includes(type)) {
      return {
        type: "text",
        content: JSON.stringify({ error: 'Invalid type. Must be "system", "user", or "context"' }),
      };
    }

    const part: PromptPart = {
      type: type as "system" | "user" | "context",
      key,
      name,
      content,
      version: 1,
      metadata: {
        description: description || "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    await this.registry.savePart(part);

    return {
      type: "text",
      content: JSON.stringify({ success: true, part }),
    };
  }

  private async handlePromptsUpdate(
    params: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const { type, key, name, content, description } = params as Record<string, string>;

    if (!type || !key) {
      return {
        type: "text",
        content: JSON.stringify({
          error: "Missing required fields: type, key",
        }),
      };
    }

    if (!["system", "user", "context"].includes(type)) {
      return {
        type: "text",
        content: JSON.stringify({ error: 'Invalid type. Must be "system", "user", or "context"' }),
      };
    }

    const existing = await this.registry.getPart(type as "system" | "user" | "context", key);

    if (!existing) {
      return {
        type: "text",
        content: JSON.stringify({ error: `Prompt part not found: ${type}/${key}` }),
      };
    }

    const updated: PromptPart = {
      ...existing,
      name: name || existing.name,
      content: content || existing.content,
      version: existing.version + 1,
      metadata: {
        ...existing.metadata,
        description: description ?? existing.metadata.description,
        updatedAt: new Date().toISOString(),
      },
    };

    await this.registry.savePart(updated);

    return {
      type: "text",
      content: JSON.stringify({ success: true, part: updated }),
    };
  }

  private async handlePromptsDelete(
    params: Record<string, unknown>
  ): Promise<MCPToolResult> {
    const { type, key } = params as { type: string; key: string };

    if (!type || !key) {
      return {
        type: "text",
        content: JSON.stringify({
          error: "Missing required fields: type, key",
        }),
      };
    }

    if (!["system", "user", "context"].includes(type)) {
      return {
        type: "text",
        content: JSON.stringify({ error: 'Invalid type. Must be "system", "user", or "context"' }),
      };
    }

    await this.registry.deletePart(type as "system" | "user" | "context", key);

    return {
      type: "text",
      content: JSON.stringify({
        success: true,
        message: `Deleted ${type}/${key}`,
      }),
    };
  }
}
