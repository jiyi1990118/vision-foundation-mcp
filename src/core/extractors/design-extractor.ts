/**
 * Design Token Extractor - algorithmic color palette extraction using sharp.
 *
 * Extracts dominant colors via median-cut quantization, classifies them by
 * role (background / text / primary / accent / surface / border), and computes
 * luminance, dark-mode, and WCAG contrast ratio. No VLM call needed.
 *
 * @see src/core/extractors/ - sibling OCR/pixel-driven extractors
 */
import sharp from 'sharp';
import type { ImageInput } from '../../types/domain.js';

// ── Types ──

export interface DesignToken {
  hex: string;
  rgb: [number, number, number];
  role: 'background' | 'surface' | 'primary' | 'accent' | 'text' | 'border' | 'muted';
  frequency: number;
}

export interface DesignExtraction {
  palette: DesignToken[];
  background: string;
  primary: string;
  textColor: string;
  isDarkMode: boolean;
  contrastRatio: number;
  colorCount: number;
  summary: string;
}

// ── Color space helpers ──

interface RGB { r: number; g: number; b: number; }
interface HSL { h: number; s: number; l: number; }

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => v.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
    case gn: h = (bn - rn) / d + 2; break;
    default: h = (rn - gn) / d + 4; break;
  }
  return { h: h * 60, s, l };
}

/** Relative luminance per WCAG 2.x (0..1). */
function relativeLuminance({ r, g, b }: RGB): number {
  const ch = (c: number) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(c1: RGB, c2: RGB): number {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** CIE76 color difference (simplified, good enough for merging). */
function colorDistance(a: RGB, b: RGB): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg * 1.5 + db * db); // weight green more
}

// ── Median-cut quantization ──

interface ColorBucket {
  pixels: RGB[];
}

function medianCut(pixels: RGB[], maxColors: number): RGB[] {
  if (pixels.length === 0) return [];
  const buckets: ColorBucket[] = [{ pixels }];
  while (buckets.length < maxColors) {
    // Find the bucket with the greatest range in any channel.
    let bestIdx = -1;
    let bestRange = -1;
    let bestChannel: 'r' | 'g' | 'b' = 'r';
    for (let i = 0; i < buckets.length; i++) {
      const px = buckets[i]!.pixels;
      if (px.length < 2) continue;
      const ranges = channelRanges(px);
      const maxR = Math.max(ranges.r, ranges.g, ranges.b);
      if (maxR > bestRange) {
        bestRange = maxR;
        bestIdx = i;
        bestChannel = maxR === ranges.r ? 'r' : maxR === ranges.g ? 'g' : 'b';
      }
    }
    if (bestIdx === -1 || bestRange === 0) break;
    const bucket = buckets[bestIdx]!;
    const sorted = [...bucket.pixels].sort((a, b) => a[bestChannel] - b[bestChannel]);
    const mid = Math.floor(sorted.length / 2);
    buckets.splice(bestIdx, 1);
    buckets.push({ pixels: sorted.slice(0, mid) });
    buckets.push({ pixels: sorted.slice(mid) });
  }
  return buckets.map((b) => averageColor(b.pixels));
}

function channelRanges(pixels: RGB[]): { r: number; g: number; b: number } {
  let rMin = 255, gMin = 255, bMin = 255;
  let rMax = 0, gMax = 0, bMax = 0;
  for (const p of pixels) {
    rMin = Math.min(rMin, p.r); rMax = Math.max(rMax, p.r);
    gMin = Math.min(gMin, p.g); gMax = Math.max(gMax, p.g);
    bMin = Math.min(bMin, p.b); bMax = Math.max(bMax, p.b);
  }
  return { r: rMax - rMin, g: gMax - gMin, b: bMax - bMin };
}

function averageColor(pixels: RGB[]): RGB {
  if (pixels.length === 0) return { r: 0, g: 0, b: 0 };
  let r = 0, g = 0, b = 0;
  for (const p of pixels) { r += p.r; g += p.g; b += p.b; }
  const n = pixels.length;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

// ── Role classification ──

type Role = DesignToken['role'];

function classifyRole(hsl: HSL, freq: number, totalPixels: number, isBg: boolean): Role {
  const { s, l } = hsl;
  const pct = freq / totalPixels;

  // Background: the most frequent color, typically low-saturation.
  if (isBg) {
    if (l > 0.9) return 'background';
    if (l < 0.15) return 'background';
    return 'background';
  }

  // Near-white / near-black low-saturation non-bg: surface or muted.
  if (s < 0.08) {
    if (l < 0.25) return 'text';
    if (l > 0.85) return 'surface';
    if (pct < 0.03) return 'border';
    return 'muted';
  }

  // Saturated colors:
  if (s > 0.5 && pct < 0.05) return 'accent';
  if (s > 0.25) return 'primary';
  return 'muted';
}

// ── Main extraction ──

const THUMBNAIL_SIZE = 100;
const MAX_COLORS = 16;
const MERGE_THRESHOLD = 25; // color distance below which colors are merged

/**
 * Extract design tokens (color palette + roles) from an image.
 *
 * Uses sharp to downscale the image, then median-cut quantization to find
 * dominant colors. Each color is classified into a semantic role. Finally
 * computes luminance, dark-mode, and WCAG contrast ratio.
 */
export async function extractDesignTokens(image: ImageInput): Promise<DesignExtraction> {
  // Downscale for performance - we only need color statistics, not detail.
  const { data, info } = await sharp(image.buffer)
    .removeAlpha()
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels: RGB[] = [];
  const stride = info.channels;
  for (let i = 0; i < data.length; i += stride) {
    pixels.push({
      r: data[i]!,
      g: data[i + 1]!,
      b: data[i + 2]!,
    });
  }

  const totalPixels = pixels.length;

  // Quantize to ~16 representative colors.
  const quantized = medianCut(pixels, MAX_COLORS);

  // Count frequency of each quantized color.
  const colorCounts = new Map<string, { color: RGB; count: number }>();
  for (const q of quantized) {
    const key = `${q.r},${q.g},${q.b}`;
    const existing = colorCounts.get(key);
    if (existing) {
      existing.count++;
    } else {
      colorCounts.set(key, { color: q, count: 0 });
    }
  }

  // Count actual pixel assignments (each pixel -> nearest quantized color).
  const countMap = new Map<string, number>();
  for (const p of pixels) {
    let nearest = quantized[0]!;
    let minDist = Infinity;
    for (const q of quantized) {
      const d = colorDistance(p, q);
      if (d < minDist) { minDist = d; nearest = q; }
    }
    const key = `${nearest.r},${nearest.g},${nearest.b}`;
    countMap.set(key, (countMap.get(key) ?? 0) + 1);
  }

  // Build raw palette entries sorted by frequency.
  type Entry = { color: RGB; count: number; hsl: HSL };
  const entries: Entry[] = [];
  for (const [key, count] of countMap) {
    const color = quantized.find((q) => `${q.r},${q.g},${q.b}` === key) ?? quantized[0]!;
    entries.push({ color, count, hsl: rgbToHsl(color) });
  }
  entries.sort((a, b) => b.count - a.count);

  // Merge near-duplicate colors.
  const merged: Entry[] = [];
  for (const e of entries) {
    const similar = merged.find((m) => colorDistance(m.color, e.color) < MERGE_THRESHOLD);
    if (similar) {
      similar.count += e.count;
    } else {
      merged.push({ ...e });
    }
  }
  merged.sort((a, b) => b.count - a.count);

  // Classify roles. The most frequent color is background.
  const palette: DesignToken[] = merged.map((e, idx) => {
    const role = classifyRole(e.hsl, e.count, totalPixels, idx === 0);
    return {
      hex: rgbToHex(e.color.r, e.color.g, e.color.b),
      rgb: [e.color.r, e.color.g, e.color.b],
      role,
      frequency: round(e.count / totalPixels, 4),
    };
  });

  // Derive key colors from the palette.
  const background = palette.find((p) => p.role === 'background') ?? palette[0]!;
  const textColor = palette.find((p) => p.role === 'text')
    ?? palette.find((p) => rgbToHsl({ r: p.rgb[0]!, g: p.rgb[1]!, b: p.rgb[2]! }).l < 0.25)
    ?? palette[palette.length - 1]!;
  const primary = palette.find((p) => p.role === 'primary')
    ?? palette.find((p) => {
      const h = rgbToHsl({ r: p.rgb[0]!, g: p.rgb[1]!, b: p.rgb[2]! });
      return h.s > 0.25;
    })
    ?? palette[0]!;

  const bgRgb: RGB = { r: background.rgb[0]!, g: background.rgb[1]!, b: background.rgb[2]! };
  const textRgb: RGB = { r: textColor.rgb[0]!, g: textColor.rgb[1]!, b: textColor.rgb[2]! };
  const bgLuminance = relativeLuminance(bgRgb);
  const isDarkMode = bgLuminance < 0.2;
  const cr = contrastRatio(textRgb, bgRgb);

  const summary = buildSummary(palette, isDarkMode, cr);

  return {
    palette: palette.slice(0, 10),
    background: background.hex,
    primary: primary.hex,
    textColor: textColor.hex,
    isDarkMode,
    contrastRatio: round(cr, 2),
    colorCount: palette.length,
    summary,
  };
}

function buildSummary(palette: DesignToken[], isDarkMode: boolean, contrast: number): string {
  const parts: string[] = [];
  parts.push(isDarkMode ? '深色模式' : '浅色模式');
  const roles = [...new Set(palette.map((p) => p.role))];
  parts.push(`${palette.length} 色配色方案（${roles.join('/')}）`);
  if (contrast >= 7) parts.push('对比度优秀（WCAG AAA）');
  else if (contrast >= 4.5) parts.push('对比度达标（WCAG AA）');
  else parts.push('对比度不足');
  return parts.join('，');
}

function round(n: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}
