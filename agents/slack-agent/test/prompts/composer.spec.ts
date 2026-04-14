import { describe, it, expect } from "vitest";
import { PromptComposer } from "../../src/prompts/composer";
import { PromptValidationError } from "../../src/prompts/types";

describe("PromptComposer", () => {
  const composer = new PromptComposer();

  describe("compose", () => {
    it("should compose all three parts", () => {
      const result = composer.compose({
        system: "System",
        user: "User",
        context: "Context",
      });

      expect(result.system).toBe("System");
      expect(result.user).toBe("User");
      expect(result.context).toBe("Context");
      expect(result.full).toContain("System");
      expect(result.full).toContain("User");
      expect(result.full).toContain("Context");
    });

    it("should compose with only system", () => {
      const result = composer.compose({
        system: "System only",
      });

      expect(result.system).toBe("System only");
      expect(result.user).toBeUndefined();
      expect(result.context).toBeUndefined();
      expect(result.full).toBe("System only");
    });

    it("should compose system and user without context", () => {
      const result = composer.compose({
        system: "System",
        user: "User",
      });

      expect(result.full).toContain("System");
      expect(result.full).toContain("User");
      expect(result.full).not.toContain("Context");
    });

    it("should separate parts with ---", () => {
      const result = composer.compose({
        system: "System",
        context: "Context",
      });

      expect(result.full).toContain("---");
    });
  });

  describe("validate", () => {
    it("should pass with all parts", () => {
      expect(() => {
        composer.validate({
          system: "System",
          user: "User",
          context: "Context",
        });
      }).not.toThrow();
    });

    it("should pass with one part", () => {
      expect(() => {
        composer.validate({ system: "System" });
      }).not.toThrow();
    });

    it("should fail with no parts", () => {
      expect(() => {
        composer.validate({});
      }).toThrow(PromptValidationError);
    });

    it("should fail with empty string", () => {
      expect(() => {
        composer.validate({ system: "" });
      }).toThrow(PromptValidationError);
    });
  });

  describe("merge", () => {
    it("should merge with override taking precedence", () => {
      const base = { system: "Base", user: "Base User" };
      const override = { system: "Override" };

      const result = composer.merge(base, override);

      expect(result.system).toBe("Override");
      expect(result.user).toBe("Base User");
    });

    it("should preserve base when no override", () => {
      const base = { system: "System", context: "Context" };
      const override = { user: "User" };

      const result = composer.merge(base, override);

      expect(result.system).toBe("System");
      expect(result.context).toBe("Context");
      expect(result.user).toBe("User");
    });
  });
});
