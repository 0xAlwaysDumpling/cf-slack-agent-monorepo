/**
 * Prompt composer - combines prompt parts (system/user/context) into full prompts.
 */

import type {
  PromptPart,
  ComposedPrompt,
  PromptCompositionRequest,
  PromptCompositionResult,
  PromptValidationError,
} from "./types";
import { PromptValidationError as ValidationError } from "./types";

export class PromptComposer {
  /**
   * Compose a full prompt from individual parts.
   * Parts are joined with proper separators.
   */
  compose(parts: PromptCompositionRequest): PromptCompositionResult {
    const sections: string[] = [];

    if (parts.system) {
      sections.push(parts.system);
    }

    if (parts.context) {
      if (sections.length > 0) {
        sections.push("---");
      }
      sections.push(parts.context);
    }

    if (parts.user) {
      if (sections.length > 0) {
        sections.push("---");
      }
      sections.push(parts.user);
    }

    return {
      system: parts.system,
      context: parts.context,
      user: parts.user,
      full: sections.join("\n\n"),
    };
  }

  /**
   * Compose a full prompt from PromptPart objects.
   */
  composeFromParts(systemPart?: PromptPart, userPart?: PromptPart, contextPart?: PromptPart): PromptCompositionResult {
    return this.compose({
      system: systemPart?.content,
      user: userPart?.content,
      context: contextPart?.content,
    });
  }

  /**
   * Create a ComposedPrompt from parts.
   */
  createComposedPrompt(
    key: string,
    name: string,
    systemPart?: PromptPart,
    userPart?: PromptPart,
    contextPart?: PromptPart
  ): ComposedPrompt {
    const composition = this.composeFromParts(systemPart, userPart, contextPart);

    return {
      key,
      name,
      parts: {
        system: systemPart,
        user: userPart,
        context: contextPart,
      },
      version: 1,
      metadata: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Validate that a prompt composition is valid.
   * - At least one part must be present
   * - Parts must have content
   */
  validate(request: PromptCompositionRequest): void {
    const hasContent = request.system || request.context || request.user;

    if (!hasContent) {
      throw new ValidationError("At least one prompt part (system, user, or context) must be provided");
    }

    if (request.system === "") {
      throw new ValidationError("System part cannot be empty string");
    }

    if (request.user === "") {
      throw new ValidationError("User part cannot be empty string");
    }

    if (request.context === "") {
      throw new ValidationError("Context part cannot be empty string");
    }
  }

  /**
   * Merge two prompts with another taking precedence.
   */
  merge(
    base: PromptCompositionRequest,
    override: Partial<PromptCompositionRequest>
  ): PromptCompositionRequest {
    return {
      system: override.system ?? base.system,
      user: override.user ?? base.user,
      context: override.context ?? base.context,
    };
  }
}
