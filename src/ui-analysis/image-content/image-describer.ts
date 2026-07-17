/**
 * Image describer (Stream S16) - VLM content description for image/icon/logo.
 *
 * The only legitimate LLM use inside the MCP: describing *what* a detected
 * image/icon/logo region depicts (not generating code). Crops each region out
 * of the source image via sharp, sends it to the vision provider with a short
 * Chinese prompt, and writes the trimmed text onto
 * {@link ImageContentInfo.description} in place.
 *
 * Gated entirely by `options.use_llm === true` at the caller (vision-analyze);
 * this module is never reached when use_llm is false/absent, so the default
 * path incurs zero VLM cost.
 *
 * @see ./image-content-extractor.js  (ImageContentInfo source)
 * @see ../../providers/types.js       (VisionProvider.infer contract)
 * @see ../../types/domain.js         (ImageInput / InferenceRequest)
 */
import sharp from 'sharp';
import type { VisionProvider } from '../../providers/types.js';
import type { ImageInput } from '../../types/domain.js';
import type { ImageContentInfo } from './image-content-extractor.js';

export interface DescribeOptions {
  maxItems?: number;
  concurrency?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_ITEMS = 8;
const DEFAULT_CONCURRENCY = 2;
const DESCRIBE_PROMPT = '用一句话简短描述这个 UI 图标/图片内容（中文，<20字）。';
const DESCRIBE_MAX_TOKENS = 32;
const DESCRIBE_TEMPERATURE = 0;

export async function describeImageContents(
  provider: VisionProvider,
  image: ImageInput,
  contents: ImageContentInfo[],
  options?: DescribeOptions,
): Promise<void> {
  if (contents.length === 0) return;
  const maxItems = options?.maxItems ?? DEFAULT_MAX_ITEMS;
  const concurrency = Math.max(1, options?.concurrency ?? DEFAULT_CONCURRENCY);
  const signal = options?.signal;

  const targets = contents.slice(0, maxItems);
  if (targets.length === 0) return;

  if (!provider.isLoaded()) {
    await provider.load();
  }

  const meta = await sharp(image.buffer).metadata();
  const metaW = meta.width ?? 1;
  const metaH = meta.height ?? 1;

  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (c) => {
        try {
          const left = Math.max(0, Math.floor(c.bbox.x));
          const top = Math.max(0, Math.floor(c.bbox.y));
          if (left >= metaW || top >= metaH) return;
          const width = Math.min(metaW - left, Math.max(1, Math.floor(c.bbox.w)));
          const height = Math.min(metaH - top, Math.max(1, Math.floor(c.bbox.h)));
          const cropBuf = await sharp(image.buffer)
            .extract({ left, top, width, height })
            .png()
            .toBuffer();
          const cropImage: ImageInput = {
            buffer: cropBuf,
            mimeType: 'image/png',
            source: `crop:${c.index}`,
            size: cropBuf.length,
          };
          const res = await provider.infer({
            image: cropImage,
            prompt: DESCRIBE_PROMPT,
            maxTokens: DESCRIBE_MAX_TOKENS,
            temperature: DESCRIBE_TEMPERATURE,
            signal,
          });
          const text = res.text.trim();
          if (text.length > 0) {
            c.description = text;
          }
        } catch {
          // single description failure: skip, do not affect other regions
        }
      }),
    );
  }
}
