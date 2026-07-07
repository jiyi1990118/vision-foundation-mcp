/**
 * Metadata Extractor — extracts image metadata using lightweight algorithms.
 * Does NOT call any model. Uses sharp only.
 * @see Docs/01-architecture/02-request-lifecycle.md (Stage 3)
 */
import sharp from 'sharp';
import type { ImageInput, ImageMetadata } from '../types/domain.js';

export async function extractMetadata(image: ImageInput): Promise<ImageMetadata> {
  const meta = await sharp(image.buffer).metadata();

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  return {
    width,
    height,
    aspectRatio: width > 0 && height > 0 ? width / height : 0,
    format: meta.format ?? 'unknown',
    hasAlpha: meta.hasAlpha ?? false,
    fileSize: image.size,
    complexity: estimateComplexity(width, height, image.size),
  };
}

/**
 * Rough complexity estimate based on dimensions and file size.
 * No model inference — just heuristics.
 */
function estimateComplexity(
  width: number,
  height: number,
  fileSize: number,
): 'low' | 'medium' | 'high' {
  const pixels = width * height;
  // Rough heuristic: more pixels + larger file = more complex
  if (pixels < 500_000 || fileSize < 100_000) return 'low';
  if (pixels < 2_000_000 || fileSize < 1_000_000) return 'medium';
  return 'high';
}
