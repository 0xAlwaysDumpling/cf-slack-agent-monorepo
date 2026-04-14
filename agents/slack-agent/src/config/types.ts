export type SystemPromptKey = string;

export interface SystemPrompt {
  key: SystemPromptKey;
  name: string;
  description: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderConfig {
  key: string;
  name: string;
  model: string;
  description?: string;
}

export type ProviderKey = string;
