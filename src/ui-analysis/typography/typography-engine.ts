/**
 * Typography Engine - infers a font-size scale and weight set from OCR text
 * bbox heights. Clusters heights relative to the median into title / heading /
 * body / caption levels. Pure, deterministic, no IO, no model.
 *
 * Font weight cannot be inferred from a bbox alone, so weights default to
 * 'regular' when any text is present.
 *
 * @see src/ui-analysis/ir/types.ts
 */
import type { VisionOcrItem } from '../ir/types.js';

export interface TypographyResult {
  scale: Array<{ level: string; sizePx: number; count: number }>;
  weights: string[];
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

const LEVEL_ORDER = ['title', 'heading', 'body', 'caption'] as const;
type Level = (typeof LEVEL_ORDER)[number];

const TITLE_RATIO = 1.6;
const HEADING_RATIO = 1.2;
const CAPTION_RATIO = 0.8;

function classify(h: number, med: number): Level {
  if (med > 0 && h > med * TITLE_RATIO) return 'title';
  if (med > 0 && h > med * HEADING_RATIO) return 'heading';
  if (med > 0 && h < med * CAPTION_RATIO) return 'caption';
  return 'body';
}

/**
 * Infer a typography scale from OCR items. Heights are bucketed relative to
 * their median; each present level yields one entry with its representative
 * size (median height of the bucket, rounded) and item count. Levels with no
 * items are omitted. Returns an empty scale and no weights for empty input.
 */
export function inferTypography(ocr: VisionOcrItem[]): TypographyResult {
  if (ocr.length === 0) {
    return { scale: [], weights: [] };
  }

  const heights = ocr.map((o) => o.bbox.h);
  const med = median(heights);

  const buckets: Record<Level, number[]> = { title: [], heading: [], body: [], caption: [] };
  for (const h of heights) {
    buckets[classify(h, med)].push(h);
  }

  const scale: Array<{ level: string; sizePx: number; count: number }> = [];
  for (const lvl of LEVEL_ORDER) {
    const hs = buckets[lvl];
    if (hs.length > 0) {
      scale.push({ level: lvl, sizePx: Math.round(median(hs)), count: hs.length });
    }
  }

  return { scale, weights: ['regular'] };
}
