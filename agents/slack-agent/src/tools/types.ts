/**
 * MCP-native tool types and interfaces.
 * All tools follow the MCP standard protocol.
 */

export type MCPToolResultType = "text" | "image" | "resource";

export interface MCPToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: MCPToolInputSchema;
}

export interface MCPToolResult {
  type: MCPToolResultType;
  content: string | { resourceUri: string };
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ToolDiscoveryEntry {
  name: string;
  category: "core" | "shared" | "custom";
  description: string;
  priority: number;
  relatedTools?: string[];
  schema?: MCPToolInputSchema;
}

export interface ToolDiscoveryGraph {
  version: number;
  timestamp: string;
  tools: ToolDiscoveryEntry[];
  toolsByCategory: {
    core: ToolDiscoveryEntry[];
    shared: ToolDiscoveryEntry[];
    custom: ToolDiscoveryEntry[];
  };
}

export type CacheEvent = "tool:updated" | "tool:deleted" | "prompt:updated" | "discovery:changed";

export interface CacheEventHandler {
  (event: CacheEvent, key: string): void | Promise<void>;
}

export interface SlackContext {
  channel: string;
  threadTs: string;
  userId?: string;
}

export interface ToolContext {
  agentId: string;
  teamId: string;
  userId?: string;
  r2Bucket?: R2Bucket;
  env?: any;
  slackContext?: SlackContext;
  /** Raw Slack thread messages available for tool handlers that need conversation context. */
  thread?: { user?: string; text?: string; ts: string; thread_ts?: string }[];
  /** Send a status notification to the user's Slack thread (fire-and-forget). */
  sendNotification?: (message: string) => Promise<void>;
}

export interface ToolExecutionParams {
  [key: string]: unknown;
}

export interface ToolHandler {
  (params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult>;
}

export interface ToolDefinition extends MCPTool {
  category: "core" | "shared";
  handler: ToolHandler;
  version: number;
}

export class MCPToolError extends Error {
  constructor(
    message: string,
    public code: string = "TOOL_ERROR"
  ) {
    super(message);
    this.name = "MCPToolError";
  }
}

export class MCPResourceNotFoundError extends MCPToolError {
  constructor(uri: string) {
    super(`Resource not found: ${uri}`, "RESOURCE_NOT_FOUND");
  }
}

export class MCPToolNotFoundError extends MCPToolError {
  constructor(toolName: string) {
    super(`Tool not found: ${toolName}`, "TOOL_NOT_FOUND");
  }
}

export class MCPValidationError extends MCPToolError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
  }
}
