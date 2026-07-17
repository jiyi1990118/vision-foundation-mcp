/**
 * Media-area solidity filter (Stream S31 - real-image validation finding).
 *
 * The legacy `detectMediaAreas` flags any 20x20 block whose edge density
 * exceeds a threshold as a "media area". On bordered UIs (cards with strokes,
 * headers, sidebars) this over-fires badly: card borders / corners produce
 * many edge-dense blocks that are NOT real icons. A validation run on a
 * card-list dashboard produced 19 spurious icons on an icon-free image.
 *
 * This filter keeps the legacy detector untouched and instead drops
 * non-solid media areas by sampling pixels: a real icon is a solid graphical
 * element whose interior dominant color differs from the surrounding
 * background; a border fragment's interior is just the parent background
 * (same color as the ring outside it) plus an edge line. We decode the source
 * image once and, per media area, compare the interior dominant color to the
 * outer-ring dominant color - dropping areas where they match (no icon body).
 *
 * Pure pixel sampling; no model; best-effort (fails open: a sampling error
 * keeps the area rather than silently dropping a real icon).
 *
 * @see src/core/extractors/ui-layout-extractor.ts  (detectMediaAreas source)
 * @see 方案/06-回归分析与待增强点.md  (G-C1 / real-image validation)
 */
import sharp from 'sharp';
import type { ImageInput } from '../../types/domain.js';
import type { MediaArea } from '../../core/extractors/ui-layout-extractor.js';

interface RGB {
  r: number;
  g: number;
  b: number;
}

const QUANT_SHIFT = 4;
const RING_BAND = 4;
const MIN_INTERIOR_DIFF = 30;
const MIN_SAMPLES = 8;

function rgbDistance(a: RGB, b: RGB): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function dominantColor(data: Buffer, x0: number, y0: number, x1: number, y1: number, width: number, stride: number): RGB | null {
  if (x1 <= x0 || y1 <= y0) return null;
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = (y * width + x) * stride;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      const key = `${r >> QUANT_SHIFT},${g >> QUANT_SHIFT},${b >> QUANT_SHIFT}`;
      let bk = buckets.get(key);
      if (bk === undefined) {
        bk = { count: 0, r: 0, g: 0, b: 0 };
        buckets.set(key, bk);
      }
      bk.count++;
      bk.r += r;
      bk.g += g;
      bk.b += b;
      total++;
    }
  }
  if (total < MIN_SAMPLES) return null;
  let best: { count: number; r: number; g: number; b: number } | undefined;
  for (const bk of buckets.values()) {
    if (best === undefined || bk.count > best.count) best = bk;
  }
  if (best === undefined) return null;
  return { r: Math.round(best.r / best.count), g: Math.round(best.g / best.count), b: Math.round(best.b / best.count) };
}

/**
 * Drop media areas whose interior dominant color matches the surrounding
 * background (i.e. no solid icon body - just a border / edge fragment).
 * Returns the filtered list; the input is not mutated.
 */
export async function filterSolidMediaAreas(image: ImageInput, areas: MediaArea[]): Promise<MediaArea[]> {
  if (areas.length === 0) return areas;
  const { data, info } = await sharp(image.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const stride = info.channels;

  const kept: MediaArea[] = [];
  for (const area of areas) {
    const b = area.bbox;
    const ix0 = Math.max(0, Math.floor(b.x + Math.min(b.w * 0.2, 6)));
    const iy0 = Math.max(0, Math.floor(b.y + Math.min(b.h * 0.2, 6)));
    const ix1 = Math.min(width, Math.ceil(b.x + b.w - Math.min(b.w * 0.2, 6)));
    const iy1 = Math.min(height, Math.ceil(b.y + b.h - Math.min(b.h * 0.2, 6)));
    const interior = dominantColor(data, ix0, iy0, ix1, iy1, width, stride);
    if (interior === null) {
      kept.push(area);
      continue;
    }
    const rx0 = Math.max(0, Math.floor(b.x) - RING_BAND);
    const ry0 = Math.max(0, Math.floor(b.y) - RING_BAND);
    const rx1 = Math.min(width, Math.ceil(b.x + b.w) + RING_BAND);
    const ry1 = Math.min(height, Math.ceil(b.y + b.h) + RING_BAND);
    const ring: RGB[] = [];
    for (let y = ry0; y < ry1; y++) {
      for (let x = rx0; x < rx1; x++) {
        if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) continue;
        const idx = (y * width + x) * stride;
        ring.push({ r: data[idx] ?? 0, g: data[idx + 1] ?? 0, b: data[idx + 2] ?? 0 });
      }
    }
    const ringBuckets = new Map<string, { count: number; r: number; g: number; b: number }>();
    for (const px of ring) {
      const key = `${px.r >> QUANT_SHIFT},${px.g >> QUANT_SHIFT},${px.b >> QUANT_SHIFT}`;
      let bk = ringBuckets.get(key);
      if (bk === undefined) {
        bk = { count: 0, r: 0, g: 0, b: 0 };
        ringBuckets.set(key, bk);
      }
      bk.count++;
      bk.r += px.r;
      bk.g += px.g;
      bk.b += px.b;
    }
    let bg: RGB | null = null;
    let bestCount = 0;
    for (const bk of ringBuckets.values()) {
      if (bk.count > bestCount) {
        bestCount = bk.count;
        bg = { r: Math.round(bk.r / bk.count), g: Math.round(bk.g / bk.count), b: Math.round(bk.b / bk.count) };
      }
    }
    if (bg === null) {
      kept.push(area);
      continue;
    }
    if (rgbDistance(interior, bg) >= MIN_INTERIOR_DIFF) {
      kept.push(area);
    }
  }
  return kept;
}
