/**
 * Overlay Detector (Stream S25, G-C1) - best-effort modal overlay (dialog /
 * drawer / bottomSheet) detection + z-index modeling on a built
 * SemanticAST. These three ComponentType values are declared in the IR but
 * never emitted by ast-builder, so modal popups were previously modeled as
 * ordinary flat child nodes. This post-pass reuses the style-extractor
 * raw-buffer pattern (single sharp decode) to scan the source image for a
 * large uniform dim mask and applies geometric edge-hugging heuristics for
 * drawer / bottomSheet, then folds the result back onto the AST via
 * {@link applyOverlays}.
 *
 * Best-effort, same caveat class as boxShadow: a failure degrades to "no
 * overlay" rather than throwing. Geometry (drawer / bottomSheet) needs no
 * image; dialog needs an image to detect the dim mask plus a brighter
 * centered card on top. Without an image or without a detected mask, dialog
 * is skipped (a plain centered card is never misreported as a dialog).
 *
 * Limitation: the mask is detected by sampling the page corners as the
 * unmasked page background and/or by an absolute dim-luminance floor. A
 * full-bleed semi-transparent mask over a dark-mode page may still be
 * ambiguous; dialog is only reported when a clearly brighter centered card
 * sits on top of the dim region.
 *
 * @see ../style/style-extractor.js  (sharp raw-buffer + luminance pattern)
 * @see ../ir/types.js               (ComponentType: dialog/drawer/bottomSheet)
 * @see ../orchestrator.js           (invocation site, after type enrichment)
 */
import sharp from 'sharp';
import type { ImageInput } from '../../types/domain.js';
import type { SemanticAST, ASTNode, BBox } from '../ir/types.js';

export interface OverlayInfo {
  nodeId: string;
  overlayType: 'dialog' | 'drawer' | 'bottomSheet';
  zIndex: number;
  mask?: BBox;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const DIALOG_Z = 1000;
const DRAWER_Z = 1000;
const BOTTOM_SHEET_Z = 1000;

const EDGE_RATIO = 0.05;
const DRAWER_MIN_HEIGHT_RATIO = 0.6;
const DRAWER_MAX_WIDTH_RATIO = 0.8;
const BOTTOM_SHEET_MIN_WIDTH_RATIO = 0.6;
const BOTTOM_SHEET_MAX_HEIGHT_RATIO = 0.7;

const MASK_LUM_DIFF = 30;
const MASK_ABSOLUTE_LUM = 96;
const MASK_MAX_VARIANCE = 400;
const MASK_GRID = 8;
const MASK_MIN_COVERAGE = 0.5;
const DIALOG_CARD_BRIGHTNESS_DIFF = 40;
const DIALOG_CENTER_TOLERANCE = 0.25;
const CORNER_SAMPLE = 6;

const OVERLAY_CONTAINER_TYPES: ReadonlySet<string> = new Set([
  'card',
  'container',
  'section',
  'unknown',
]);

function luminance(rgb: RGB): number {
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
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

function readPixel(data: Buffer, x: number, y: number, width: number, stride: number): RGB {
  const idx = (y * width + x) * stride;
  return { r: data[idx] ?? 0, g: data[idx + 1] ?? 0, b: data[idx + 2] ?? 0 };
}

function sampleRegionColor(
  data: Buffer,
  rect: Rect,
  width: number,
  stride: number,
): { rgb: RGB; lum: number; variance: number } | null {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  const lums: number[] = [];
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const px = readPixel(data, x, y, width, stride);
      sumR += px.r;
      sumG += px.g;
      sumB += px.b;
      lums.push(luminance(px));
      count++;
    }
  }
  if (count === 0) return null;
  const rgb: RGB = {
    r: Math.round(sumR / count),
    g: Math.round(sumG / count),
    b: Math.round(sumB / count),
  };
  const meanLum = luminance(rgb);
  let varSum = 0;
  for (const l of lums) varSum += (l - meanLum) * (l - meanLum);
  return { rgb, lum: meanLum, variance: varSum / count };
}

function sampleCornerPageBg(data: Buffer, width: number, height: number, stride: number): RGB | null {
  const corners: Rect[] = [
    { x0: 0, y0: 0, x1: Math.min(CORNER_SAMPLE, width), y1: Math.min(CORNER_SAMPLE, height) },
    {
      x0: Math.max(0, width - CORNER_SAMPLE),
      y0: 0,
      x1: width,
      y1: Math.min(CORNER_SAMPLE, height),
    },
    {
      x0: 0,
      y0: Math.max(0, height - CORNER_SAMPLE),
      x1: Math.min(CORNER_SAMPLE, width),
      y1: height,
    },
    {
      x0: Math.max(0, width - CORNER_SAMPLE),
      y0: Math.max(0, height - CORNER_SAMPLE),
      x1: width,
      y1: height,
    },
  ];
  let brightest: RGB | null = null;
  let brightestLum = -1;
  for (const c of corners) {
    const m = sampleRegionColor(data, c, width, stride);
    if (m === null) continue;
    if (m.lum > brightestLum) {
      brightestLum = m.lum;
      brightest = m.rgb;
    }
  }
  return brightest;
}

interface MaskResult {
  mask: BBox;
  maskLum: number;
}

function detectMask(data: Buffer, width: number, height: number, stride: number): MaskResult | null {
  const pageBg = sampleCornerPageBg(data, width, height, stride);
  const pageBgLum = pageBg !== null ? luminance(pageBg) : 255;
  const gw = width / MASK_GRID;
  const gh = height / MASK_GRID;
  let dimBlocks = 0;
  let totalBlocks = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maskLumSum = 0;
  for (let by = 0; by < MASK_GRID; by++) {
    for (let bx = 0; bx < MASK_GRID; bx++) {
      const rect: Rect = {
        x0: Math.floor(bx * gw),
        y0: Math.floor(by * gh),
        x1: Math.min(width, Math.ceil((bx + 1) * gw)),
        y1: Math.min(height, Math.ceil((by + 1) * gh)),
      };
      const m = sampleRegionColor(data, rect, width, stride);
      if (m === null) continue;
      totalBlocks++;
      const dimByPage = m.lum < pageBgLum - MASK_LUM_DIFF;
      const dimAbsolute = m.lum < MASK_ABSOLUTE_LUM;
      if ((dimByPage || dimAbsolute) && m.variance < MASK_MAX_VARIANCE) {
        dimBlocks++;
        if (rect.x0 < minX) minX = rect.x0;
        if (rect.y0 < minY) minY = rect.y0;
        if (rect.x1 > maxX) maxX = rect.x1;
        if (rect.y1 > maxY) maxY = rect.y1;
        maskLumSum += m.lum;
      }
    }
  }
  if (totalBlocks === 0) return null;
  if (dimBlocks / totalBlocks < MASK_MIN_COVERAGE) return null;
  return {
    mask: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    maskLum: maskLumSum / dimBlocks,
  };
}

function bboxInside(inner: BBox, outer: BBox): boolean {
  const eps = 1e-6;
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.w <= outer.x + outer.w + eps &&
    inner.y + inner.h <= outer.y + outer.h + eps
  );
}

function findDialogCandidate(
  ast: SemanticAST,
  mask: BBox,
  maskLum: number,
  data: Buffer,
  width: number,
  height: number,
  stride: number,
): ASTNode | null {
  const maskCx = mask.x + mask.w / 2;
  const maskCy = mask.y + mask.h / 2;
  let best: ASTNode | null = null;
  let bestArea = Infinity;
  for (const node of walkNodes(ast.root)) {
    if (node === ast.root) continue;
    if (!OVERLAY_CONTAINER_TYPES.has(node.type)) continue;
    if (!bboxInside(node.bbox, mask)) continue;
    const cx = node.bbox.x + node.bbox.w / 2;
    const cy = node.bbox.y + node.bbox.h / 2;
    if (Math.abs(cx - maskCx) > mask.w * DIALOG_CENTER_TOLERANCE) continue;
    if (Math.abs(cy - maskCy) > mask.h * DIALOG_CENTER_TOLERANCE) continue;
    const rect = clipRect(node.bbox, width, height);
    if (rect === null) continue;
    const m = sampleRegionColor(data, rect, width, stride);
    if (m === null) continue;
    if (m.lum < maskLum + DIALOG_CARD_BRIGHTNESS_DIFF) continue;
    const area = node.bbox.w * node.bbox.h;
    if (area < bestArea) {
      bestArea = area;
      best = node;
    }
  }
  return best;
}

function detectGeometryOverlays(ast: SemanticAST, pageW: number, pageH: number): OverlayInfo[] {
  const out: OverlayInfo[] = [];
  for (const node of walkNodes(ast.root)) {
    if (node === ast.root) continue;
    if (!OVERLAY_CONTAINER_TYPES.has(node.type)) continue;
    const { x, y, w, h } = node.bbox;
    const leftEdge = x <= pageW * EDGE_RATIO;
    const rightEdge = x + w >= pageW * (1 - EDGE_RATIO);
    if (
      (leftEdge || rightEdge) &&
      h >= pageH * DRAWER_MIN_HEIGHT_RATIO &&
      w < pageW * DRAWER_MAX_WIDTH_RATIO
    ) {
      out.push({ nodeId: node.id, overlayType: 'drawer', zIndex: DRAWER_Z });
      continue;
    }
    const bottomEdge = y + h >= pageH * (1 - EDGE_RATIO);
    if (
      bottomEdge &&
      w >= pageW * BOTTOM_SHEET_MIN_WIDTH_RATIO &&
      h < pageH * BOTTOM_SHEET_MAX_HEIGHT_RATIO
    ) {
      out.push({ nodeId: node.id, overlayType: 'bottomSheet', zIndex: BOTTOM_SHEET_Z });
    }
  }
  return out;
}

/**
 * Detect modal overlays in the {@link SemanticAST}. Geometry-based drawer /
 * bottomSheet candidates are always evaluated (no image required); dialog
 * detection runs only when an `image` is supplied (it needs the dim mask
 * signal from pixels). A node is reported at most once, with dialog taking
 * priority over drawer / bottomSheet.
 */
export async function detectOverlays(
  image: ImageInput | undefined,
  ast: SemanticAST,
): Promise<OverlayInfo[]> {
  let data: Buffer | null = null;
  let imgW = 0;
  let imgH = 0;
  let stride = 0;
  if (image !== undefined) {
    const dec = await sharp(image.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    data = dec.data;
    imgW = dec.info.width;
    imgH = dec.info.height;
    stride = dec.info.channels;
  }

  const pageW = data !== null ? imgW : ast.root.bbox.w;
  const pageH = data !== null ? imgH : ast.root.bbox.h;
  if (pageW <= 0 || pageH <= 0) return [];

  const overlays: OverlayInfo[] = [];
  const dialogNodeIds = new Set<string>();

  if (data !== null) {
    const maskResult = detectMask(data, imgW, imgH, stride);
    if (maskResult !== null) {
      const cand = findDialogCandidate(ast, maskResult.mask, maskResult.maskLum, data, imgW, imgH, stride);
      if (cand !== null) {
        overlays.push({
          nodeId: cand.id,
          overlayType: 'dialog',
          zIndex: DIALOG_Z,
          mask: maskResult.mask,
        });
        dialogNodeIds.add(cand.id);
      }
    }
  }

  for (const info of detectGeometryOverlays(ast, pageW, pageH)) {
    if (dialogNodeIds.has(info.nodeId)) continue;
    overlays.push(info);
  }

  return overlays;
}

/**
 * Walk the {@link SemanticAST} and fold each {@link OverlayInfo} onto the
 * matching node in place: rewrite `node.type` to the overlay type and set
 * `node.props.overlay` / `node.props.zIndex` (and `node.props.mask` when a
 * dialog mask was detected). Nodes without an overlay entry are left
 * untouched. Synchronous, pure mutation.
 */
export function applyOverlays(ast: SemanticAST, overlays: OverlayInfo[]): void {
  if (overlays.length === 0) return;
  const map = new Map<string, OverlayInfo>();
  for (const o of overlays) map.set(o.nodeId, o);
  for (const node of walkNodes(ast.root)) {
    const info = map.get(node.id);
    if (info === undefined) continue;
    node.type = info.overlayType;
    node.props.overlay = true;
    node.props.zIndex = info.zIndex;
    if (info.mask !== undefined) node.props.mask = info.mask;
  }
}
