/**
 * MCP handlers for prompt management tools.
 */

import type { ToolDefinition, ToolContext, ToolExecutionParams, MCPToolResult } from "../types";
import { PromptRegistry } from "../../prompts/registry";
import { PromptComposer } from "../../prompts/composer";
import type { PromptPart } from "../../prompts/types";

export function createPromptMCPTools(
  registry: PromptRegistry,
  composer: PromptComposer
): ToolDefinition[] {
  return [
    {
      name: "prompts.list",
      description: "List all available prompt parts (system, user, context) and composed prompts",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: 'Filter by part type: "system", "user", or "context" (optional)',
          },
        },
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams): Promise<MCPToolResult> => {
        const type = params.type as string | undefined;

        if (type && !["system", "user", "context"].includes(type)) {
          return {
            type: "text",
            content: JSON.stringify({ error: 'Invalid type. Must be "system", "user", or "context"' }),
          };
        }

        if (type) {
          const parts = await registry.listParts(type as "system" | "user" | "context");
          return {
            type: "text",
            content: JSON.stringify({
              type,
              count: parts.length,
              parts: parts.map((p) => ({ key: p.key, name: p.name, version: p.version })),
            }),
          };
        }

        // List all types
        const system = await registry.listParts("system");
        const user = await registry.listParts("user");
        const context = await registry.listParts("context");

        return {
          type: "text",
          content: JSON.stringify({
            system: system.map((p) => ({ key: p.key, name: p.name })),
            user: user.map((p) => ({ key: p.key, name: p.name })),
            context: context.map((p) => ({ key: p.key, name: p.name })),
          }),
        };
      },
    },

    {
      name: "prompts.get",
      description: "Get a specific prompt part by type and key",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: 'Part type: "system", "user", or "context"',
          },
          key: {
            type: "string",
            description: "Prompt part key",
          },
        },
        required: ["type", "key"],
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams): Promise<MCPToolResult> => {
        const { type, key } = params as { type: string; key: string };

        if (!["system", "user", "context"].includes(type)) {
          return {
            type: "text",
            content: JSON.stringify({ error: 'Invalid type. Must be "system", "user", or "context"' }),
          };
        }

        const part = await registry.getPart(type as "system" | "user" | "context", key);

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
      },
    },

    {
      name: "prompts.compose",
      description: "Compose a full prompt from system, user, and/or context parts",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          system: {
            type: "string",
            description: "Content for system prompt part",
          },
          user: {
            type: "string",
            description: "Content for user prompt part",
          },
          context: {
            type: "string",
            description: "Content for context prompt part",
          },
        },
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams): Promise<MCPToolResult> => {
        const result = composer.compose({
          system: params.system as string | undefined,
          user: params.user as string | undefined,
          context: params.context as string | undefined,
        });

        return {
          type: "text",
          content: JSON.stringify(result),
        };
      },
    },

    {
      name: "prompts.create",
      description: "Create a new prompt part",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: 'Part type: "system", "user", or "context"',
          },
          key: {
            type: "string",
            description: "Unique key for this prompt part",
          },
          name: {
            type: "string",
            description: "Human-readable name",
          },
          content: {
            type: "string",
            description: "Prompt content",
          },
          description: {
            type: "string",
            description: "Description of what this prompt is for",
          },
        },
        required: ["type", "key", "name", "content"],
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams): Promise<MCPToolResult> => {
        const { type, key, name, content, description } = params as Record<string, string>;

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

        await registry.savePart(part);

        return {
          type: "text",
          content: JSON.stringify({ success: true, part }),
        };
      },
    },

    {
      name: "prompts.update",
      description: "Update an existing prompt part",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: 'Part type: "system", "user", or "context"',
          },
          key: {
            type: "string",
            description: "Key of prompt part to update",
          },
          name: {
            type: "string",
            description: "New name (optional)",
          },
          content: {
            type: "string",
            description: "New content (optional)",
          },
          description: {
            type: "string",
            description: "New description (optional)",
          },
        },
        required: ["type", "key"],
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams): Promise<MCPToolResult> => {
        const { type, key, name, content, description } = params as Record<string, string>;

        if (!["system", "user", "context"].includes(type)) {
          return {
            type: "text",
            content: JSON.stringify({ error: 'Invalid type. Must be "system", "user", or "context"' }),
          };
        }

        const existing = await registry.getPart(type as "system" | "user" | "context", key);

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

        await registry.savePart(updated);

        return {
          type: "text",
          content: JSON.stringify({ success: true, part: updated }),
        };
      },
    },

    {
      name: "prompts.delete",
      description: "Delete a prompt part",
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: 'Part type: "system", "user", or "context"',
          },
          key: {
            type: "string",
            description: "Key of prompt part to delete",
          },
        },
        required: ["type", "key"],
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams): Promise<MCPToolResult> => {
        const { type, key } = params as { type: string; key: string };

        if (!["system", "user", "context"].includes(type)) {
          return {
            type: "text",
            content: JSON.stringify({ error: 'Invalid type. Must be "system", "user", or "context"' }),
          };
        }

        await registry.deletePart(type as "system" | "user" | "context", key);

        return {
          type: "text",
          content: JSON.stringify({ success: true, message: `Deleted ${type}/${key}` }),
        };
      },
    },
  ];
}
