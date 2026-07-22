/**
 * Type Enricher (Stream S23, G-A1+G-A2) - second-pass type promotion on a
 * built {@link SemanticAST}. The ast-builder only maps the legacy 11
 * component types + 8 regions + 3 media, so ~18 ComponentType values
 * (list / listItem / divider / progress / textarea / tag / toolbar /
 * iconButton / title / subtitle ...) are never emitted. This pure
 * post-pass walks the tree post-order (children before parent) and
 * rewrites `node.type` in place via geometric + textual heuristics,
 * surfacing those missing types. It also annotates form-label text with
 * `props.semanticRole = 'label'`; bbox / children are never touched.
 *
 * Promotes only generic types (unknown / container / text / input /
 * button); a specific type is never downgraded back to a generic one.
 * Intended to run after style injection so the text-leveling rule can
 * read `node.props.style.fontSize` (falling back to `bbox.h`).
 *
 * @see ../ir/types.js       (ComponentType union, ASTNode, NodeStyle)
 * @see ../orchestrator.js   (invocation site, after style injection)
 * @see ../repeats/repeat-engine.js  (sibling-similarity grouping pattern)
 */
import type {
  SemanticAST,
  ASTNode,
  ComponentType,
  BBox,
  VisionOcrItem,
} from '../ir/types.js';

const SIZE_TOLERANCE = 0.15;
const TEXTAREA_MIN_H = 80;
const ICON_BUTTON_MAX_W = 48;
const ICON_BUTTON_MIN_RATIO = 0.7;
const ICON_BUTTON_MAX_RATIO = 1.4;
const ICON_BUTTON_MAX_TEXT = 2;
const TAG_MAX_TEXT = 6;
const TAG_MAX_W = 120;
const TAG_MAX_H = 32;
const DIVIDER_MIN_RATIO = 20;
const DIVIDER_MAX_THIN = 16;
const PROGRESS_MIN_RATIO = 10;
const PROGRESS_MAX_H = 30;
const LIST_MIN_GROUP = 3;
const TOOLBAR_MIN_ACTIONS = 2;
const TOOLBAR_ACTION_RATIO = 2 / 3;
const TITLE_RATIO = 1.5;
const SUBTITLE_RATIO = 1.15;

const GENERIC_CONTAINER: ReadonlySet<ComponentType> = new Set([
  'container',
  'section',
  'unknown',
]);

const LIST_ITEM_TYPES: ReadonlySet<ComponentType> = new Set([
  'card',
  'unknown',
  'image',
  'section',
  'row',
]);

const BADGE_SMALL_W = 32;
const BADGE_SMALL_H = 24;
const SELECT_NEARBY_PX = 20;
const SELECT_SIBLING_MAX = 48;
const LAYOUT_MIN_CHILDREN = 2;

const LAYOUT_CANDIDATES: ReadonlySet<ComponentType> = new Set(['container', 'unknown']);

const INTERACTIVE_TYPES: ReadonlySet<ComponentType> = new Set([
  'button',
  'iconButton',
  'input',
  'textarea',
  'select',
  'checkbox',
  'radio',
  'switch',
  'dropdown',
]);

const SELECT_SIBLING_TYPES: ReadonlySet<ComponentType> = new Set(['icon', 'avatar']);

const SELECT_KEYWORDS: readonly string[] = ['请选择', '选择', '下拉', 'selected', 'select'];

function relativeDiff(a: number, b: number): number {
  const max = Math.max(a, b);
  if (max <= 0) return 0;
  return Math.abs(a - b) / max;
}

function sizesSimilar(a: ASTNode, b: ASTNode): boolean {
  return (
    relativeDiff(a.bbox.w, b.bbox.w) <= SIZE_TOLERANCE &&
    relativeDiff(a.bbox.h, b.bbox.h) <= SIZE_TOLERANCE
  );
}

function groupSimilarChildren(children: ASTNode[]): ASTNode[][] {
  const groups: ASTNode[][] = [];
  const assigned = new Set<number>();
  for (let i = 0; i < children.length; i++) {
    if (assigned.has(i)) continue;
    const seed = children[i]!;
    const group: ASTNode[] = [seed];
    assigned.add(i);
    for (let j = i + 1; j < children.length; j++) {
      if (assigned.has(j)) continue;
      const candidate = children[j]!;
      if (candidate.type === seed.type && sizesSimilar(seed, candidate)) {
        group.push(candidate);
        assigned.add(j);
      }
    }
    groups.push(group);
  }
  return groups;
}

function hasText(node: ASTNode): boolean {
  return node.text !== undefined && node.text.trim().length > 0;
}

function textLen(node: ASTNode): number {
  return node.text !== undefined ? node.text.trim().length : 0;
}

function isExtremeAspect(node: ASTNode): boolean {
  const { w, h } = node.bbox;
  if (w <= 0 || h <= 0) return false;
  return w / h > DIVIDER_MIN_RATIO || h / w > DIVIDER_MIN_RATIO;
}

function readFontSize(node: ASTNode): number {
  const style = node.props.style;
  if (style !== undefined && typeof style === 'object' && style !== null) {
    const fs = (style as Record<string, unknown>).fontSize;
    if (typeof fs === 'number') return fs;
  }
  return node.bbox.h;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid]!;
  return (s[mid - 1]! + s[mid]!) / 2;
}

function spread(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.max(...nums) - Math.min(...nums);
}

function promoteLeaf(node: ASTNode): void {
  if (node.children.length > 0) return;
  const t = node.type;

  if (!hasText(node) && (t === 'unknown' || t === 'container')) {
    if (isExtremeAspect(node) && Math.min(node.bbox.w, node.bbox.h) <= DIVIDER_MAX_THIN) {
      node.type = 'divider';
      return;
    }
    const { w, h } = node.bbox;
    if (h > 0 && w / h > PROGRESS_MIN_RATIO && h < PROGRESS_MAX_H) {
      node.type = 'progress';
      return;
    }
  }

  if (t === 'input' && node.bbox.h > TEXTAREA_MIN_H) {
    node.type = 'textarea';
    return;
  }

  if (t === 'button') {
    if (
      textLen(node) <= ICON_BUTTON_MAX_TEXT &&
      node.bbox.w < ICON_BUTTON_MAX_W
    ) {
      const r = node.bbox.h > 0 ? node.bbox.w / node.bbox.h : 0;
      if (r > ICON_BUTTON_MIN_RATIO && r < ICON_BUTTON_MAX_RATIO) {
        node.type = 'iconButton';
        return;
      }
    }
  }

  if (t === 'unknown' || t === 'container') {
    const tl = textLen(node);
    if (
      tl > 0 &&
      tl <= TAG_MAX_TEXT &&
      node.bbox.w < TAG_MAX_W &&
      node.bbox.h < TAG_MAX_H
    ) {
      node.type = 'tag';
      return;
    }
  }
}

function promoteList(node: ASTNode): void {
  if (node.children.length < LIST_MIN_GROUP) return;
  let best: ASTNode[] | null = null;
  for (const g of groupSimilarChildren(node.children)) {
    if (g.length < LIST_MIN_GROUP) continue;
    const seedType = g[0]!.type;
    if (!LIST_ITEM_TYPES.has(seedType)) continue;
    if (best === null || g.length > best.length) best = g;
  }
  if (best === null) return;
  if (inferDirectionLocal(best) !== 'column') return;
  node.type = 'list';
  for (const item of best) item.type = 'listItem';
}

function promoteToolbar(node: ASTNode): void {
  if (node.children.length < TOOLBAR_MIN_ACTIONS) return;
  let actions = 0;
  const ys: number[] = [];
  for (const c of node.children) {
    if (c.type === 'button' || c.type === 'iconButton' || c.type === 'icon') {
      actions++;
      ys.push(c.bbox.y + c.bbox.h / 2);
    }
  }
  if (actions < TOOLBAR_MIN_ACTIONS) return;
  if (actions / node.children.length < TOOLBAR_ACTION_RATIO) return;
  if (node.bbox.h <= 0 || node.bbox.w < node.bbox.h) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const y of ys) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxY - minY > node.bbox.h * 0.5) return;
  node.type = 'toolbar';
}

function promoteContainer(node: ASTNode): void {
  if (!GENERIC_CONTAINER.has(node.type)) return;
  promoteList(node);
  if (!GENERIC_CONTAINER.has(node.type)) return;
  promoteToolbar(node);
}

function isAllInteractive(children: ASTNode[]): boolean {
  if (children.length === 0) return false;
  for (const c of children) {
    if (!INTERACTIVE_TYPES.has(c.type)) return false;
  }
  return true;
}

function inferDirectionLocal(children: ASTNode[]): 'row' | 'column' | 'grid' {
  if (children.length < 2) return 'column';
  const xs = children.map((c) => c.bbox.x + c.bbox.w / 2);
  const ys = children.map((c) => c.bbox.y + c.bbox.h / 2);
  const xRange = spread(xs);
  const yRange = spread(ys);
  const avgW = children.reduce((a, c) => a + c.bbox.w, 0) / children.length;
  const avgH = children.reduce((a, c) => a + c.bbox.h, 0) / children.length;
  const xAligned = xRange < avgW * 0.5;
  const yAligned = yRange < avgH * 0.5;
  if (xAligned && yAligned) return xRange <= yRange ? 'column' : 'row';
  if (xAligned) return 'column';
  if (yAligned) return 'row';
  return 'grid';
}

function promoteLayout(node: ASTNode): void {
  if (!LAYOUT_CANDIDATES.has(node.type)) return;
  if (node.children.length < LAYOUT_MIN_CHILDREN) return;
  if (isAllInteractive(node.children)) return;
  node.type = inferDirectionLocal(node.children);
}

function promoteBadge(node: ASTNode): void {
  if (node.type !== 'tag') return;
  const text = node.text;
  if (text !== undefined && /^\d/.test(text.trim())) {
    node.type = 'badge';
    return;
  }
  if (node.bbox.w < BADGE_SMALL_W && node.bbox.h < BADGE_SMALL_H) {
    node.type = 'badge';
  }
}

function bboxIntersects(a: BBox, b: BBox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function nearbyOcrMatches(node: ASTNode, ocr: VisionOcrItem[], keywords: readonly string[]): boolean {
  const expanded: BBox = {
    x: node.bbox.x - SELECT_NEARBY_PX,
    y: node.bbox.y - SELECT_NEARBY_PX,
    w: node.bbox.w + 2 * SELECT_NEARBY_PX,
    h: node.bbox.h + 2 * SELECT_NEARBY_PX,
  };
  for (const item of ocr) {
    if (!bboxIntersects(expanded, item.bbox)) continue;
    const lower = item.text.toLowerCase();
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) return true;
    }
  }
  return false;
}

function promoteSelectByOcr(node: ASTNode, ocr: VisionOcrItem[] | undefined): void {
  if (node.type !== 'input') return;
  if (ocr === undefined || ocr.length === 0) return;
  if (nearbyOcrMatches(node, ocr, SELECT_KEYWORDS)) node.type = 'select';
}

const RADIO_KEYWORDS: readonly string[] = ['单选', 'radio', '○'];
const CHECKBOX_KEYWORDS: readonly string[] = ['多选', 'checkbox', '☑', '□', '勾选'];
const FORM_CONTROL_MAX_W = 32;
const FORM_CONTROL_MAX_H = 32;

/**
 * Promote a small leaf `input` (control-sized, not a text field) to `radio` /
 * `checkbox` when a nearby OCR label carries the matching keyword. Best-effort:
 * without OCR keywords a small input is left as-is - geometry alone cannot
 * distinguish radio (circle) from checkbox (square) because the type enricher
 * reads no pixels. A text-field-sized input (w or h beyond the control cap) is
 * never promoted here so a compact search box stays `input`.
 */
function promoteFormControl(node: ASTNode, ocr: VisionOcrItem[] | undefined): void {
  if (node.type !== 'input') return;
  if (node.children.length > 0) return;
  if (node.bbox.w >= FORM_CONTROL_MAX_W || node.bbox.h >= FORM_CONTROL_MAX_H) return;
  if (ocr === undefined || ocr.length === 0) return;
  if (nearbyOcrMatches(node, ocr, RADIO_KEYWORDS)) {
    node.type = 'radio';
    return;
  }
  if (nearbyOcrMatches(node, ocr, CHECKBOX_KEYWORDS)) {
    node.type = 'checkbox';
  }
}

function verticallyOverlap(a: BBox, b: BBox): boolean {
  return a.y < b.y + b.h && a.y + a.h > b.y;
}

function promoteSelectBySibling(node: ASTNode): void {
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    if (c.type !== 'input') continue;
    const cRight = c.bbox.x + c.bbox.w;
    for (let j = 0; j < children.length; j++) {
      if (j === i) continue;
      const sib = children[j]!;
      if (!SELECT_SIBLING_TYPES.has(sib.type)) continue;
      if (sib.bbox.w > SELECT_SIBLING_MAX || sib.bbox.h > SELECT_SIBLING_MAX) continue;
      if (sib.bbox.x >= cRight && verticallyOverlap(c.bbox, sib.bbox)) {
        c.type = 'select';
        break;
      }
    }
  }
}

function enrichExtra(node: ASTNode, ocr: VisionOcrItem[] | undefined, detectComponent: boolean): void {
  if (detectComponent) promoteSelectBySibling(node);
  for (const c of node.children) enrichExtra(c, ocr, detectComponent);
  if (detectComponent) {
    promoteBadge(node);
    promoteSelectByOcr(node, ocr);
    promoteFormControl(node, ocr);
  }
  promoteLayout(node);
}

function enrich(node: ASTNode): void {
  for (const c of node.children) enrich(c);
  promoteLeaf(node);
  promoteContainer(node);
}

function hierarchizeText(ast: SemanticAST): void {
  const textNodes: ASTNode[] = [];
  const sizes: number[] = [];
  const walk = (node: ASTNode): void => {
    if (node.type === 'text') {
      textNodes.push(node);
      sizes.push(readFontSize(node));
    }
    for (const c of node.children) walk(c);
  };
  walk(ast.root);
  if (textNodes.length === 0) return;
  const med = median(sizes);
  for (const n of textNodes) {
    const fs = readFontSize(n);
    if (fs >= med * TITLE_RATIO) n.type = 'title';
    else if (fs >= med * SUBTITLE_RATIO) n.type = 'subtitle';
  }
}

const BUTTON_MAX_W = 200;
const BUTTON_MAX_H = 60;
const BUTTON_MIN_BG_SAT = 0.15;
const BUTTON_MAX_PAGE_W_RATIO = 0.95;
const BUTTON_MAX_PAGE_H_RATIO = 0.09;
const TEXT_REGION_MIN_IOU = 0.5;
const TITLE_TOP_RATIO = 0.15;
const TITLE_CENTER_TOLERANCE = 0.18;
const LABEL_LEFT_RATIO = 0.3;
const LABEL_TOP_EXCLUSION_RATIO = 0.12;
const LABEL_MAX_TEXT = 12;
const LABEL_MAX_GAP_RATIO = 0.2;
const LABEL_MIN_VERTICAL_OVERLAP = 0.5;

const BUTTON_REGION_TYPES: ReadonlySet<ComponentType> = new Set([
  'container',
  'unknown',
  'footer',
  'navbar',
  'card',
  'section',
]);

const TEXT_REGION_TYPES: ReadonlySet<ComponentType> = new Set([
  'container',
  'unknown',
  'header',
  'footer',
  'navbar',
  'card',
  'section',
]);

const BUTTON_ACTION_TEXT = /^(?:保存|取消|确定|提交|关闭|新增(?:地址)?|删除|编辑|查询|搜索|筛选|登录|注册|添加|修改|确认|返回|下一步|上一步|下载|导出|导入|刷新|重置|兑换|使用|立即使用|去使用|领取|购买|支付|完成|继续|save|cancel|submit|close|add|delete|edit|search|filter|login|register|confirm|back|next|download|export|import|refresh|reset|redeem|use|buy|pay|continue)$/i;

function hexToRgbLocal(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b };
}

function styleBgSaturation(node: ASTNode): number {
  const style = node.props.style as { backgroundColor?: unknown } | undefined;
  const bg = style?.backgroundColor;
  if (typeof bg !== 'string') return 0;
  const rgb = hexToRgbLocal(bg);
  if (rgb === null) return 0;
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  return max === 0 ? 0 : (max - min) / max;
}

function bboxArea(bbox: BBox): number {
  return Math.max(0, bbox.w) * Math.max(0, bbox.h);
}

function bboxIou(a: BBox, b: BBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = bboxArea(a) + bboxArea(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function hasMatchingTightOcr(node: ASTNode, ocr: VisionOcrItem[] | undefined): boolean {
  if (!hasText(node) || ocr === undefined) return false;
  const text = normalizeText(node.text!);
  return ocr.some((item) => (
    normalizeText(item.text) === text && bboxIou(node.bbox, item.bbox) >= TEXT_REGION_MIN_IOU
  ));
}

function buttonSizeKind(node: ASTNode, page: BBox): 'absolute' | 'relative' | null {
  if (node.bbox.w <= 0 || node.bbox.h <= 0) return null;
  const absoluteSmall = node.bbox.w < BUTTON_MAX_W && node.bbox.h < BUTTON_MAX_H;
  if (absoluteSmall) return 'absolute';
  const pageRelative = page.w > 0 && page.h > 0
    && node.bbox.w <= page.w * BUTTON_MAX_PAGE_W_RATIO
    && node.bbox.h <= page.h * BUTTON_MAX_PAGE_H_RATIO;
  return pageRelative ? 'relative' : null;
}

function isActionText(node: ASTNode): boolean {
  return hasText(node) && BUTTON_ACTION_TEXT.test(node.text!.trim());
}

function promoteTopTitle(ast: SemanticAST): void {
  const root = ast.root;
  if (root.bbox.w <= 0 || root.bbox.h <= 0) return;
  const pageCenter = root.bbox.x + root.bbox.w / 2;
  let best: ASTNode | undefined;
  let bestDistance = Infinity;
  const walk = (node: ASTNode): void => {
    if ((node.type === 'text' || node.type === 'title' || node.type === 'subtitle') && hasText(node)) {
      const relativeTop = (node.bbox.y - root.bbox.y) / root.bbox.h;
      const center = node.bbox.x + node.bbox.w / 2;
      const distance = Math.abs(center - pageCenter) / root.bbox.w;
      if (
        relativeTop >= 0
        && relativeTop <= TITLE_TOP_RATIO
        && distance <= TITLE_CENTER_TOLERANCE
        && distance < bestDistance
      ) {
        best = node;
        bestDistance = distance;
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  if (best !== undefined) best.type = 'title';
}

function verticalOverlapRatio(a: BBox, b: BBox): number {
  const overlap = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const smallerHeight = Math.min(a.h, b.h);
  return smallerHeight > 0 ? overlap / smallerHeight : 0;
}

function markSemanticLabels(ast: SemanticAST): void {
  const root = ast.root;
  if (root.bbox.w <= 0 || root.bbox.h <= 0) return;
  const markWithin = (parent: ASTNode): void => {
    const textChildren = parent.children.filter((child) => (
      (child.type === 'text' || child.type === 'title' || child.type === 'subtitle') && hasText(child)
    ));
    for (const candidate of textChildren) {
      const relativeX = (candidate.bbox.x - root.bbox.x) / root.bbox.w;
      const relativeY = (candidate.bbox.y - root.bbox.y) / root.bbox.h;
      if (
        relativeX > LABEL_LEFT_RATIO
        || relativeY < LABEL_TOP_EXCLUSION_RATIO
        || textLen(candidate) > LABEL_MAX_TEXT
      ) continue;
      const rightEdge = candidate.bbox.x + candidate.bbox.w;
      const hasValue = textChildren.some((other) => (
        other !== candidate
        && other.bbox.x >= rightEdge
        && other.bbox.x - rightEdge <= root.bbox.w * LABEL_MAX_GAP_RATIO
        && verticalOverlapRatio(candidate.bbox, other.bbox) >= LABEL_MIN_VERTICAL_OVERLAP
      ));
      if (hasValue) {
        candidate.type = 'text';
        candidate.props.semanticRole = 'label';
      }
    }
    for (const child of parent.children) markWithin(child);
  };
  markWithin(root);
}

/**
 * Correct common legacy-detector mis-classifications revealed by real-image
 * validation:
 *   - a `table` whose children are mostly cards is a card list, not a table;
 *   - a compact saturated leaf is a button. Fixed-size generic candidates are
 *     retained for compatibility; OCR action text enables page-relative
 *     candidates such as a full-width mobile footer CTA;
 *   - a text-bearing legacy region whose bbox tightly matches its OCR bbox is
 *     a text node, not a structural navbar/footer/card.
 * Runs before the promotion passes so the corrected types are stable.
 */
function correctMisclassified(
  ast: SemanticAST,
  ocr: VisionOcrItem[] | undefined,
  detectComponent: boolean,
): void {
  const page = ast.root.bbox;
  const walk = (node: ASTNode): void => {
    if (detectComponent && node.type === 'table') {
      const cards = node.children.filter((c) => c.type === 'card');
      if (cards.length >= 2) {
        node.type = 'list';
        for (const c of cards) c.type = 'listItem';
      }
    }
    if (detectComponent && BUTTON_REGION_TYPES.has(node.type) && node.children.length === 0) {
      const generic = node.type === 'container' || node.type === 'unknown';
      const sizeKind = buttonSizeKind(node, page);
      if (
        styleBgSaturation(node) > BUTTON_MIN_BG_SAT
        && sizeKind !== null
        && ((sizeKind === 'absolute' && generic) || (sizeKind === 'relative' && isActionText(node)))
      ) {
        node.type = 'button';
      }
    }
    if (
      node.children.length === 0
      && TEXT_REGION_TYPES.has(node.type)
      && hasMatchingTightOcr(node, ocr)
    ) {
      node.type = 'text';
    }
    for (const c of node.children) walk(c);
  };
  walk(ast.root);
}

/**
 * Enrich a {@link SemanticAST} in place: promote generic component types
 * to specific ones (list / listItem / divider / progress / textarea /
 * tag / toolbar / iconButton / title / subtitle) and layer text nodes into
 * title / subtitle / text by font-size. A trailing second pass promotes
 * generic containers to row / column / grid by child arrangement, numeric
 * or tiny tags to badge, and inputs near select-like OCR text (or with a
 * right-side icon/avatar sibling) to select. Pure, deterministic, no IO.
 *
 * @param ast   the SemanticAST to enrich in place.
 * @param ocr   optional OCR items; enables the input->select rule. When
 *              omitted the select-by-OCR rule is skipped (backward
 *              compatible; existing call sites that pass no OCR behave
 *              exactly as before).
 */
/**
 * Drop nodes whose bbox lies entirely outside the page (root) bbox - these are
 * stray false detections the legacy detector occasionally emits beyond the
 * image bounds. A node is pruned when it does not intersect the page at all.
 */
function pruneOutOfBounds(ast: SemanticAST): void {
  const px0 = ast.root.bbox.x;
  const py0 = ast.root.bbox.y;
  const px1 = ast.root.bbox.x + ast.root.bbox.w;
  const py1 = ast.root.bbox.y + ast.root.bbox.h;
  const prune = (node: ASTNode): void => {
    node.children = node.children.filter((c) => {
      const cx1 = c.bbox.x + c.bbox.w;
      const cy1 = c.bbox.y + c.bbox.h;
      const intersects = c.bbox.x < px1 && cx1 > px0 && c.bbox.y < py1 && cy1 > py0;
      return intersects;
    });
    for (const c of node.children) prune(c);
  };
  prune(ast.root);
}

export interface EnrichNodeTypeOptions {
  detectComponent?: boolean;
}

export function enrichNodeTypes(
  ast: SemanticAST,
  ocr?: VisionOcrItem[],
  options?: EnrichNodeTypeOptions,
): void {
  const detectComponent = options?.detectComponent !== false;
  correctMisclassified(ast, ocr, detectComponent);
  if (detectComponent) enrich(ast.root);
  hierarchizeText(ast);
  promoteTopTitle(ast);
  markSemanticLabels(ast);
  enrichExtra(ast.root, ocr, detectComponent);
  pruneOutOfBounds(ast);
}
