import type { ProviderConfig } from "./types";

export const PROVIDERS: Record<string, ProviderConfig> = {
  gemini: {
    key: "gemini",
    name: "Google Gemini",
    model: "google-ai-studio/gemini-2.5-flash",
    description: "Fast and capable model for general tasks",
  },
  claude: {
    key: "claude",
    name: "Anthropic Claude",
    // Must match AI Gateway unified id (see models.ts); dated snapshots often 404 or error.
    model: "anthropic/claude-haiku-4-5",
    description: "Advanced reasoning and nuanced understanding",
  },
  openai: {
    key: "openai",
    name: "OpenAI GPT-5",
    model: "openai/gpt-5",
    description: "Latest OpenAI model",
  },
} as const;

export const DEFAULT_PROVIDER = "claude";

export function getProvider(input?: string): ProviderConfig {
  if (!input) {
    return PROVIDERS[DEFAULT_PROVIDER];
  }

  const key = input.toLowerCase().trim();
  if (key in PROVIDERS) {
    return PROVIDERS[key as keyof typeof PROVIDERS];
  }

  // Treat as a raw unified model string (e.g. "openai/gpt-4o-mini")
  return {
    key: input,
    name: input,
    model: input,
  };
}

export function getProviderModel(input?: string): string {
  return getProvider(input).model;
}
