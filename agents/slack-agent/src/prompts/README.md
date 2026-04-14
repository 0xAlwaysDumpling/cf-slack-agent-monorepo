# Prompt System

Structured, composable prompt management for the Slack agent.

## Overview

Prompts are composed of 3 optional parts:

- **System** - System-level instructions ("You are a helpful AI...")
- **User** - User-focused instructions ("Ask clarifying questions...")
- **Context** - Context about the current situation ("You're in a Slack thread...")

Each part is stored separately in R2, allowing for reuse and independent management.

## Structure

### Types (`types.ts`)

```typescript
interface PromptPart {
  type: "system" | "user" | "context";
  key: string;
  name: string;
  content: string;
  version: number;
  metadata: PromptPartMetadata;
}

interface ComposedPrompt {
  key: string;
  name: string;
  parts: {
    system?: PromptPart;
    user?: PromptPart;
    context?: PromptPart;
  };
  version: number;
}
```

### Composer (`composer.ts`)

Combines prompt parts into full prompts:

```typescript
const composer = new PromptComposer();

const result = composer.compose({
  system: "You are helpful...",
  user: "Ask questions...",
  context: "Context here..."
});

console.log(result.full); // Full combined prompt
```

### Registry (`registry.ts`)

Manages loading and caching prompt parts from R2:

```typescript
const registry = new PromptRegistry({
  r2Bucket: env.PROMPTS_BUCKET,
  cacheTTL: 5 * 60 * 1000, // 5 minutes
});

// Get a part
const part = await registry.getPart("system", "mentioned");

// List all parts of a type
const allSystem = await registry.listParts("system");

// Save a part
await registry.savePart(part);

// Delete a part
await registry.deletePart("system", "mentioned");
```

## R2 Storage

Prompts are stored in R2 at:

```
prompts/
├── parts/
│   ├── system/
│   │   ├── mentioned.json
│   │   ├── thread-reply.json
│   │   └── index.json
│   ├── user/
│   │   └── index.json
│   └── context/
│       └── index.json
```

Each index.json contains a registry of parts for that type.

## Usage Example

```typescript
import { PromptComposer } from "./composer";
import { PromptRegistry } from "./registry";

// Initialize
const composer = new PromptComposer();
const registry = new PromptRegistry({ r2Bucket });

// Get parts from registry
const systemPart = await registry.getPart("system", "mentioned");
const userPart = await registry.getPart("user", "clarify");

// Compose full prompt
const composed = composer.composeFromParts(systemPart, userPart);

// Use the full prompt
console.log(composed.full);
```

## API via MCP

The prompt system is exposed via MCP tools:

- `prompts.list` - List all prompt parts
- `prompts.get` - Get specific prompt part
- `prompts.compose` - Compose from parts
- `prompts.create` - Create new part
- `prompts.update` - Update existing part
- `prompts.delete` - Delete part
