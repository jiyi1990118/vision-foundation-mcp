/**
 * UI Layout Extractor - visual region and component detection via pixel analysis.
 *
 * Detects visual layout blocks (header/sidebar/main/footer/cards), component
 * boundaries (buttons/inputs/tabs/tables), estimates text hierarchy from OCR
 * bbox heights, measures spacing between regions, and identifies icon/image
 * areas. All algorithmic via sharp — no VLM call.
 *
 * @see src/core/extractors/ - sibling extractors
 */
import sharp from 'sharp';
import type { ImageInput } from '../../types/domain.js';
import type { OcrItem } from '../key-content-extractor.js';

// ── Types ──

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VisualRegion {
  id: string;
  type: 'header' | 'sidebar' | 'main' | 'footer' | 'card' | 'nav' | 'table' | 'content';
  bbox: BBox;
  relativeArea: number;
  bgColor?: string | undefined;
  children: string[];
}

export type ComponentType =
  | 'button'
  | 'input'
  | 'dropdown'
  | 'table'
  | 'tab'
  | 'card'
  | 'checkbox'
  | 'toggle'
  | 'badge'
  | 'avatar'
  | 'unknown';

export type ComponentVariant =
  | 'primary'
  | 'secondary'
  | 'success'
  | 'danger'
  | 'ghost'
  | 'default';

export interface UiComponent {
  type: ComponentType;
  bbox: BBox;
  text: string;
  state: 'default' | 'active' | 'selected' | 'disabled';
  variant: ComponentVariant;
}

export type TextLevel = 'title' | 'heading' | 'body' | 'caption';

export interface TextEntry {
  text: string;
  bbox: BBox;
  estimatedLevel: TextLevel;
}

export interface SpacingInfo {
  averageGap: number;
  scale: 'compact' | 'comfortable' | 'spacious';
  verticalGaps: number[];
  horizontalGaps: number[];
}

export interface MediaArea {
  bbox: BBox;
  type: 'icon' | 'image' | 'logo';
  nearbyText: string | undefined;
}

export interface UiLayoutExtraction {
  structure: {
    pageType: string;
    layoutType: 'grid' | 'columns' | 'sidebar' | 'centered' | 'split-pane' | 'stack';
    regions: VisualRegion[];
  };
  components: UiComponent[];
  texts: TextEntry[];
  spacing: SpacingInfo;
  mediaAreas: MediaArea[];
  summary: string;
}

// ── Constants ──

const THUMBNAIL_W = 400;
const EDGE_THRESHOLD = 30;
const MIN_REGION_AREA = 400;       // 20x20 minimum
const MAX_REGIONS = 30;
const MIN_COMPONENT_AREA = 200;    // ~14x14
const MAX_COMPONENTS = 40;

// ── Helpers ──

function toBBox(x1: number, y1: number, x2: number, y2: number): BBox {
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function bboxArea(b: BBox): number {
  return b.w * b.h;
}

function bboxOverlap(a: BBox, b: BBox): number {
  const xOverlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return xOverlap * yOverlap;
}

function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

function scaleBBox(b: BBox, sx: number, sy: number): BBox {
  return { x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy };
}
// ── Edge detection (Sobel-like) ──

interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

async function toGrayImage(image: ImageInput): Promise<GrayImage> {
  const { data, info } = await sharp(image.buffer)
    .removeAlpha()
    .resize(THUMBNAIL_W, null, { fit: 'inside' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function detectEdges(img: GrayImage): Uint8Array {
  const { data, width, height } = img;
  const edges = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      // Sobel kernels
      const gx =
        -data[idx - width - 1]! + data[idx - width + 1]!
        - 2 * data[idx - 1]! + 2 * data[idx + 1]!
        - data[idx + width - 1]! + data[idx + width + 1]!;
      const gy =
        -data[idx - width - 1]! - 2 * data[idx - width]! - data[idx - width + 1]!
        + data[idx + width - 1]! + 2 * data[idx + width]! + data[idx + width + 1]!;
      const mag = Math.sqrt(gx * gx + gy * gy);
      edges[idx] = mag > EDGE_THRESHOLD ? 255 : 0;
    }
  }
  return edges;
}

// ── Connected component labeling (two-pass) ──

interface RawRegion {
  bbox: BBox;
  pixelCount: number;
}

function findConnectedComponents(edges: Uint8Array, width: number, height: number): RawRegion[] {
  const labels = new Int32Array(width * height);
  let nextLabel = 1;
  const labelMap = new Map<number, number>();
  const regions: RawRegion[] = [];

  // First pass: assign provisional labels
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (edges[idx] === 0) continue;
      const left = x > 0 ? labels[idx - 1]! : 0;
      const top = y > 0 ? labels[idx - width]! : 0;
      if (left === 0 && top === 0) {
        labels[idx] = nextLabel++;
      } else if (left !== 0 && top === 0) {
        labels[idx] = left;
      } else if (left === 0 && top !== 0) {
        labels[idx] = top;
      } else {
        const minLabel = Math.min(left, top);
        const maxLabel = Math.max(left, top);
        labels[idx] = minLabel;
        if (minLabel !== maxLabel) {
          labelMap.set(maxLabel, minLabel);
        }
      }
    }
  }

  // Resolve label equivalences
  function resolve(label: number): number {
    let l = label;
    while (labelMap.has(l)) {
      l = labelMap.get(l)!;
    }
    return l;
  }

  // Second pass: collect bboxes
  const regionMap = new Map<number, { minX: number; minY: number; maxX: number; maxY: number; count: number }>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (labels[idx] === 0) continue;
      const finalLabel = resolve(labels[idx]!);
      const existing = regionMap.get(finalLabel);
      if (existing) {
        existing.minX = Math.min(existing.minX, x);
        existing.minY = Math.min(existing.minY, y);
        existing.maxX = Math.max(existing.maxX, x);
        existing.maxY = Math.max(existing.maxY, y);
        existing.count++;
      } else {
        regionMap.set(finalLabel, { minX: x, minY: y, maxX: x, maxY: y, count: 1 });
      }
    }
  }

  for (const r of regionMap.values()) {
    const bbox = toBBox(r.minX, r.minY, r.maxX + 1, r.maxY + 1);
    const area = bboxArea(bbox);
    if (area < MIN_REGION_AREA) continue;
    regions.push({ bbox, pixelCount: r.count });
  }

  return regions;
}

// ── Region classification ──

function classifyRegions(
  regions: RawRegion[],
  imgWidth: number,
  imgHeight: number,
): VisualRegion[] {
  // Sort by area descending
  regions.sort((a, b) => bboxArea(b.bbox) - bboxArea(a.bbox));

  const result: VisualRegion[] = [];
  const totalArea = imgWidth * imgHeight;

  for (let i = 0; i < Math.min(regions.length, MAX_REGIONS); i++) {
    const r = regions[i]!;
    const { bbox } = r;
    const relArea = round(bboxArea(bbox) / totalArea, 4);
    const xCenter = bbox.x + bbox.w / 2;
    const yCenter = bbox.y + bbox.h / 2;

    let type: VisualRegion['type'] = 'content';

    // Header: top 15% of image, wide
    if (yCenter < imgHeight * 0.15 && bbox.w > imgWidth * 0.5) {
      type = 'header';
    }
    // Footer: bottom 15%, wide
    else if (yCenter > imgHeight * 0.85 && bbox.w > imgWidth * 0.5) {
      type = 'footer';
    }
    // Sidebar: left/right 25%, tall (>50% height)
    else if ((xCenter < imgWidth * 0.25 || xCenter > imgWidth * 0.75) && bbox.h > imgHeight * 0.4) {
      type = 'sidebar';
    }
    // Nav: thin horizontal bar
    else if (bbox.h < imgHeight * 0.1 && bbox.w > imgWidth * 0.3) {
      type = 'nav';
    }
    // Table: wide + tall in main area
    else if (bbox.w > imgWidth * 0.4 && bbox.h > imgHeight * 0.2) {
      type = 'table';
    }
    // Card: medium-sized block
    else if (relArea > 0.02 && relArea < 0.3) {
      type = 'card';
    }
    // Main: largest central region
    else if (relArea > 0.3) {
      type = 'main';
    }

    result.push({
      id: `r${i}`,
      type,
      bbox,
      relativeArea: relArea,
      children: [],
    });
  }

  // Build parent-child relationships
  for (let i = 0; i < result.length; i++) {
    for (let j = 0; j < result.length; j++) {
      if (i === j) continue;
      if (bboxContains(result[i]!.bbox, result[j]!.bbox) && result[i]!.bbox.w > result[j]!.bbox.w + 4) {
        result[i]!.children.push(result[j]!.id);
      }
    }
  }

  return result;
}

// ── Component detection ──

function detectComponents(
  regions: RawRegion[],
  ocrItems: OcrItem[],
  imgWidth: number,
  imgHeight: number,
  designPalette: { hex: string; role: string }[] | undefined,
): UiComponent[] {
  const components: UiComponent[] = [];
  const seen = new Set<string>();

  // Also check OCR items as potential component anchors
  for (const item of ocrItems) {
    if (!item.box) continue;
    const bbox = toBBox(item.box.x1, item.box.y1, item.box.x2, item.box.y2);
    const area = bboxArea(bbox);
    if (area < MIN_COMPONENT_AREA || area > imgWidth * imgHeight * 0.15) continue;

    const text = item.text.trim();
    const type = inferComponentType(text, bbox, imgWidth, imgHeight);
    if (type === 'unknown') continue;

    const key = `${type}:${Math.round(bbox.x)},${Math.round(bbox.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const variant = inferVariant(type, text, designPalette);
    const state = inferState(text);

    components.push({ type, bbox, text, state, variant });
    if (components.length >= MAX_COMPONENTS) break;
  }

  return components;
}

function inferComponentType(
  text: string,
  bbox: BBox,
  _imgWidth: number,
  _imgHeight: number,
): ComponentType {
  const lower = text.toLowerCase();

  // Button: action keywords
  if (/^(保存|取消|确定|提交|关闭|新增|删除|编辑|查询|搜索|筛选|登录|注册|添加|修改|确认|返回|下一步|上一步|下载|导出|导入|刷新|重置)$/i.test(text)) {
    return 'button';
  }
  if (/^(save|cancel|submit|close|add|delete|edit|search|filter|login|register|confirm|back|next|download|export|import|refresh|reset)$/i.test(lower)) {
    return 'button';
  }

  // Tab: short text, horizontal arrangement
  if (text.length <= 6 && /^(全部|待办|已完成|已关闭|进行中|tab|概览|详情|设置|all|active|done|close|open|tab)$/i.test(text)) {
    return 'tab';
  }

  // Checkbox / toggle
  if (/^(✓|√|☑|☐|是|否|开|关|on|off|yes|no|启用|停用)$/i.test(text)) {
    if (/^(开|关|on|off)$/i.test(lower)) return 'toggle';
    return 'checkbox';
  }

  // Badge: very short text with brackets or numbers
  if (/^\[?\d+\]?$|^new$|^hot$|^sale$/i.test(text)) {
    return 'badge';
  }

  // Avatar: circular-ish (w ≈ h, small)
  if (bbox.w > 12 && bbox.h > 12 && bbox.w < 50 && bbox.h < 50) {
    const ratio = bbox.w / bbox.h;
    if (ratio > 0.8 && ratio < 1.2) return 'avatar';
  }

  // Input: placeholder text or label-like
  if (/^(请输入|请选择|请搜索|搜索|placeholder|select|choose)/i.test(text)) {
    return 'input';
  }

  // Dropdown: has ▼ or select-like
  if (/▼|▾|请选择|select/i.test(text)) {
    return 'dropdown';
  }

  return 'unknown';
}

function inferVariant(
  type: ComponentType,
  text: string,
  _palette: { hex: string; role: string }[] | undefined,
): ComponentVariant {
  const dangerWords = /^(删除|移除|危险|delete|remove|danger)/i;
  const successWords = /^(成功|完成|通过|success|approve)/i;

  if (dangerWords.test(text)) return 'danger';
  if (successWords.test(text)) return 'success';

  // If primary color is known and the text is a common primary action
  const primaryActions = /^(保存|确定|提交|新增|确认|登录|注册|save|submit|confirm|add|login|register)$/i;
  if (type === 'button' && primaryActions.test(text)) return 'primary';

  const cancelActions = /^(取消|关闭|返回|重置|cancel|close|back|reset)$/i;
  if (type === 'button' && cancelActions.test(text)) return 'ghost';

  return 'default';
}

function inferState(text: string): 'default' | 'active' | 'selected' | 'disabled' {
  if (/^(全部|all)$/i.test(text)) return 'active';
  return 'default';
}

// ── Text hierarchy estimation ──

function estimateTextLevel(bbox: BBox, allHeights: number[]): TextLevel {
  if (allHeights.length === 0) return 'body';
  const sorted = [...allHeights].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const h = bbox.h;

  if (h > median * 2.5) return 'title';
  if (h > median * 1.6) return 'heading';
  if (h < median * 0.7) return 'caption';
  return 'body';
}

function buildTextEntries(ocrItems: OcrItem[]): TextEntry[] {
  const boxedItems = ocrItems.filter((i): i is OcrItem & { box: NonNullable<OcrItem['box']> } => i.box !== undefined);
  if (boxedItems.length === 0) return [];

  const allHeights = boxedItems.map((i) => i.box!.y2 - i.box!.y1);
  const entries: TextEntry[] = [];

  for (const item of boxedItems) {
    const bbox = toBBox(item.box.x1, item.box.y1, item.box.x2, item.box.y2);
    entries.push({
      text: item.text.trim(),
      bbox,
      estimatedLevel: estimateTextLevel(bbox, allHeights),
    });
  }

  return entries;
}

// ── Spacing measurement ──

function measureSpacing(regions: VisualRegion[], _imgHeight: number): SpacingInfo {
  const vGaps: number[] = [];
  const hGaps: number[] = [];

  // Sort regions by position
  const sortedByY = [...regions].sort((a, b) => a.bbox.y - b.bbox.y);
  for (let i = 1; i < sortedByY.length; i++) {
    const prev = sortedByY[i - 1]!;
    const curr = sortedByY[i]!;
    if (Math.abs(curr.bbox.x - prev.bbox.x) < prev.bbox.w * 0.5) {
      const gap = curr.bbox.y - (prev.bbox.y + prev.bbox.h);
      if (gap > 0) vGaps.push(gap);
    }
  }

  const sortedByX = [...regions].sort((a, b) => a.bbox.x - b.bbox.x);
  for (let i = 1; i < sortedByX.length; i++) {
    const prev = sortedByX[i - 1]!;
    const curr = sortedByX[i]!;
    if (Math.abs(curr.bbox.y - prev.bbox.y) < prev.bbox.h * 0.5) {
      const gap = curr.bbox.x - (prev.bbox.x + prev.bbox.w);
      if (gap > 0) hGaps.push(gap);
    }
  }

  const allGaps = [...vGaps, ...hGaps];
  const avgGap = allGaps.length > 0
    ? allGaps.reduce((a, b) => a + b, 0) / allGaps.length
    : 0;

  const scale: SpacingInfo['scale'] = avgGap < 5 ? 'compact' : avgGap < 15 ? 'comfortable' : 'spacious';

  return {
    averageGap: round(avgGap, 1),
    scale,
    verticalGaps: vGaps.slice(0, 20),
    horizontalGaps: hGaps.slice(0, 20),
  };
}

// ── Media area detection ──

function detectMediaAreas(
  edges: Uint8Array,
  width: number,
  height: number,
  ocrItems: OcrItem[],
): MediaArea[] {
  // Find edge-dense regions that don't overlap with OCR text
  const blockSize = 20;
  const mediaAreas: MediaArea[] = [];

  for (let y = 0; y < height - blockSize; y += blockSize) {
    for (let x = 0; x < width - blockSize; x += blockSize) {
      let edgeCount = 0;
      for (let dy = 0; dy < blockSize; dy++) {
        for (let dx = 0; dx < blockSize; dx++) {
          if (edges[(y + dy) * width + (x + dx)]! > 0) edgeCount++;
        }
      }
      if (edgeCount < blockSize * blockSize * 0.15) continue;

      const blockBBox = toBBox(x, y, x + blockSize, y + blockSize);
      // Skip if overlapping with OCR text
      const overlapsText = ocrItems.some((item) => {
        if (!item.box) return false;
        const ocrBBox = toBBox(item.box.x1, item.box.y1, item.box.x2, item.box.y2);
        return bboxOverlap(blockBBox, ocrBBox) > bboxArea(blockBBox) * 0.3;
      });
      if (overlapsText) continue;

      // Find nearby text
      const nearby = ocrItems.find((item) => {
        if (!item.box) return false;
        const cx = (item.box.x1 + item.box.x2) / 2;
        const cy = (item.box.y1 + item.box.y2) / 2;
        const dx = cx - (blockBBox.x + blockSize / 2);
        const dy = cy - (blockBBox.y + blockSize / 2);
        return Math.sqrt(dx * dx + dy * dy) < 60;
      });

      const type: MediaArea['type'] = blockSize < 30 ? 'icon' : blockBBox.w > 60 ? 'image' : 'logo';
      mediaAreas.push({
        bbox: blockBBox,
        type,
        nearbyText: nearby?.text.trim(),
      });
    }
  }

  // Merge adjacent media blocks
  const merged = mergeAdjacentMedia(mediaAreas);
  return merged.slice(0, 20);
}

function mergeAdjacentMedia(areas: MediaArea[]): MediaArea[] {
  const merged: MediaArea[] = [];
  for (const area of areas) {
    const adjacent = merged.find((m) => {
      const dx = Math.abs(m.bbox.x - area.bbox.x);
      const dy = Math.abs(m.bbox.y - area.bbox.y);
      return dx <= 20 && dy <= 20;
    });
    if (adjacent) {
      const x1 = Math.min(adjacent.bbox.x, area.bbox.x);
      const y1 = Math.min(adjacent.bbox.y, area.bbox.y);
      const x2 = Math.max(adjacent.bbox.x + adjacent.bbox.w, area.bbox.x + area.bbox.w);
      const y2 = Math.max(adjacent.bbox.y + adjacent.bbox.h, area.bbox.y + area.bbox.h);
      adjacent.bbox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      if (!adjacent.nearbyText && area.nearbyText) adjacent.nearbyText = area.nearbyText;
    } else {
      merged.push({ ...area });
    }
  }
  return merged;
}

// ── Layout type inference ──

function inferLayoutType(regions: VisualRegion[], imgWidth: number, _imgHeight: number): UiLayoutExtraction['structure']['layoutType'] {
  const hasSidebar = regions.some((r) => r.type === 'sidebar');
  const hasHeader = regions.some((r) => r.type === 'header');
  const hasFooter = regions.some((r) => r.type === 'footer');
  const cards = regions.filter((r) => r.type === 'card');

  if (cards.length >= 3) {
    // Check if cards are in a grid arrangement
    const sorted = cards.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
    const sameRow = sorted.filter((c) => Math.abs(c.bbox.y - sorted[0]!.bbox.y) < 10);
    if (sameRow.length >= 2) return 'grid';
  }

  if (hasSidebar && hasHeader) return 'sidebar';
  if (cards.length >= 2) return 'columns';
  if (hasHeader && hasFooter && !hasSidebar) return 'stack';

  // Check for centered layout
  const centerRegions = regions.filter((r) =>
    Math.abs(r.bbox.x + r.bbox.w / 2 - imgWidth / 2) < imgWidth * 0.15,
  );
  if (centerRegions.length === regions.length && regions.length > 0) return 'centered';

  return 'stack';
}

// ── Summary ──

function buildSummary(
  regions: VisualRegion[],
  components: UiComponent[],
  texts: TextEntry[],
  spacing: SpacingInfo,
  mediaAreas: MediaArea[],
): string {
  const parts: string[] = [];
  const types = [...new Set(regions.map((r) => r.type))];
  parts.push(`${regions.length} 个视觉区域（${types.join('/')}）`);
  parts.push(`${components.length} 个组件`);
  if (mediaAreas.length > 0) parts.push(`${mediaAreas.length} 个图标/图片区域`);
  parts.push(`间距风格：${spacing.scale}`);
  const titleCount = texts.filter((t) => t.estimatedLevel === 'title').length;
  if (titleCount > 0) parts.push(`标题 ${titleCount} 个`);
  return parts.join('，');
}

// ── Main extraction ──

/**
 * Extract visual layout structure, components, text hierarchy, spacing, and
 * media areas from a UI design image. Uses sharp for pixel analysis and
 * optionally consumes OCR items for text-component anchoring.
 */
export async function extractUiLayout(
  image: ImageInput,
  ocrItems: OcrItem[] | undefined,
  designPalette?: { hex: string; role: string }[],
): Promise<UiLayoutExtraction> {
  const img = await toGrayImage(image);
  const { width, height } = img;

  const edges = detectEdges(img);
  const rawRegions = findConnectedComponents(edges, width, height);
  const regions = classifyRegions(rawRegions, width, height);
  const components = detectComponents(rawRegions, ocrItems ?? [], width, height, designPalette);
  const texts = buildTextEntries(ocrItems ?? []);
  const spacing = measureSpacing(regions, height);
  const mediaAreas = detectMediaAreas(edges, width, height, ocrItems ?? []);
  const layoutType = inferLayoutType(regions, width, height);

  // Scale all bboxes back to original image dimensions
  const originalMeta = await sharp(image.buffer).metadata();
  const origW = originalMeta.width ?? 1;
  const origH = originalMeta.height ?? 1;
  const scaleX = origW / width;
  const scaleY = origH / height;

  for (const r of regions) r.bbox = scaleBBox(r.bbox, scaleX, scaleY);
  for (const c of components) c.bbox = scaleBBox(c.bbox, scaleX, scaleY);
  for (const m of mediaAreas) m.bbox = scaleBBox(m.bbox, scaleX, scaleY);
  // Texts already use original OCR coordinates (not scaled)

  const pageType = inferPageType(regions, components, ocrItems ?? []);

  const summary = buildSummary(regions, components, texts, spacing, mediaAreas);

  return {
    structure: {
      pageType,
      layoutType,
      regions,
    },
    components,
    texts,
    spacing,
    mediaAreas,
    summary,
  };
}

function inferPageType(
  regions: VisualRegion[],
  components: UiComponent[],
  ocrItems: OcrItem[],
): string {
  const hasSidebar = regions.some((r) => r.type === 'sidebar');
  const hasTable = regions.some((r) => r.type === 'table');
  const hasManyCards = regions.filter((r) => r.type === 'card').length >= 3;
  const hasFormInputs = components.some((c) => c.type === 'input');
  const hasMobileSignals = ocrItems.some((i) =>
    /^\d{1,2}:\d{2}$/.test(i.text) || /返回|详情/.test(i.text),
  );

  if (hasMobileSignals) return 'mobile-ui';
  if (hasSidebar && (hasTable || hasFormInputs)) return 'admin-ui';
  if (hasManyCards) return 'dashboard';
  if (hasFormInputs) return 'form';
  return 'general-ui';
}

function round(n: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}
