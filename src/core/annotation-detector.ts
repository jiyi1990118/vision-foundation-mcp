import sharp from 'sharp';
import type { ImageInput } from '../types/domain.js';

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface OcrItem {
  text: string;
  box?: Box;
}

/** A single detected annotation box of any color. */
export interface ColoredBoxAnnotation {
  color: string;
  box: string;
  confidence: number;
  insideText: string[];
  insideTextLines: string[];
  nearbyText: string[];
}

export interface ImageAnnotations {
  /** All detected annotation boxes across all colors. */
  coloredBoxes?: ColoredBoxAnnotation[] | undefined;
  /** Red boxes only (backward-compatible). */
  redBoxes: ColoredBoxAnnotation[];
}

// ── Color presets ──────────────────────────────────────

interface ColorPreset {
  name: string;
  /** Aliases that the user might specify in options.target.color. */
  aliases: string[];
  /** Returns true if the pixel matches this color. */
  match: (r: number, g: number, b: number) => boolean;
}

const COLOR_PRESETS: ColorPreset[] = [
  {
    name: 'red',
    aliases: ['red', '红色', '红框', '红'],
    match: (r, g, b) => r > 160 && g < 120 && b < 120 && r - g > 50 && r - b > 50,
  },
  {
    name: 'blue',
    aliases: ['blue', '蓝色', '蓝框', '蓝'],
    match: (r, g, b) => b > 160 && r < 130 && g < 150 && b - r > 50 && b - g > 20,
  },
  {
    name: 'green',
    aliases: ['green', '绿色', '绿框', '绿'],
    match: (r, g, b) => g > 140 && r < 120 && b < 120 && g - r > 40 && g - b > 40,
  },
  {
    name: 'yellow',
    aliases: ['yellow', 'orange', '黄色', '橙色', '黄框', '橙框', '黄', '橙'],
    match: (r, g, b) => r > 200 && g > 150 && b < 110 && r - b > 80,
  },
  {
    name: 'magenta',
    aliases: ['magenta', 'pink', '紫色', '粉色', '紫框', '粉框', '紫', '粉', 'purple'],
    match: (r, g, b) => r > 170 && b > 140 && g < 120 && r - g > 50 && b - g > 30,
  },
];

/** Resolve a user-provided color name to a canonical preset name, or undefined. */
export function resolveColorName(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const lower = input.toLowerCase();
  return COLOR_PRESETS.find((p) => p.aliases.some((a) => a.toLowerCase() === lower))?.name;
}

export async function detectAnnotations(image: ImageInput, ocrData?: unknown): Promise<ImageAnnotations> {
  const { data, info } = await sharp(image.buffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;

  // Single-pass multi-color scan: check each pixel against all presets.
  const masks = new Map<string, Uint8Array>();
  for (const preset of COLOR_PRESETS) {
    masks.set(preset.name, new Uint8Array(width * height));
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      for (const preset of COLOR_PRESETS) {
        if (preset.match(r, g, b)) {
          masks.get(preset.name)![y * width + x] = 1;
          break; // A pixel belongs to at most one color
        }
      }
    }
  }

  const ocrItems = extractOcrItems(ocrData);
  const allBoxes: ColoredBoxAnnotation[] = [];

  for (const preset of COLOR_PRESETS) {
    const mask = masks.get(preset.name)!;
    // Skip if no pixels of this color at all.
    let hasPixels = false;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 1) { hasPixels = true; break; }
    }
    if (!hasPixels) continue;

    const connectedMask = dilateMask(mask, width, height, 8);
    const boxes = findConnectedComponents(connectedMask, width)
      .map((box) => refineBoxToOriginalPixels(box, mask, width))
      .filter((box): box is Box => box !== undefined)
      .flatMap((box) => splitAtHorizontalGaps(box, mask, width))
      .filter((box) => isLikelyAnnotation(box, mask, width))
      .sort((a, b) => boxArea(b) - boxArea(a))
      .slice(0, 10)
      .map((box) => {
        const stats = computeBoxStats(box, mask, width);
        return {
          color: preset.name,
          box: formatBox(box),
          confidence: annotationConfidence(stats),
          insideText: textInsideBox(ocrItems, box),
          insideTextLines: textLinesInsideBox(ocrItems, box),
          nearbyText: textNearBox(ocrItems, box),
        };
      });
    allBoxes.push(...boxes);
  }

  return {
    coloredBoxes: allBoxes,
    redBoxes: allBoxes.filter((b) => b.color === 'red'),
  };
}

function refineBoxToOriginalPixels(box: Box, mask: Uint8Array, width: number): Box | undefined {
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = Number.NEGATIVE_INFINITY;
  let y2 = Number.NEGATIVE_INFINITY;

  for (let y = box.y1; y < box.y2; y++) {
    for (let x = box.x1; x < box.x2; x++) {
      if (mask[y * width + x] !== 1) continue;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
    }
  }

  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
    return undefined;
  }
  return { x1, y1, x2: x2 + 1, y2: y2 + 1 };
}

/**
 * Split a detected region at horizontal gaps between dense border bands.
 *
 * When two annotation boxes share the same vertical sides (same x-range),
 * dilation merges them into one connected component.  We detect this by
 * scanning for "dense" rows (horizontal borders with many colored pixels)
 * and splitting between the 2nd and 3rd band — i.e. when we see 4+ border
 * bands (top1, bottom1, top2, bottom2), we know it's two stacked boxes.
 *
 * A single box has exactly 2 bands (top + bottom) and is never split.
 * A single box with an internal divider has 3 bands and is not split
 * (conservative: better to miss a split than to over-split).
 */
function splitAtHorizontalGaps(box: Box, mask: Uint8Array, width: number): Box[] {
  // Count ALL colored pixels per row (including border zones).
  const rowCounts: number[] = [];
  let maxRowCount = 0;
  for (let y = box.y1; y < box.y2; y++) {
    let count = 0;
    for (let x = box.x1; x < box.x2; x++) {
      if (mask[y * width + x] === 1) count++;
    }
    rowCounts.push(count);
    if (count > maxRowCount) maxRowCount = count;
  }

  if (maxRowCount === 0) return [box];

  // Find "dense" rows: rows with > 30% of the max colored pixel count.
  // These correspond to horizontal borders (top/bottom edges of boxes).
  const threshold = maxRowCount * 0.3;
  const bands: Array<{ start: number; end: number }> = [];
  let bandStart = -1;
  for (let i = 0; i < rowCounts.length; i++) {
    const rc = rowCounts[i] ?? 0;
    if (rc > threshold && bandStart < 0) bandStart = i;
    if (rc <= threshold && bandStart >= 0) {
      bands.push({ start: bandStart, end: i - 1 });
      bandStart = -1;
    }
  }
  if (bandStart >= 0) bands.push({ start: bandStart, end: rowCounts.length - 1 });

  // Need 4+ bands to split (2 per box). 3 bands (internal divider) = no split.
  if (bands.length < 4) return [box];

  // Split between band 1 (index 1, bottom of box 1) and band 2 (index 2, top of box 2).
  const band1End = bands[1]?.end;
  const band2Start = bands[2]?.start;
  if (band1End === undefined || band2Start === undefined) return [box];
  const gapStart = band1End;
  const gapEnd = band2Start;
  const splitY = box.y1 + Math.floor((gapStart + gapEnd) / 2) + 1;

  if (splitY <= box.y1 + 20 || splitY >= box.y2 - 20) return [box];

  const top: Box = { x1: box.x1, y1: box.y1, x2: box.x2, y2: splitY };
  const bottom: Box = { x1: box.x1, y1: splitY, x2: box.x2, y2: box.y2 };

  // Recurse in case there are more boxes stacked.
  return [
    ...splitAtHorizontalGaps(top, mask, width),
    ...splitAtHorizontalGaps(bottom, mask, width),
  ];
}

function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const dilated = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] !== 1) continue;
      const x1 = Math.max(0, x - radius);
      const x2 = Math.min(width - 1, x + radius);
      const y1 = Math.max(0, y - radius);
      const y2 = Math.min(height - 1, y + radius);
      for (let yy = y1; yy <= y2; yy++) {
        for (let xx = x1; xx <= x2; xx++) {
          dilated[yy * width + xx] = 1;
        }
      }
    }
  }
  return dilated;
}

function findConnectedComponents(mask: Uint8Array, width: number): Box[] {
  const visited = new Uint8Array(mask.length);
  const boxes: Box[] = [];
  const queue: number[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || visited[start] === 1) continue;
    visited[start] = 1;
    queue.length = 0;
    queue.push(start);
    let x1 = start % width;
    let x2 = x1;
    let y1 = Math.floor(start / width);
    let y2 = y1;

    for (let qi = 0; qi < queue.length; qi++) {
      const current = queue[qi]!;
      const x = current % width;
      const y = Math.floor(current / width);
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;

      for (const next of [current - 1, current + 1, current - width, current + width]) {
        if (next < 0 || next >= mask.length || visited[next] === 1 || mask[next] !== 1) continue;
        const nx = next % width;
        if (Math.abs(nx - x) > 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    boxes.push({ x1, y1, x2: x2 + 1, y2: y2 + 1 });
  }

  return boxes;
}

/** Statistics used to distinguish annotation outlines from filled UI elements. */
interface BoxStats {
  boxArea: number;
  coloredPixels: number;
  borderColored: number;
  interiorColored: number;
  /** Fraction of the box area that is colored (low = outline, high = fill). */
  fillRatio: number;
  /** Fraction of colored pixels on the border (high = outline, low = fill). */
  hollowRatio: number;
  /** Fraction of border-zone pixels that are colored. */
  borderDensity: number;
}

const BORDER_ZONE = 5;

function computeBoxStats(box: Box, mask: Uint8Array, width: number): BoxStats {
  let coloredPixels = 0;
  let borderColored = 0;
  let borderPixels = 0;
  let interiorColored = 0;

  for (let y = box.y1; y < box.y2; y++) {
    for (let x = box.x1; x < box.x2; x++) {
      const isBorder = x - box.x1 < BORDER_ZONE || box.x2 - x <= BORDER_ZONE
        || y - box.y1 < BORDER_ZONE || box.y2 - y <= BORDER_ZONE;
      const val = mask[y * width + x] ?? 0;
      if (val === 1) {
        coloredPixels++;
        if (isBorder) borderColored++;
        else interiorColored++;
      }
      if (isBorder) borderPixels++;
    }
  }

  const boxArea = (box.x2 - box.x1) * (box.y2 - box.y1);
  return {
    boxArea,
    coloredPixels,
    borderColored,
    interiorColored,
    fillRatio: boxArea > 0 ? coloredPixels / boxArea : 1,
    hollowRatio: coloredPixels > 0 ? borderColored / coloredPixels : 0,
    borderDensity: borderPixels > 0 ? borderColored / borderPixels : 0,
  };
}

/**
 * Determine whether a detected colored region is likely an annotation box
 * (outline) rather than a filled UI element (button, checkbox, selected
 * menu background).
 *
 * Heuristics:
 * - **Size**: Annotations are large enough to highlight content (≥ 80×60).
 *   Buttons, checkboxes, and pagination indicators are typically smaller.
 * - **Fill ratio**: Outlines have low fill (colored pixels / area < 0.25).
 *   Filled backgrounds have high fill (> 0.3).
 * - **Hollow ratio**: Outlines concentrate color on the border (> 0.5).
 *   Fills spread color throughout (< 0.3).
 * - **Border density**: At least some border pixels must be colored.
 */
function isLikelyAnnotation(box: Box, mask: Uint8Array, width: number): boolean {
  const boxWidth = box.x2 - box.x1;
  const boxHeight = box.y2 - box.y1;
  if (boxWidth < 80 || boxHeight < 60) return false;

  const stats = computeBoxStats(box, mask, width);

  // Must have some colored border pixels.
  if (stats.borderDensity < 0.12) return false;

  // Filled UI elements (buttons, backgrounds) have high fill ratio.
  // Annotation outlines have low fill ratio (only border is colored).
  if (stats.fillRatio > 0.25) return false;

  // Filled elements spread color throughout; outlines concentrate on border.
  if (stats.hollowRatio < 0.45) return false;

  return true;
}

/**
 * Confidence score based on how strongly the region resembles an annotation
 * outline: low fill ratio + high hollow ratio + good border density.
 */
function annotationConfidence(stats: BoxStats): number {
  const fillScore = Math.max(0, 1 - stats.fillRatio * 4); // 0 fill -> 1.0
  const hollowScore = stats.hollowRatio; // 1.0 = all color on border
  const densityScore = Math.min(stats.borderDensity / 0.5, 1);
  return Math.min(fillScore * 0.4 + hollowScore * 0.4 + densityScore * 0.2, 0.99);
}

function boxArea(box: Box): number {
  return (box.x2 - box.x1) * (box.y2 - box.y1);
}

function extractOcrItems(data: unknown): OcrItem[] {
  if (typeof data !== 'object' || data === null) return [];
  const texts = (data as { texts?: unknown }).texts;
  if (!Array.isArray(texts)) return [];
  return texts
    .map((item): OcrItem | undefined => {
      if (typeof item !== 'object' || item === null) return undefined;
      const text = (item as { text?: unknown }).text;
      const position = (item as { position?: unknown }).position;
      if (typeof text !== 'string') return undefined;
      const box = typeof position === 'string' ? parseBox(position) : undefined;
      return box ? { text, box } : { text };
    })
    .filter((item): item is OcrItem => item !== undefined && item.text.trim().length > 0);
}

function parseBox(position: string): Box | undefined {
  const parts = position.split(',').map((value) => Number(value.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return undefined;
  const [x1, y1, x2, y2] = parts as [number, number, number, number];
  return { x1, y1, x2, y2 };
}

function textInsideBox(items: OcrItem[], box: Box): string[] {
  return unique(items
    .filter((item) => item.box && isTextInsideAnnotation(item.box, box))
    .map((item) => item.text));
}

function textLinesInsideBox(items: OcrItem[], box: Box): string[] {
  return items
    .filter((item) => item.box && isTextInsideAnnotation(item.box, box))
    .sort((a, b) => {
      const ay = a.box ? (a.box.y1 + a.box.y2) / 2 : 0;
      const by = b.box ? (b.box.y1 + b.box.y2) / 2 : 0;
      if (Math.abs(ay - by) > 8) return ay - by;
      const ax = a.box ? (a.box.x1 + a.box.x2) / 2 : 0;
      const bx = b.box ? (b.box.x1 + b.box.x2) / 2 : 0;
      return ax - bx;
    })
    .map((item) => item.text);
}

function isTextInsideAnnotation(textBox: Box, annotationBox: Box): boolean {
  if (isInside(textBox, expandBox(annotationBox, 4))) return true;
  return overlapRatio(textBox, annotationBox) >= 0.35;
}

function textNearBox(items: OcrItem[], box: Box): string[] {
  const expanded = expandBox(box, 25);
  return unique(items
    .filter((item) => item.box && !isInside(item.box, box) && isInside(item.box, expanded))
    .map((item) => item.text));
}

function isInside(inner: Box, outer: Box): boolean {
  const cx = (inner.x1 + inner.x2) / 2;
  const cy = (inner.y1 + inner.y2) / 2;
  return cx >= outer.x1 && cx <= outer.x2 && cy >= outer.y1 && cy <= outer.y2;
}

function overlapRatio(a: Box, b: Box): number {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  if (x2 <= x1 || y2 <= y1) return 0;
  return ((x2 - x1) * (y2 - y1)) / boxArea(a);
}

function expandBox(box: Box, amount: number): Box {
  return { x1: box.x1 - amount, y1: box.y1 - amount, x2: box.x2 + amount, y2: box.y2 + amount };
}

function formatBox(box: Box): string {
  return `${box.x1},${box.y1},${box.x2},${box.y2}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
