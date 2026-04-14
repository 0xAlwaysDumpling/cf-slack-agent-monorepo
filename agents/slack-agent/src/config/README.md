# Configuration System

This document describes the abstracted configuration system for system prompts and LLM providers.

## Structure

```
src/config/
├── types.ts              # TypeScript interfaces for configuration
├── providers.ts          # LLM provider definitions and utilities
├── prompts.ts            # Default system prompt definitions
└── promptManager.ts      # Runtime prompt manager with R2 storage
```

## Types (`types.ts`)

### `SystemPrompt`
```typescript
interface SystemPrompt {
  key: SystemPromptKey;              // Unique identifier (e.g., "mentioned", "threadReply")
  name: string;                      // Human-readable name
  description: string;               // What this prompt is used for
  content: string;                   // The actual system prompt text
  version: number;                   // Version for tracking changes
  createdAt: string;                 // ISO timestamp
  updatedAt: string;                 // ISO timestamp
}
```

### `ProviderConfig`
```typescript
interface ProviderConfig {
  key: string;                       // Unique identifier (e.g., "claude", "gemini")
  name: string;                      // Human-readable name
  model: string;                     // Full model identifier for AI gateway
  description?: string;              // Optional description
}
```

## Providers (`providers.ts`)

Pre-configured LLM providers are stored in the `PROVIDERS` constant:

- **gemini** - Google Gemini 2.5 Flash (default, fast)
- **claude** - Anthropic Claude Sonnet 4.5 (advanced reasoning)
- **openai** - OpenAI GPT-5 (latest OpenAI)

### Adding a New Provider

1. Add to the `PROVIDERS` object in `src/config/providers.ts`:

```typescript
export const PROVIDERS: Record<string, ProviderConfig> = {
  // ... existing providers
  grok: {
    key: "grok",
    name: "xAI Grok",
    model: "xai/grok-3",
    description: "xAI's Grok model",
  },
};
```

2. Use it in messages with the model directive:
```
[grok] How do I optimize this database query?
```

## System Prompts (`prompts.ts` & `promptManager.ts`)

### Default Prompts

The system comes with two default prompts:

1. **mentioned** - Used when the bot is directly mentioned or in DMs
2. **threadReply** - Used when responding to thread replies

These are defined in `src/config/prompts.ts` and automatically loaded into the cache.

### Runtime Management

The `PromptManager` class handles dynamic prompt management:

```typescript
const promptManager = new PromptManager(r2Bucket?);

// Get a prompt (from cache or R2)
const prompt = await promptManager.getPrompt("mentioned");

// Save a new prompt to R2
await promptManager.savePrompt({
  key: "custom",
  name: "Custom Prompt",
  description: "My custom prompt",
  content: "You are...",
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

// Delete a prompt
await promptManager.deletePrompt("custom");

// List all available prompts
const prompts = await promptManager.listPrompts();

// Get from cache synchronously
const cached = promptManager.getPromptSync("mentioned");
```

### Storage

- **Local Cache**: All prompts are cached in memory for fast access
- **R2 Storage** (optional): Prompts can be persisted to Cloudflare R2 for dynamic updates

Prompts are stored in R2 under the `prompts/` prefix as JSON files.

## Usage in Code

### Using Prompts by Key

```typescript
const content = await agent.generateAIReply(
  conversation,
  "claude",           // Model (optional)
  "threadReply"       // Prompt key (optional, defaults to "mentioned")
);
```

### Adding Custom Prompts at Runtime

```typescript
await promptManager.savePrompt({
  key: "customer_support",
  name: "Customer Support",
  description: "Tone for customer support interactions",
  content: "You are a helpful customer support agent...",
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

// Now use it
const response = await agent.generateAIReply(
  conversation,
  undefined,
  "customer_support"
);
```

## R2 Bucket Setup

The R2 bucket binding is configured in `wrangler.jsonc`:

```jsonc
"r2": {
  "bindings": [
    {
      "bucket_name": "slack-agent-prompts",
      "binding": "PROMPTS_BUCKET"
    }
  ]
}
```

To create the bucket locally or deploy it:

```bash
# Create bucket for development
npx wrangler r2 bucket create slack-agent-prompts --local

# Create bucket in production
npx wrangler r2 bucket create slack-agent-prompts
```

## Future Enhancements

1. **API Endpoints** - Add routes to create/edit/delete prompts dynamically
2. **Versioning** - Track prompt versions and allow rollbacks
3. **Analytics** - Track which prompts are used and their effectiveness
4. **Prompt Templates** - Support prompt templates with variables
5. **A/B Testing** - Route different conversations to different prompts for comparison
