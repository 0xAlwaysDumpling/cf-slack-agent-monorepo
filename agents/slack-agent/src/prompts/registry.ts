/**
 * Prompt registry - manages loading and caching prompt parts from R2.
 */

import type { PromptPart, PromptPartIndex, PromptPartType } from "./types";

export interface PromptRegistryOptions {
  r2Bucket: R2Bucket;
  cacheTTL?: number;
}

export class PromptRegistry {
  private r2Bucket: R2Bucket;
  private cache: Map<string, { data: unknown; timestamp: number }> = new Map();
  private cacheTTL: number; // ms

  constructor(options: PromptRegistryOptions) {
    this.r2Bucket = options.r2Bucket;
    this.cacheTTL = options.cacheTTL ?? 5 * 60 * 1000; // 5 minutes default
  }

  /**
   * Get a specific prompt part by key and type.
   */
  async getPart(type: PromptPartType, key: string): Promise<PromptPart | null> {
    const path = `prompts/parts/${type}/${key}.json`;
    const cached = this.getFromCache<PromptPart>(path);

    if (cached) return cached;

    try {
      const obj = await this.r2Bucket.get(path);
      if (!obj) return null;

      const text = await obj.text();
      const part = JSON.parse(text) as PromptPart;

      this.setCache(path, part);
      return part;
    } catch (error) {
      console.error(`Failed to fetch prompt part ${path}:`, error);
      return null;
    }
  }

  /**
   * List all prompt parts of a specific type.
   */
  async listParts(type: PromptPartType): Promise<PromptPart[]> {
    const indexPath = `prompts/parts/${type}/index.json`;
    const cached = this.getFromCache<PromptPartIndex>(indexPath);

    let index: PromptPartIndex;

    if (cached) {
      index = cached;
    } else {
      try {
        const obj = await this.r2Bucket.get(indexPath);
        if (!obj) return [];

        const text = await obj.text();
        index = JSON.parse(text) as PromptPartIndex;
        this.setCache(indexPath, index);
      } catch (error) {
        console.error(`Failed to fetch prompt parts index ${indexPath}:`, error);
        return [];
      }
    }

    const parts: PromptPart[] = [];

    for (const entry of index.parts) {
      const part = await this.getPart(type, entry.key);
      if (part) {
        parts.push(part);
      }
    }

    return parts;
  }

  /**
   * Save a prompt part to R2.
   */
  async savePart(part: PromptPart): Promise<void> {
    const path = `prompts/parts/${part.type}/${part.key}.json`;

    try {
      // Save the part
      await this.r2Bucket.put(path, JSON.stringify(part, null, 2), {
        httpMetadata: { contentType: "application/json" },
      });

      // Invalidate index cache
      const indexPath = `prompts/parts/${part.type}/index.json`;
      this.cache.delete(indexPath);

      // Invalidate part cache
      this.cache.delete(path);

      console.log(`Saved prompt part: ${path}`);
    } catch (error) {
      console.error(`Failed to save prompt part ${path}:`, error);
      throw error;
    }
  }

  /**
   * Delete a prompt part from R2.
   */
  async deletePart(type: PromptPartType, key: string): Promise<void> {
    const path = `prompts/parts/${type}/${key}.json`;

    try {
      await this.r2Bucket.delete(path);

      // Invalidate caches
      this.cache.delete(path);
      const indexPath = `prompts/parts/${type}/index.json`;
      this.cache.delete(indexPath);

      console.log(`Deleted prompt part: ${path}`);
    } catch (error) {
      console.error(`Failed to delete prompt part ${path}:`, error);
      throw error;
    }
  }

  /**
   * Invalidate cache for a specific path or all cache if no path given.
   */
  invalidateCache(path?: string): void {
    if (path) {
      this.cache.delete(path);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Get value from cache if not expired.
   */
  private getFromCache<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > this.cacheTTL) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  /**
   * Store value in cache with timestamp.
   */
  private setCache(key: string, data: unknown): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear all caches.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache stats (for debugging).
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}
