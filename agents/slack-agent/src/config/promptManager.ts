import type { SystemPrompt } from "./types";
import { DEFAULT_PROMPTS } from "./prompts";

export class PromptManager {
  private cache: Map<string, SystemPrompt> = new Map();
  private r2Bucket?: R2Bucket;

  constructor(r2Bucket?: R2Bucket) {
    this.r2Bucket = r2Bucket;
    // Initialize cache with defaults
    Object.values(DEFAULT_PROMPTS).forEach((prompt) => {
      this.cache.set(prompt.key, prompt);
    });
  }

  async getPrompt(key: string): Promise<SystemPrompt | null> {
    // Check cache first
    if (this.cache.has(key)) {
      return this.cache.get(key) || null;
    }

    // Try to fetch from R2 if available
    if (this.r2Bucket) {
      try {
        const obj = await this.r2Bucket.get(`prompts/${key}.json`);
        if (obj) {
          const text = await obj.text();
          const prompt = JSON.parse(text) as SystemPrompt;
          this.cache.set(key, prompt);
          return prompt;
        }
      } catch (error) {
        console.error(`Failed to fetch prompt "${key}" from R2:`, error);
      }
    }

    // Return null if not found anywhere
    return null;
  }

  async savePrompt(prompt: SystemPrompt): Promise<void> {
    // Update cache
    this.cache.set(prompt.key, prompt);

    // Save to R2 if available
    if (this.r2Bucket) {
      try {
        await this.r2Bucket.put(
          `prompts/${prompt.key}.json`,
          JSON.stringify(prompt, null, 2),
          {
            httpMetadata: {
              contentType: "application/json",
            },
          }
        );
      } catch (error) {
        console.error(`Failed to save prompt "${prompt.key}" to R2:`, error);
        throw error;
      }
    }
  }

  async deletePrompt(key: string): Promise<void> {
    // Remove from cache
    this.cache.delete(key);

    // Delete from R2 if available
    if (this.r2Bucket) {
      try {
        await this.r2Bucket.delete(`prompts/${key}.json`);
      } catch (error) {
        console.error(`Failed to delete prompt "${key}" from R2:`, error);
        throw error;
      }
    }
  }

  async listPrompts(): Promise<SystemPrompt[]> {
    const prompts: SystemPrompt[] = [];

    // Get all cached prompts
    this.cache.forEach((prompt) => {
      prompts.push(prompt);
    });

    // Try to list from R2 if available
    if (this.r2Bucket) {
      try {
        const listing = await this.r2Bucket.list({ prefix: "prompts/" });
        for (const object of listing.objects) {
          const key = object.key.replace("prompts/", "").replace(".json", "");
          if (!this.cache.has(key)) {
            const prompt = await this.getPrompt(key);
            if (prompt) prompts.push(prompt);
          }
        }
      } catch (error) {
        console.error("Failed to list prompts from R2:", error);
      }
    }

    return prompts;
  }

  getPromptSync(key: string): SystemPrompt | null {
    return this.cache.get(key) || null;
  }
}
