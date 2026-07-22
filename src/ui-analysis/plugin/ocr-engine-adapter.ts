/**
 * OcrEngine adapter wrapping the existing `PpuPaddleOcrProvider`.
 *
 * Composes (does not inherit) the provider: `recognize()` delegates to
 * `provider.infer()` and parses the returned JSON text into `VisionOcrItem[]`.
 *
 * @see src/providers/ppu-paddle-ocr/provider.ts
 */
import type { ImageInput } from '../../types/domain.js';
import type { PpuPaddleOcrProvider } from '../../providers/ppu-paddle-ocr/provider.js';
import type { BBox, VisionOcrItem } from '../ir/types.js';
import type { OcrEngine } from './types.js';

interface NormalizedOcrTextLike {
  text?: string;
  position?: string;
  confidence?: number;
}

interface NormalizedOcrResultLike {
  texts?: NormalizedOcrTextLike[];
}

/**
 * Parse the JSON string emitted by `PpuPaddleOcrProvider.infer()` into
 * `VisionOcrItem[]`. Returns an empty array when the payload is absent or
 * malformed. The `position` field uses the `"x1,y1,x2,y2"` convention emitted
 * by `normalizePaddleOcrResult`; items lacking a position are dropped since a
 * `VisionOcrItem` requires a bbox.
 */
export function parseOcrTextToItems(text: string): VisionOcrItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const result = parsed as NormalizedOcrResultLike;
  if (!result || !Array.isArray(result.texts)) return [];

  const items: VisionOcrItem[] = [];
  for (const t of result.texts) {
    if (!t || typeof t.text !== 'string') continue;
    const bbox = parsePosition(t.position);
    if (!bbox) continue;
    const confidence = typeof t.confidence === 'number' ? t.confidence : 1;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    items.push({
      text: t.text,
      bbox,
      confidence,
    });
  }
  return items;
}

function parsePosition(position?: string): BBox | undefined {
  if (!position) return undefined;
  const parts = position.split(',').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [x1, y1, x2, y2] = parts as [number, number, number, number];
  if (x2 <= x1 || y2 <= y1) return undefined;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * OcrEngine backed by the existing PpuPaddleOcrProvider.
 *
 * The provider is injected (composition); callers are responsible for its
 * lifecycle (`load`/`unload`). `recognize` builds a minimal `InferenceRequest`
 * and parses the returned text into IR OCR items.
 */
export class PaddleOcrEngine implements OcrEngine {
  readonly name = 'paddle-ocr';

  constructor(private readonly provider: PpuPaddleOcrProvider) {}

  async recognize(image: ImageInput): Promise<VisionOcrItem[]> {
    const response = await this.provider.infer({
      image,
      prompt: '',
      maxTokens: 0,
      temperature: 0,
    });
    return parseOcrTextToItems(response.text);
  }
}
