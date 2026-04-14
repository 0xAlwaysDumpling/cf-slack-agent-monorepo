export type MCPToolResultType = "text" | "image" | "resource";

export interface MCPToolInputSchema {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
}

export interface MCPToolResult {
	type: MCPToolResultType;
	content: string | { resourceUri: string };
}

export interface ToolContext {
	agentId: string;
	teamId: string;
	userId?: string;
	env: Env;
}

export interface ToolExecutionParams {
	[key: string]: unknown;
}

export interface ToolHandler {
	(params: ToolExecutionParams, context: ToolContext): Promise<MCPToolResult>;
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: MCPToolInputSchema;
	category: "core" | "shared";
	handler: ToolHandler;
	version: number;
}
