/**
 * Style Extractor (Stream S11 + S18) - per-component visual style sampling.
 *
 * Walks the SemanticAST and, for each node, samples the raw pixel buffer
 * (via a single sharp decode of the source image) within the node's bbox to
 * derive a {@link NodeStyle}: background dominant color, border color (only
 * when distinct from the background), and - for text-bearing nodes - text
 * color, font size (approximated by the bbox height), and a heuristic font
 * weight derived from dark-pixel density.
 *
 * Pure pixel sampling + simple RGB quantization (per-channel 16-level
 * bucketing). No model, no new IO beyond the one sharp decode. Additive to
 * the IR: it only reads {@link SemanticAST}/{@link ASTNode}/{@link BBox} and
 * emits a `Map<nodeId, NodeStyle>`.
 *
 * Stream S18 extends the sampler with two best-effort visual heuristics that
 * reuse the same decoded raw buffer: `borderRadius` (corner-cutout ratio
 * scan) and `boxShadow` (outer-ring dark-band scan). Both are omitted when
 * the signal is absent.
 *
 * @see src/ui-analysis/ir/types.ts                       (NodeStyle contract)
 * @see src/core/extractors/design-extractor.ts           (sharp raw-buffer pattern)
 * @see src/core/annotation-detector.ts                   (resolveWithObject scan)
 */
import sharp from 'sharp';
import type { ImageInput } from '../../types/domain.js';
import type { SemanticAST, ASTNode, NodeStyle, BBox } from '../ir/types.js';

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface Bucket {
  count: number;
  sumR: number;
  sumG: number;
  sumB: number;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const BORDER_INSET_RATIO = 0.1;
const BORDER_BAND = 2;
const BORDER_COLOR_THRESHOLD = 40;
const MIN_SAMPLE_AREA = 16;
const DARK_LUMINANCE = 96;
const BOLD_DENSITY = 0.4;
const QUANT_SHIFT = 4;

const CORNER_SAMPLE_SIZE = 32;
const CORNER_NON_FILL_THRESHOLD = 12;
const CORNER_PAGE_NEAR_THRESHOLD = 60;
const CORNER_MIN_RADIUS = 2;
const SHADOW_RING_BAND = 3;
const SHADOW_LUM_DIFF = 25;
const SHADOW_MIN_PIXELS = 8;
const SHADOW_MIN_RATIO = 0.06;
const SHADOW_ALPHA = 0.2;

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => v.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function luminance(rgb: RGB): number {
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
}

function rgbDistance(a: RGB, b: RGB): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function bucketAverage(bk: Bucket): RGB {
  return {
    r: Math.round(bk.sumR / bk.count),
    g: Math.round(bk.sumG / bk.count),
    b: Math.round(bk.sumB / bk.count),
  };
}

function* walkNodes(node: ASTNode): IterableIterator<ASTNode> {
  yield node;
  for (const child of node.children) yield* walkNodes(child);
}

function clipRect(bbox: BBox, width: number, height: number): Rect | null {
  const x0 = Math.max(0, Math.floor(bbox.x));
  const y0 = Math.max(0, Math.floor(bbox.y));
  const x1 = Math.min(width, Math.ceil(bbox.x + bbox.w));
  const y1 = Math.min(height, Math.ceil(bbox.y + bbox.h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

function accumulate(buckets: Map<string, Bucket>, data: Buffer, x: number, y: number, width: number, stride: number): void {
  const idx = (y * width + x) * stride;
  const r = data[idx] ?? 0;
  const g = data[idx + 1] ?? 0;
  const b = data[idx + 2] ?? 0;
  const key = `${r >> QUANT_SHIFT},${g >> QUANT_SHIFT},${b >> QUANT_SHIFT}`;
  let bk = buckets.get(key);
  if (bk === undefined) {
    bk = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
    buckets.set(key, bk);
  }
  bk.count++;
  bk.sumR += r;
  bk.sumG += g;
  bk.sumB += b;
}

function dominantColor(data: Buffer, rect: Rect, width: number, stride: number): RGB | null {
  const buckets = new Map<string, Bucket>();
  let total = 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      accumulate(buckets, data, x, y, width, stride);
      total++;
    }
  }
  if (total === 0) return null;
  let best: Bucket | undefined;
  for (const bk of buckets.values()) {
    if (best === undefined || bk.count > best.count) best = bk;
  }
  return best === undefined ? null : bucketAverage(best);
}

function dominantEdgeColor(data: Buffer, rect: Rect, width: number, stride: number): RGB | null {
  const buckets = new Map<string, Bucket>();
  const topEnd = Math.min(rect.y0 + BORDER_BAND, rect.y1);
  const botStart = Math.max(rect.y1 - BORDER_BAND, rect.y0);
  const leftEnd = Math.min(rect.x0 + BORDER_BAND, rect.x1);
  const rightStart = Math.max(rect.x1 - BORDER_BAND, rect.x0);
  for (let y = rect.y0; y < topEnd; y++) {
    for (let x = rect.x0; x < rect.x1; x++) accumulate(buckets, data, x, y, width, stride);
  }
  for (let y = botStart; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) accumulate(buckets, data, x, y, width, stride);
  }
  for (let x = rect.x0; x < leftEnd; x++) {
    for (let y = topEnd; y < botStart; y++) accumulate(buckets, data, x, y, width, stride);
  }
  for (let x = rightStart; x < rect.x1; x++) {
    for (let y = topEnd; y < botStart; y++) accumulate(buckets, data, x, y, width, stride);
  }
  let best: Bucket | undefined;
  for (const bk of buckets.values()) {
    if (best === undefined || bk.count > best.count) best = bk;
  }
  return best === undefined ? null : bucketAverage(best);
}

function darkestSignificantColor(data: Buffer, rect: Rect, width: number, stride: number): RGB | null {
  const buckets = new Map<string, Bucket>();
  let total = 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      accumulate(buckets, data, x, y, width, stride);
      total++;
    }
  }
  if (total === 0) return null;
  const minCount = Math.max(2, Math.floor(total * 0.02));
  let best: Bucket | undefined;
  let bestLum = Infinity;
  for (const bk of buckets.values()) {
    if (bk.count < minCount) continue;
    const lum = luminance(bucketAverage(bk));
    if (lum < bestLum) {
      bestLum = lum;
      best = bk;
    }
  }
  if (best === undefined) {
    for (const bk of buckets.values()) {
      const lum = luminance(bucketAverage(bk));
      if (lum < bestLum) {
        bestLum = lum;
        best = bk;
      }
    }
  }
  return best === undefined ? null : bucketAverage(best);
}

function darkPixelDensity(data: Buffer, rect: Rect, width: number, stride: number): number {
  let dark = 0;
  let total = 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const idx = (y * width + x) * stride;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      if (luminance({ r, g, b }) < DARK_LUMINANCE) dark++;
      total++;
    }
  }
  return total > 0 ? dark / total : 0;
}

interface CornerEdges {
  originX: number;
  originY: number;
  step1X: number;
  step1Y: number;
  step2X: number;
  step2Y: number;
}

interface OuterRing {
  pageBg: RGB | null;
  ring: RGB[];
}

function buildCornerEdges(rect: Rect): CornerEdges[] {
  const x0 = rect.x0;
  const y0 = rect.y0;
  const x1 = rect.x1;
  const y1 = rect.y1;
  return [
    { originX: x0, originY: y0, step1X: 1, step1Y: 0, step2X: 0, step2Y: 1 },
    { originX: x1 - 1, originY: y0, step1X: -1, step1Y: 0, step2X: 0, step2Y: 1 },
    { originX: x0, originY: y1 - 1, step1X: 1, step1Y: 0, step2X: 0, step2Y: -1 },
    { originX: x1 - 1, originY: y1 - 1, step1X: -1, step1Y: 0, step2X: 0, step2Y: -1 },
  ];
}

function readPixel(data: Buffer, x: number, y: number, width: number, stride: number): RGB {
  const idx = (y * width + x) * stride;
  return { r: data[idx] ?? 0, g: data[idx + 1] ?? 0, b: data[idx + 2] ?? 0 };
}

function scanEdgeLength(
  data: Buffer,
  originX: number,
  originY: number,
  stepX: number,
  stepY: number,
  maxLen: number,
  pageBg: RGB,
  width: number,
  stride: number,
): number {
  let count = 0;
  for (let k = 0; k < maxLen; k++) {
    const px = readPixel(data, originX + stepX * k, originY + stepY * k, width, stride);
    if (rgbDistance(px, pageBg) > CORNER_NON_FILL_THRESHOLD) break;
    count++;
  }
  return count;
}

function collectOuterRing(
  data: Buffer,
  rect: Rect,
  width: number,
  height: number,
  stride: number,
): OuterRing {
  const band = SHADOW_RING_BAND;
  const rx0 = Math.max(0, rect.x0 - band);
  const ry0 = Math.max(0, rect.y0 - band);
  const rx1 = Math.min(width, rect.x1 + band);
  const ry1 = Math.min(height, rect.y1 + band);
  const ring: RGB[] = [];
  const buckets = new Map<string, Bucket>();
  if (rx1 > rx0 && ry1 > ry0) {
    for (let y = ry0; y < ry1; y++) {
      for (let x = rx0; x < rx1; x++) {
        if (x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1) continue;
        const idx = (y * width + x) * stride;
        const r = data[idx] ?? 0;
        const g = data[idx + 1] ?? 0;
        const b = data[idx + 2] ?? 0;
        ring.push({ r, g, b });
        const key = `${r >> QUANT_SHIFT},${g >> QUANT_SHIFT},${b >> QUANT_SHIFT}`;
        let bk = buckets.get(key);
        if (bk === undefined) {
          bk = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
          buckets.set(key, bk);
        }
        bk.count++;
        bk.sumR += r;
        bk.sumG += g;
        bk.sumB += b;
      }
    }
  }
  let best: Bucket | undefined;
  for (const bk of buckets.values()) {
    if (best === undefined || bk.count > best.count) best = bk;
  }
  return { pageBg: best === undefined ? null : bucketAverage(best), ring };
}

function estimateBorderRadius(
  data: Buffer,
  rect: Rect,
  pageBg: RGB | null,
  width: number,
  stride: number,
): number {
  if (pageBg === null) return 0;
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  if (w < 2 || h < 2) return 0;
  const sampleSize = Math.min(w, h, CORNER_SAMPLE_SIZE);
  if (sampleSize < 2) return 0;
  const cap = Math.floor(Math.min(w, h) / 2);
  const edges = buildCornerEdges(rect);
  let maxRadius = 0;
  for (const e of edges) {
    const cornerPx = readPixel(data, e.originX, e.originY, width, stride);
    if (rgbDistance(cornerPx, pageBg) >= CORNER_PAGE_NEAR_THRESHOLD) continue;
    const scan1 = scanEdgeLength(data, e.originX, e.originY, e.step1X, e.step1Y, sampleSize, pageBg, width, stride);
    const scan2 = scanEdgeLength(data, e.originX, e.originY, e.step2X, e.step2Y, sampleSize, pageBg, width, stride);
    if (scan1 >= sampleSize || scan2 >= sampleSize) continue;
    const radius = scan1 < scan2 ? scan1 : scan2;
    if (radius > maxRadius) maxRadius = radius;
  }
  if (maxRadius < CORNER_MIN_RADIUS) return 0;
  return maxRadius > cap ? cap : maxRadius;
}

function detectBoxShadow(pageBg: RGB | null, ring: RGB[]): string | null {
  if (pageBg === null) return null;
  if (ring.length < SHADOW_MIN_PIXELS * 4) return null;
  const pageLum = luminance(pageBg);
  let shadowCount = 0;
  let darkestLum = Infinity;
  let darkest: RGB | null = null;
  for (const px of ring) {
    const lum = luminance(px);
    if (pageLum - lum > SHADOW_LUM_DIFF) {
      shadowCount++;
      if (lum < darkestLum) {
        darkestLum = lum;
        darkest = px;
      }
    }
  }
  if (darkest === null) return null;
  const ratio = shadowCount / ring.length;
  if (shadowCount < SHADOW_MIN_PIXELS || ratio < SHADOW_MIN_RATIO) return null;
  return `0 2px 8px rgba(${darkest.r},${darkest.g},${darkest.b},${SHADOW_ALPHA})`;
}

function sampleNodeStyle(node: ASTNode, data: Buffer, width: number, height: number, stride: number): NodeStyle | null {
  const rect = clipRect(node.bbox, width, height);
  if (rect === null) return null;
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const area = w * h;
  if (area < 1) return null;

  const insetX = Math.max(1, Math.floor(w * BORDER_INSET_RATIO));
  const insetY = Math.max(1, Math.floor(h * BORDER_INSET_RATIO));
  const inner: Rect =
    w - 2 * insetX > 0 && h - 2 * insetY > 0
      ? { x0: rect.x0 + insetX, y0: rect.y0 + insetY, x1: rect.x1 - insetX, y1: rect.y1 - insetY }
      : rect;

  const bg = dominantColor(data, inner, width, stride);
  if (bg === null) return null;

  if (area < MIN_SAMPLE_AREA) {
    return { backgroundColor: rgbToHex(bg.r, bg.g, bg.b) };
  }

  const style: NodeStyle = { backgroundColor: rgbToHex(bg.r, bg.g, bg.b) };

  const edge = dominantEdgeColor(data, rect, width, stride);
  if (edge !== null && rgbDistance(edge, bg) > BORDER_COLOR_THRESHOLD) {
    style.borderColor = rgbToHex(edge.r, edge.g, edge.b);
  }

  const outerRing = collectOuterRing(data, rect, width, height, stride);
  const radius = estimateBorderRadius(data, rect, outerRing.pageBg, width, stride);
  if (radius > 0) style.borderRadius = radius;

  const shadow = detectBoxShadow(outerRing.pageBg, outerRing.ring);
  if (shadow !== null) style.boxShadow = shadow;

  const isText = node.text !== undefined || node.type === 'text';
  if (isText) {
    const txt = darkestSignificantColor(data, rect, width, stride);
    if (txt !== null) {
      style.textColor = rgbToHex(txt.r, txt.g, txt.b);
    }
    style.fontSize = Math.round(node.bbox.h);
    const density = darkPixelDensity(data, rect, width, stride);
    style.fontWeight = density > BOLD_DENSITY ? 700 : 400;
  }

  return style;
}

/**
 * Sample a {@link NodeStyle} for every node in the {@link SemanticAST} by
 * reading the source image pixels within each node's bbox. Returns a map
 * keyed by `node.id` containing only the nodes whose bbox could be sampled.
 *
 * The source image is decoded exactly once via
 * `sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true })`,
 * then every node is sampled against that single pixel buffer.
 */
export async function extractNodeStyles(image: ImageInput, ast: SemanticAST): Promise<Map<string, NodeStyle>> {
  const { data, info } = await sharp(image.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const stride = info.channels;

  const result = new Map<string, NodeStyle>();
  for (const node of walkNodes(ast.root)) {
    const style = sampleNodeStyle(node, data, width, height, stride);
    if (style !== null) result.set(node.id, style);
  }
  return result;
}

/**
 * Walk the {@link SemanticAST} and attach each sampled {@link NodeStyle}
 * onto the matching node's `props.style` (in place). Nodes without a
 * sampled style are left untouched. Used by the integration layer to fold
 * per-component visual style back into the AST emitted to downstream agents.
 */
export function injectNodeStyles(ast: SemanticAST, styles: Map<string, NodeStyle>): void {
  const walk = (node: ASTNode): void => {
    const s = styles.get(node.id);
    if (s) node.props.style = s;
    for (const c of node.children) walk(c);
  };
  walk(ast.root);
}
