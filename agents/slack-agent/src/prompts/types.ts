/**
 * Prompt types and interfaces for the MCP-native prompt system.
 * Prompts are composed of optional system/user/context parts.
 */

export type PromptPartType = "system" | "user" | "context";

export interface PromptPartMetadata {
  description: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  tags?: string[];
}

export interface PromptPart {
  type: PromptPartType;
  key: string;
  name: string;
  content: string;
  version: number;
  metadata: PromptPartMetadata;
}

export interface ComposedPrompt {
  key: string;
  name: string;
  description?: string;
  parts: {
    system?: PromptPart;
    user?: PromptPart;
    context?: PromptPart;
  };
  version: number;
  metadata: {
    createdAt: string;
    updatedAt: string;
    createdBy?: string;
  };
}

export interface PromptPartIndex {
  version: number;
  type: PromptPartType;
  parts: Array<{
    key: string;
    name: string;
    description?: string;
  }>;
}

export interface PromptCompositionRequest {
  system?: string;
  user?: string;
  context?: string;
}

export interface PromptCompositionResult {
  system?: string;
  user?: string;
  context?: string;
  full: string;
}

export class PromptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptValidationError";
  }
}
