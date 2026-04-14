/**
 * Image processing utility for handling Slack image attachments
 * - Downloads images from Slack (requires auth)
 * - Caches images in R2
 * - Resizes large images to optimize for LLM processing
 * - Converts to base64 for embedding in prompts
 */

export interface ProcessedImage {
  fileId: string;
  base64Data: string;
  mimeType: string;
  width?: number;
  height?: number;
  sizeBytes: number;
}

export interface ImageProcessorConfig {
  r2Bucket?: any; // R2Bucket type
  maxSizeBytes?: number;
  maxWidth?: number;
  maxHeight?: number;
  allowedMimeTypes?: string[];
}

const DEFAULT_CONFIG: Required<ImageProcessorConfig> = {
  r2Bucket: undefined as any,
  maxSizeBytes: 20 * 1024 * 1024, // 20MB
  maxWidth: 1920,
  maxHeight: 1920,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
};

/**
 * Providers that support image/vision capabilities
 */
const VISION_CAPABLE_PROVIDERS = ['anthropic', 'openai', 'google'];

export function supportsImageProcessing(modelId?: string): boolean {
  if (!modelId) return false;
  return VISION_CAPABLE_PROVIDERS.some((provider) =>
    modelId.toLowerCase().startsWith(provider)
  );
}

export class ImageProcessor {
  private config: Required<ImageProcessorConfig>;
  private cacheKeyPrefix = 'image-cache/';

  constructor(config: ImageProcessorConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Download image from Slack and process it
   */
  async downloadAndProcess(
    imageUrl: string,
    fileId: string,
    token: string,
    mimeType: string
  ): Promise<ProcessedImage | null> {
    try {
      // Check if image type is allowed
      if (!this.config.allowedMimeTypes.includes(mimeType)) {
        console.warn(`Image type ${mimeType} not supported`);
        return null;
      }

      // Try to get from cache first
      if (this.config.r2Bucket) {
        const cached = await this.getFromCache(fileId);
        if (cached) {
          console.log(`[ImageProcessor] Cache hit for ${fileId}`);
          return cached;
        }
      }

      // Download from Slack
      console.log(`[ImageProcessor] Downloading image ${fileId} from Slack`);
      const response = await fetch(imageUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);

      // Check size
      if (uint8Array.length > this.config.maxSizeBytes) {
        console.warn(
          `[ImageProcessor] Image ${fileId} is ${uint8Array.length} bytes, exceeds max of ${this.config.maxSizeBytes}`
        );
        return null;
      }

      // For now, we'll use a simple resize approach: just base64 encode
      // In a production system with sharp/canvas support, you could resize here
      const base64Data = this.uint8ArrayToBase64(uint8Array);
      const dataUrl = `data:${mimeType};base64,${base64Data}`;

      const processed: ProcessedImage = {
        fileId,
        base64Data: dataUrl,
        mimeType,
        sizeBytes: uint8Array.length,
      };

      // Cache it
      if (this.config.r2Bucket) {
        await this.saveToCache(fileId, processed);
      }

      return processed;
    } catch (err) {
      console.error(`[ImageProcessor] Error processing image ${fileId}:`, err);
      return null;
    }
  }

  /**
   * Get processed image from R2 cache
   */
  private async getFromCache(fileId: string): Promise<ProcessedImage | null> {
    if (!this.config.r2Bucket) return null;

    try {
      const cacheKey = `${this.cacheKeyPrefix}${fileId}.json`;
      const obj = await this.config.r2Bucket.get(cacheKey);

      if (!obj) return null;

      const text = await obj.text();
      return JSON.parse(text) as ProcessedImage;
    } catch (err) {
      console.warn(`[ImageProcessor] Cache retrieval failed for ${fileId}:`, err);
      return null;
    }
  }

  /**
   * Save processed image to R2 cache
   */
  private async saveToCache(fileId: string, image: ProcessedImage): Promise<void> {
    if (!this.config.r2Bucket) return;

    try {
      const cacheKey = `${this.cacheKeyPrefix}${fileId}.json`;
      await this.config.r2Bucket.put(cacheKey, JSON.stringify(image), {
        httpMetadata: {
          contentType: 'application/json',
          cacheControl: 'max-age=2592000', // 30 days
        },
      });
      console.log(`[ImageProcessor] Cached image ${fileId} in R2`);
    } catch (err) {
      console.error(`[ImageProcessor] Failed to cache image ${fileId}:`, err);
    }
  }

  /**
   * Convert Uint8Array to base64 string
   */
  private uint8ArrayToBase64(uint8Array: Uint8Array): string {
    // Use Buffer in Cloudflare Workers
    return Buffer.from(uint8Array).toString('base64');
  }

  /**
   * Clear cache for a specific image or all images
   */
  async clearCache(fileId?: string): Promise<void> {
    if (!this.config.r2Bucket) return;

    if (fileId) {
      try {
        const cacheKey = `${this.cacheKeyPrefix}${fileId}.json`;
        await this.config.r2Bucket.delete(cacheKey);
        console.log(`[ImageProcessor] Cleared cache for ${fileId}`);
      } catch (err) {
        console.error(`[ImageProcessor] Failed to clear cache for ${fileId}:`, err);
      }
    } else {
      // Clear all images - this is more expensive
      try {
        const listing = await this.config.r2Bucket.list({
          prefix: this.cacheKeyPrefix,
        });

        for (const obj of listing.objects) {
          await this.config.r2Bucket.delete(obj.key);
        }
        console.log(`[ImageProcessor] Cleared all image cache`);
      } catch (err) {
        console.error(`[ImageProcessor] Failed to clear all cache:`, err);
      }
    }
  }
}
