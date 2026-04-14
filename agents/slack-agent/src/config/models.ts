export type ModelTier = "fastest" | "balanced" | "most-capable";
export type ReasoningCapability = "basic" | "standard" | "extended" | "deep";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  description: string;
  tier: ModelTier;
  reasoning?: ReasoningCapability;
  contextWindow?: number;
  costPer1kInputTokens?: string;
  costPer1kOutputTokens?: string;
  bestFor?: string[];
}

export const AVAILABLE_MODELS: Record<string, ModelInfo[]> = {
  anthropic: [
    {
      id: "anthropic/claude-opus-4-6",
      name: "Claude Opus 4.6",
      provider: "Anthropic",
      tier: "most-capable",
      reasoning: "deep",
      description: "Latest Claude Opus model (Feb 5, 2026). Most capable for complex reasoning and analysis.",
      contextWindow: 200000,
      bestFor: ["Complex reasoning", "Deep analysis", "Research", "Advanced problem-solving"],
    },
    {
      id: "anthropic/claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      provider: "Anthropic",
      tier: "balanced",
      reasoning: "extended",
      description: "Latest Claude Sonnet model (Feb 17, 2026). Excellent balance of speed and capability.",
      contextWindow: 200000,
      bestFor: ["General tasks", "Balanced performance", "Content creation", "Code generation"],
    },
    {
      id: "anthropic/claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      provider: "Anthropic",
      tier: "balanced",
      reasoning: "extended",
      description: "Previous Claude Sonnet generation. Still highly capable and widely deployed.",
      contextWindow: 200000,
      bestFor: ["General tasks", "Balanced performance", "Content creation"],
    },
    {
      id: "anthropic/claude-opus-4-5",
      name: "Claude Opus 4.5",
      provider: "Anthropic",
      tier: "most-capable",
      reasoning: "deep",
      description: "Previous Claude Opus generation. Highly capable for complex analysis.",
      contextWindow: 200000,
      bestFor: ["Complex analysis", "Problem-solving", "Research"],
    },
    {
      id: "anthropic/claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      provider: "Anthropic",
      tier: "fastest",
      reasoning: "basic",
      description: "Fastest and most compact Claude model. Perfect for simple, fast tasks.",
      contextWindow: 200000,
      bestFor: ["Fast responses", "Simple tasks", "Lightweight workloads"],
    },
  ],
  openai: [
    {
      id: "openai/gpt-5.3",
      name: "GPT-5.3",
      provider: "OpenAI",
      tier: "most-capable",
      reasoning: "deep",
      description: "Latest GPT-5 version with advanced reasoning and extended thinking capabilities.",
      contextWindow: 128000,
      bestFor: ["Advanced reasoning", "Complex problems", "Deep analysis"],
    },
    {
      id: "openai/gpt-5.2",
      name: "GPT-5.2",
      provider: "OpenAI",
      tier: "most-capable",
      reasoning: "deep",
      description: "Widely-used GPT-5 version. Best balance of capability and widespread support.",
      contextWindow: 128000,
      bestFor: ["Advanced reasoning", "Complex problems", "General use"],
    },
    {
      id: "openai/gpt-5-mini",
      name: "GPT-5 Mini",
      provider: "OpenAI",
      tier: "fastest",
      reasoning: "standard",
      description: "Fast and efficient version of GPT-5. Great for most tasks with lower latency.",
      contextWindow: 128000,
      bestFor: ["Fast responses", "General tasks", "Cost-effective"],
    },
    {
      id: "openai/gpt-4o",
      name: "GPT-4 Omni",
      provider: "OpenAI",
      tier: "balanced",
      reasoning: "standard",
      description: "Multimodal model with vision and text capabilities. Versatile and balanced.",
      contextWindow: 128000,
      bestFor: ["Vision tasks", "General purpose", "Balanced performance"],
    },
    {
      id: "openai/gpt-4o-mini",
      name: "GPT-4 Omni Mini",
      provider: "OpenAI",
      tier: "fastest",
      reasoning: "basic",
      description: "Lightweight multimodal model. Fast and efficient for most tasks.",
      contextWindow: 128000,
      bestFor: ["Fast responses", "Vision tasks", "Cost-effective"],
    },
  ],
  google: [
    {
      id: "google/gemini-3-pro",
      name: "Gemini 3 Pro",
      provider: "Google AI",
      tier: "most-capable",
      reasoning: "deep",
      description: "Latest Gemini 3 model. Next-generation reasoning with advanced capabilities.",
      contextWindow: 1000000,
      bestFor: ["Advanced reasoning", "Long context", "Complex analysis", "Cutting-edge tasks"],
    },
    {
      id: "google/gemini-3-flash",
      name: "Gemini 3 Flash",
      provider: "Google AI",
      tier: "balanced",
      reasoning: "extended",
      description: "Fast Gemini 3 variant with extended context window.",
      contextWindow: 1000000,
      bestFor: ["Fast responses", "Long context", "General tasks"],
    },
    {
      id: "google/gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      provider: "Google AI",
      tier: "most-capable",
      reasoning: "deep",
      description: "Most capable Gemini 2.5 model. Advanced reasoning with extended thinking capabilities.",
      contextWindow: 1000000,
      bestFor: ["Advanced reasoning", "Long context", "Complex analysis"],
    },
    {
      id: "google/gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      provider: "Google AI",
      tier: "balanced",
      reasoning: "extended",
      description: "Fast and capable model with extended context window. Excellent for most tasks.",
      contextWindow: 1000000,
      bestFor: ["Fast responses", "Long context", "General tasks"],
    },
    {
      id: "google/gemini-2.5-flash-lite",
      name: "Gemini 2.5 Flash Lite",
      provider: "Google AI",
      tier: "fastest",
      reasoning: "basic",
      description: "Fastest and most lightweight Gemini 2.5 model. Perfect for simple tasks.",
      contextWindow: 1000000,
      bestFor: ["Fast responses", "Simple tasks", "High throughput"],
    },
    {
      id: "google/gemini-2.0-flash",
      name: "Gemini 2.0 Flash",
      provider: "Google AI",
      tier: "balanced",
      reasoning: "standard",
      description: "Previous generation Flash model. Still highly capable and efficient.",
      contextWindow: 1000000,
      bestFor: ["General tasks", "Long context", "Reliable performance"],
    },
  ],
  mistral: [
    {
      id: "mistral/mistral-large-latest",
      name: "Mistral Large",
      provider: "Mistral AI",
      tier: "most-capable",
      reasoning: "extended",
      description: "Most capable Mistral model. Strong reasoning and analysis capabilities.",
      contextWindow: 128000,
      bestFor: ["Complex reasoning", "Analysis", "Code generation"],
    },
  ],
  groq: [
    {
      id: "groq/llama3-8b-8192",
      name: "Llama 3 8B",
      provider: "Groq",
      tier: "fastest",
      reasoning: "basic",
      description: "Fast open-source model optimized for speed on Groq infrastructure.",
      contextWindow: 8192,
      bestFor: ["Fast responses", "General tasks", "High throughput"],
    },
  ],
  deepseek: [
    {
      id: "deepseek/deepseek-chat",
      name: "DeepSeek Chat",
      provider: "DeepSeek",
      tier: "balanced",
      reasoning: "standard",
      description: "Capable open-source model with good reasoning and language understanding.",
      contextWindow: 4096,
      bestFor: ["General tasks", "Balanced performance", "Cost-effective"],
    },
  ],
  grok: [
    {
      id: "grok/grok-4",
      name: "Grok 4",
      provider: "xAI",
      tier: "most-capable",
      reasoning: "extended",
      description: "Latest Grok model with strong reasoning and knowledge capabilities.",
      contextWindow: 131072,
      bestFor: ["Advanced reasoning", "Current events", "Complex analysis"],
    },
  ],
};

export function formatModelsForSlack(): string {
  let message = "*Available Models*\n\n";

  for (const [provider, models] of Object.entries(AVAILABLE_MODELS)) {
    const providerName = models[0]?.provider || provider;
    message += `*${providerName}*\n`;

    for (const model of models) {
      // Build the header with tier emoji and name
      const tierEmoji = getTierEmoji(model.tier);
      const reasoningLabel = model.reasoning ? ` • ${model.reasoning} reasoning` : "";
      message += `${tierEmoji} \`[${model.id}]\` – ${model.name}${reasoningLabel}\n`;
      
      message += `  ${model.description}\n`;
      
      if (model.contextWindow) {
        message += `  📚 Context: ${(model.contextWindow / 1000).toLocaleString()}K tokens`;
      }
      
      if (model.bestFor && model.bestFor.length > 0) {
        message += ` | Best for: ${model.bestFor.join(", ")}`;
      }
      
      message += "\n\n";
    }
  }

  message += "*Tier Legend:*\n";
  message += "⚡ Fastest – Low latency, optimized for speed\n";
  message += "⚖️  Balanced – Good balance of speed and capability\n";
  message += "🧠 Most Capable – Advanced reasoning and complex tasks\n\n";
  message += "*Usage:* Start your message with `[model-id]` to use a specific model:\n";
  message += "`[anthropic/claude-4-6] Explain quantum computing`";

  return message;
}

function getTierEmoji(tier: ModelTier): string {
  switch (tier) {
    case "fastest":
      return "⚡";
    case "balanced":
      return "⚖️ ";
    case "most-capable":
      return "🧠";
    default:
      return "•";
  }
}

export function isModelsCommand(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return (
    normalized === "[models]" ||
    normalized === "models" ||
    normalized === "[list models]" ||
    normalized === "list models" ||
    normalized === "show models"
  );
}
