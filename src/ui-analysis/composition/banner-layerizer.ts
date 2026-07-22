import type { BBox, DecodedImage } from '../ir/types.js';

export interface BannerLayerInfo {
  backgroundType: 'solid' | 'gradient' | 'image' | 'unknown';
  separable: boolean;
  renderMode: 'hybrid' | 'asset';
  backgroundColor?: string;
}

const LAYER_MIN_SIZE = 20;
const SOLID_COLOR_THRESHOLD = 25;
const GRADIENT_COLOR_THRESHOLD = 30;
const IMAGE_VARIANCE_THRESHOLD = 50;
const BORDER_MARGIN_RATIO = 0.2;

interface RGB { r: number; g: number; b: number; }

function readPixel(img: DecodedImage, x: number, y: number): RGB {
  const idx = (y * img.width + x) * img.stride;
  return {
    r: img.data[idx] ?? 0,
    g: img.data[idx + 1] ?? 0,
    b: img.data[idx + 2] ?? 0,
  };
}

function rgbDistance(a: RGB, b: RGB): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => v.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function averageColor(pixels: RGB[]): RGB {
  let r = 0, g = 0, b = 0;
  for (const px of pixels) { r += px.r; g += px.g; b += px.b; }
  const n = pixels.length;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

function averageVariance(pixels: RGB[], avg: RGB): number {
  if (pixels.length === 0) return 0;
  let total = 0;
  for (const px of pixels) total += rgbDistance(px, avg);
  return total / pixels.length;
}

/**
 * Sample a full grid over `[x0,x1) x [y0,y1)` with the given step. Used for
 * narrow horizontal bands (top/bottom edges) where no content avoidance is
 * needed.
 */
function sampleGrid(x0: number, y0: number, x1: number, y1: number, step: number): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      points.push([x, y]);
    }
  }
  return points;
}

/**
 * Sample the border ring of the bbox, avoiding the center text/content area.
 * Captures top/bottom/left/right strips of width `margin` so foreground
 * content (titles, CTAs) in the middle does not pollute background stats.
 */
function sampleBorder(
  x0: number, y0: number, x1: number, y1: number,
  margin: number, step: number,
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  const topEnd = Math.min(y0 + margin, y1);
  const botStart = Math.max(y1 - margin, topEnd);
  const leftEnd = Math.min(x0 + margin, x1);
  const rightStart = Math.max(x1 - margin, leftEnd);

  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const inTop = y < topEnd;
      const inBottom = y >= botStart;
      const inLeft = x < leftEnd;
      const inRight = x >= rightStart;
      if (inTop || inBottom || inLeft || inRight) {
        points.push([x, y]);
      }
    }
  }
  return points;
}

export function layerizeBanner(img: DecodedImage, bbox: BBox): BannerLayerInfo {
  const x0 = Math.max(0, Math.floor(bbox.x));
  const y0 = Math.max(0, Math.floor(bbox.y));
  const x1 = Math.min(img.width, Math.ceil(bbox.x + bbox.w));
  const y1 = Math.min(img.height, Math.ceil(bbox.y + bbox.h));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < LAYER_MIN_SIZE || h < LAYER_MIN_SIZE) {
    return { backgroundType: 'unknown', separable: false, renderMode: 'asset' };
  }

  const step = Math.max(2, Math.floor(Math.min(w, h) / 20));
  const margin = Math.max(step, Math.floor(Math.min(w, h) * BORDER_MARGIN_RATIO));
  const bgPoints = sampleBorder(x0, y0, x1, y1, margin, step);
  const bgPixels = bgPoints.map(([px, py]) => readPixel(img, px, py));

  if (bgPixels.length === 0) {
    return { backgroundType: 'unknown', separable: false, renderMode: 'asset' };
  }

  const avgColor = averageColor(bgPixels);
  const avgVar = averageVariance(bgPixels, avgColor);

  if (avgVar < SOLID_COLOR_THRESHOLD) {
    return {
      backgroundType: 'solid',
      separable: true,
      renderMode: 'hybrid',
      backgroundColor: rgbToHex(avgColor.r, avgColor.g, avgColor.b),
    };
  }

  const bandStep = Math.max(1, step);
  const bandH = Math.max(2, margin);
  const topBand = sampleGrid(x0, y0, x1, Math.min(y0 + bandH, y1), bandStep)
    .map(([px, py]) => readPixel(img, px, py));
  const botBand = sampleGrid(x0, Math.max(y1 - bandH, y0), x1, y1, bandStep)
    .map(([px, py]) => readPixel(img, px, py));

  const topAvg = averageColor(topBand.length > 0 ? topBand : bgPixels);
  const botAvg = averageColor(botBand.length > 0 ? botBand : bgPixels);
  const topBotDiff = rgbDistance(topAvg, botAvg);

  if (topBotDiff >= GRADIENT_COLOR_THRESHOLD && avgVar < IMAGE_VARIANCE_THRESHOLD * 3) {
    return {
      backgroundType: 'gradient',
      separable: true,
      renderMode: 'hybrid',
    };
  }

  return {
    backgroundType: 'image',
    separable: false,
    renderMode: 'asset',
  };
}
