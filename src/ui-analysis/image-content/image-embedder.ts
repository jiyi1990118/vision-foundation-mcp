/**
 * Image data-URL embedder (Stream S29 / G-D3).
 *
 * Crops each detected icon/image/logo region out of the source image via
 * sharp and embeds the result as a `data:image/png;base64,...` URL onto
 * {@link ImageContentInfo.dataUrl} in place. This lets downstream agents
 * "see" image content even when `use_llm=false` (no VLM description path).
 *
 * Strictly bounded to avoid payload blow-up: at most `maxItems` regions
 * (default 12) and each crop's base64 must fit under `maxBytes` (default
 * 16KB) or it is skipped. Independent of the VLM describer; both may run.
 *
 * @see ./image-content-extractor.js  (ImageContentInfo source)
 * @see ./image-describer.js          (clamp + sharp extract pattern reference)
 * @see ../../types/domain.js         (ImageInput)
 */
import sharp from 'sharp';
import type { ImageInput } from '../../types/domain.js';
import type { ImageContentInfo } from './image-content-extractor.js';

export interface EmbedOptions {
  maxItems?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_ITEMS = 12;
const DEFAULT_MAX_BYTES = 16 * 1024;
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';

export async function embedImageDataUrls(
  image: ImageInput,
  contents: ImageContentInfo[],
  options?: EmbedOptions,
): Promise<void> {
  if (contents.length === 0) return;
  const maxItems = options?.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const signal = options?.signal;

  const targets = contents.slice(0, maxItems);
  if (targets.length === 0) return;

  const meta = await sharp(image.buffer).metadata();
  const metaW = meta.width ?? 1;
  const metaH = meta.height ?? 1;

  for (const c of targets) {
    if (signal?.aborted) break;
    try {
      const left = Math.max(0, Math.floor(c.crop.x));
      const top = Math.max(0, Math.floor(c.crop.y));
      if (left >= metaW || top >= metaH) continue;
      const width = Math.min(metaW - left, Math.max(1, Math.floor(c.crop.w)));
      const height = Math.min(metaH - top, Math.max(1, Math.floor(c.crop.h)));
      const cropBuf = await sharp(image.buffer)
        .extract({ left, top, width, height })
        .png()
        .toBuffer();
      const b64 = cropBuf.toString('base64');
      const dataUrl = PNG_DATA_URL_PREFIX + b64;
      if (dataUrl.length > maxBytes) continue;
      c.dataUrl = dataUrl;
    } catch {
      // single crop failure: skip, do not affect other regions
    }
  }
}
