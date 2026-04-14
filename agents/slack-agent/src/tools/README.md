# MCP-Native Tool System

All agent capabilities are exposed as standardized MCP tools.

## Overview

The tool system provides:

- **Discovery** - Tool graph showing what's available
- **Execution** - Call tools with validation
- **Caching** - Event-based (not TTL) cache invalidation
- **Bridge** - Convert between MCP protocol and handlers

## Architecture

### Types (`types.ts`)

Core MCP interfaces:

```typescript
interface MCPTool {
  name: string;
  description: string;
  inputSchema: MCPToolInputSchema;
}

interface ToolDefinition extends MCPTool {
  category: "core" | "shared";
  handler: ToolHandler;
  version: number;
}

interface ToolDiscoveryGraph {
  tools: ToolDiscoveryEntry[];
  toolsByCategory: { core: []; shared: []; custom: [] };
}
```

### Discovery (`discovery.ts`)

Builds and queries the tool graph:

```typescript
const discovery = new ToolDiscovery(r2Bucket, cache);

// Get full graph
const graph = await discovery.getGraph();

// Find tools
const tool = await discovery.findTool("prompts.list");
const tools = await discovery.getToolsByCategory("core");
const results = await discovery.search("prompt");

// Register/unregister
await discovery.registerTool(entry);
await discovery.unregisterTool("tool.name");
```

### Cache (`cache.ts`)

Event-based cache with no TTL:

```typescript
const cache = new EventBasedCache();

// Subscribe to events
cache.subscribe("tool:updated", (event, key) => {
  console.log(`Tool ${key} was updated`);
});

// Invalidate on updates
await cache.invalidateTool("prompts.list");
await cache.invalidatePrompt("mentioned");
await cache.invalidateDiscovery();
```

### MCP Bridge (`mcp-bridge.ts`)

Executes tools and validates schemas:

```typescript
const bridge = new MCPBridge(discovery, cache);

// Register tools
bridge.registerTools(toolDefinitions);

// Execute
const result = await bridge.executeTool("prompts.list", {}, context);

// Get tools in MCP format
const mcpTools = bridge.getTools();
```

## MCP Tools

### Prompt Tools (`mcp-handlers/prompts.ts`)

- `prompts.list` - List prompt parts
- `prompts.get` - Get part by key
- `prompts.compose` - Compose full prompt
- `prompts.create` - Create new part
- `prompts.update` - Update part
- `prompts.delete` - Delete part

### Logs Tools (`mcp-handlers/logs.ts`)

- `logs.query` - SQL query on D1
- `logs.search` - Search logs
- `logs.recent` - Get recent entries

### Discovery Tools (`mcp-handlers/discovery.ts`)

- `tools.discover` - List all tools
- `tools.describe` - Get tool details
- `tools.search` - Search tools
- `tools.related` - Get related tools

## Tool Execution Flow

```
1. LLM decides to call tool
2. MCPBridge.executeTool() called
3. Find tool definition by name
4. Validate input against schema
5. Call handler function
6. Handler executes (may use R2, D1, etc.)
7. Return MCPToolResult
8. Result sent back to LLM
```

## Adding New Tools

1. Create tool definitions in a handler file
2. Register with bridge
3. Add entry to discovery graph
4. Subscribe to cache events if needed

Example:

```typescript
const myTools: ToolDefinition[] = [
  {
    name: "custom.action",
    description: "Does something",
    category: "core",
    version: 1,
    inputSchema: { type: "object", properties: {...} },
    handler: async (params, context) => {
      // Implementation
      return { type: "text", content: "..." };
    },
  },
];

bridge.registerTools(myTools);
await discovery.registerTool(entry);
```

## Event-Based Caching

Unlike TTL-based caches, this system invalidates only when things actually change:

```
Tool Updated → emit "tool:updated" → subscribers notified → cache cleared
```

This ensures:
- No stale data returned before it should be
- No unnecessary cache misses after update
- Real-time consistency across agents
