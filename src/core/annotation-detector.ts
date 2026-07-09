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

export interface RedBoxAnnotation {
  box: string;
  confidence: number;
  insideText: string[];
  insideTextLines: string[];
  nearbyText: string[];
}

export interface ImageAnnotations {
  redBoxes: RedBoxAnnotation[];
}

export async function detectAnnotations(image: ImageInput, ocrData?: unknown): Promise<ImageAnnotations> {
  const { data, info } = await sharp(image.buffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const redMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      if (r > 160 && g < 120 && b < 120 && r - g > 50 && r - b > 50) {
        redMask[y * width + x] = 1;
      }
    }
  }

  const ocrItems = extractOcrItems(ocrData);
  const connectedMask = dilateMask(redMask, width, height, 8);
  const redBoxes = findRedComponents(connectedMask, width)
    .map((box) => refineBoxToOriginalRedPixels(box, redMask, width))
    .filter((box): box is Box => box !== undefined)
    .filter((box) => isLikelyRedAnnotation(box, redMask, width))
    .sort((a, b) => boxArea(b) - boxArea(a))
    .slice(0, 10)
    .map((box) => ({
      box: formatBox(box),
      confidence: scoreRedBox(box, redMask, width),
      insideText: textInsideBox(ocrItems, box),
      insideTextLines: textLinesInsideBox(ocrItems, box),
      nearbyText: textNearBox(ocrItems, box),
    }));

  return { redBoxes };
}

function refineBoxToOriginalRedPixels(box: Box, mask: Uint8Array, width: number): Box | undefined {
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

function findRedComponents(mask: Uint8Array, width: number): Box[] {
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

function isLikelyRedAnnotation(box: Box, mask: Uint8Array, width: number): boolean {
  const boxWidth = box.x2 - box.x1;
  const boxHeight = box.y2 - box.y1;
  if (boxWidth < 40 || boxHeight < 40) return false;
  const borderDensity = scoreRedBox(box, mask, width);
  return borderDensity >= 0.2;
}

function boxArea(box: Box): number {
  return (box.x2 - box.x1) * (box.y2 - box.y1);
}

function scoreRedBox(box: Box, mask: Uint8Array, width: number): number {
  let border = 0;
  let red = 0;
  for (let y = box.y1; y < box.y2; y++) {
    for (let x = box.x1; x < box.x2; x++) {
      const nearBorder = x - box.x1 < 4 || box.x2 - x <= 4 || y - box.y1 < 4 || box.y2 - y <= 4;
      if (!nearBorder) continue;
      border++;
      red += mask[y * width + x] ?? 0;
    }
  }
  return border > 0 ? Math.min(red / border, 0.99) : 0;
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
