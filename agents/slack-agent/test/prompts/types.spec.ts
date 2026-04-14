import { describe, it, expect } from "vitest";
import type { PromptPart, ComposedPrompt, PromptPartIndex } from "../../src/prompts/types";

describe("Prompt Types", () => {
  describe("PromptPart", () => {
    it("should have required fields", () => {
      const part: PromptPart = {
        type: "system",
        key: "mentioned",
        name: "Direct Mention",
        content: "You are helpful...",
        version: 1,
        metadata: {
          description: "For mentions",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };

      expect(part.type).toBe("system");
      expect(part.key).toBe("mentioned");
      expect(part.version).toBe(1);
      expect(part.metadata.description).toBeDefined();
    });

    it("should support optional metadata fields", () => {
      const part: PromptPart = {
        type: "user",
        key: "clarify",
        name: "Clarify",
        content: "Ask questions",
        version: 1,
        metadata: {
          description: "Ask for clarification",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          createdBy: "admin",
          tags: ["clarification", "user"],
        },
      };

      expect(part.metadata.createdBy).toBe("admin");
      expect(part.metadata.tags).toContain("clarification");
    });
  });

  describe("ComposedPrompt", () => {
    it("should compose from parts", () => {
      const composed: ComposedPrompt = {
        key: "mentioned-response",
        name: "Direct Response",
        parts: {
          system: {
            type: "system",
            key: "mentioned",
            name: "System",
            content: "You are helpful",
            version: 1,
            metadata: {
              description: "System",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          },
          user: {
            type: "user",
            key: "clarify",
            name: "User",
            content: "Ask questions",
            version: 1,
            metadata: {
              description: "User",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          },
        },
        version: 1,
        metadata: {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };

      expect(composed.parts.system).toBeDefined();
      expect(composed.parts.user).toBeDefined();
      expect(composed.parts.context).toBeUndefined();
    });
  });

  describe("PromptPartIndex", () => {
    it("should index parts by type", () => {
      const index: PromptPartIndex = {
        version: 1,
        type: "system",
        parts: [
          {
            key: "mentioned",
            name: "Direct Mention",
            description: "For mentions",
          },
          {
            key: "thread-reply",
            name: "Thread Reply",
            description: "For threads",
          },
        ],
      };

      expect(index.type).toBe("system");
      expect(index.parts).toHaveLength(2);
      expect(index.parts[0].key).toBe("mentioned");
    });
  });
});
