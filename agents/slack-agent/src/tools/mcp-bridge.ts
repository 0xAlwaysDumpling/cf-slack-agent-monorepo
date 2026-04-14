/**
 * MCP bridge - exposes tools via the MCP protocol.
 * Handles tool execution, schema validation, and result formatting.
 */

import type {
  ToolDefinition,
  ToolContext,
  ToolExecutionParams,
  MCPToolResult,
  MCPTool,
  ToolDiscoveryEntry,
} from "./types";
import { MCPToolNotFoundError, MCPValidationError } from "./types";
import { ToolDiscovery } from "./discovery";
import { EventBasedCache } from "./cache";

export class MCPBridge {
  private tools: Map<string, ToolDefinition> = new Map();
  private discovery: ToolDiscovery;
  private cache: EventBasedCache;

  constructor(discovery: ToolDiscovery, cache: EventBasedCache) {
    this.discovery = discovery;
    this.cache = cache;
  }

  /**
   * Register a tool with the bridge.
   */
  registerTool(definition: ToolDefinition): void {
    this.tools.set(definition.name, definition);
  }

  /**
   * Register multiple tools.
   */
  registerTools(definitions: ToolDefinition[]): void {
    for (const def of definitions) {
      this.registerTool(def);
    }
  }

  /**
   * Execute a tool by name.
   */
  async executeTool(
    name: string,
    params: ToolExecutionParams,
    context: ToolContext
  ): Promise<MCPToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new MCPToolNotFoundError(name);
    }

    // Validate input against schema
    this.validateInput(params, tool.inputSchema);

    try {
      const result = await tool.handler(params, context);
      return result;
    } catch (error) {
      console.error(`Error executing tool ${name}:`, error);

      // Re-throw if it's already an MCPToolError
      if (error instanceof Error && error.name === "MCPToolError") {
        throw error;
      }

      throw new Error(`Failed to execute tool ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get all registered tools in MCP format.
   */
  getTools(): MCPTool[] {
    return Array.from(this.tools.values()).map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
    }));
  }

  /**
   * Get tools from discovery graph and merge with registered handlers.
   */
  async getDiscoveredTools(): Promise<MCPTool[]> {
    const graph = await this.discovery.getGraph();
    return graph.tools.map((entry) => {
      const registered = this.tools.get(entry.name);
      return {
        name: entry.name,
        description: entry.description,
        inputSchema: registered?.inputSchema ?? entry.schema ?? { type: "object", properties: {} },
      };
    });
  }

  /**
   * Find a tool by name.
   */
  findTool(name: string): ToolDefinition | null {
    return this.tools.get(name) ?? null;
  }

  /**
   * List tools by category.
   */
  async getToolsByCategory(category: "core" | "shared" | "custom"): Promise<MCPTool[]> {
    const entries = await this.discovery.getToolsByCategory(category);
    return this.entriesToMCPTools(entries);
  }

  /**
   * Search for tools.
   */
  async searchTools(query: string): Promise<MCPTool[]> {
    const results = await this.discovery.search(query);
    return this.entriesToMCPTools(results);
  }

  /**
   * Convert discovery entries to MCP tools.
   */
  private entriesToMCPTools(entries: ToolDiscoveryEntry[]): MCPTool[] {
    return entries.map((entry) => {
      const registered = this.tools.get(entry.name);
      return {
        name: entry.name,
        description: entry.description,
        inputSchema: registered?.inputSchema ?? entry.schema ?? { type: "object", properties: {} },
      };
    });
  }

  /**
   * Validate input against schema.
   */
  private validateInput(params: ToolExecutionParams, schema: any): void {
    if (!schema || schema.type !== "object") {
      return; // No validation needed for non-object schemas
    }

    const required = schema.required ?? [];
    const properties = schema.properties ?? {};

    // Check required fields
    for (const field of required) {
      if (!(field in params)) {
        throw new MCPValidationError(`Missing required field: ${field}`);
      }
    }

    // Check field types (simple validation)
    for (const [key, value] of Object.entries(params)) {
      if (!(key in properties)) {
        if (!schema.additionalProperties) {
          throw new MCPValidationError(`Unexpected field: ${key}`);
        }
        continue;
      }

      const propSchema = properties[key] as any;
      if (propSchema.type) {
        const actualType = typeof value;
        const expectedType = propSchema.type;

        // Allow null for optional fields
        if (value === null) continue;

        if (expectedType === "string" && actualType !== "string") {
          throw new MCPValidationError(`Field ${key} must be a string, got ${actualType}`);
        }

        if (expectedType === "number" && actualType !== "number") {
          throw new MCPValidationError(`Field ${key} must be a number, got ${actualType}`);
        }

        if (expectedType === "boolean" && actualType !== "boolean") {
          throw new MCPValidationError(`Field ${key} must be a boolean, got ${actualType}`);
        }

        if (expectedType === "array" && !Array.isArray(value)) {
          throw new MCPValidationError(`Field ${key} must be an array, got ${actualType}`);
        }

        if (expectedType === "object" && actualType !== "object") {
          throw new MCPValidationError(`Field ${key} must be an object, got ${actualType}`);
        }
      }
    }
  }

  /**
   * Get tool count by category.
   */
  getStats(): {
    total: number;
    registered: number;
    byCategory: { core: number; shared: number; custom: number };
  } {
    let core = 0;
    let shared = 0;
    let custom = 0;

    for (const tool of this.tools.values()) {
      if (tool.category === "core") core++;
      else if (tool.category === "shared") shared++;
      else if (tool.category === "custom") custom++;
    }

    return {
      total: this.tools.size,
      registered: this.tools.size,
      byCategory: { core, shared, custom },
    };
  }
}
