/**
 * Type Enricher (Stream S23, G-A1+G-A2) - second-pass type promotion on a
 * built {@link SemanticAST}. The ast-builder only maps the legacy 11
 * component types + 8 regions + 3 media, so ~18 ComponentType values
 * (list / listItem / divider / progress / textarea / tag / toolbar /
 * iconButton / title / subtitle ...) are never emitted. This pure
 * post-pass walks the tree post-order (children before parent) and
 * rewrites `node.type` in place via geometric + textual heuristics,
 * surfacing those missing types. It only reads bbox / children / props /
 * text and mutates type; bbox / children / props are never touched.
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

function nearbyOcrMatches(node: ASTNode, ocr: VisionOcrItem[]): boolean {
  const expanded: BBox = {
    x: node.bbox.x - SELECT_NEARBY_PX,
    y: node.bbox.y - SELECT_NEARBY_PX,
    w: node.bbox.w + 2 * SELECT_NEARBY_PX,
    h: node.bbox.h + 2 * SELECT_NEARBY_PX,
  };
  for (const item of ocr) {
    if (!bboxIntersects(expanded, item.bbox)) continue;
    const lower = item.text.toLowerCase();
    for (const kw of SELECT_KEYWORDS) {
      if (lower.includes(kw.toLowerCase())) return true;
    }
  }
  return false;
}

function promoteSelectByOcr(node: ASTNode, ocr: VisionOcrItem[] | undefined): void {
  if (node.type !== 'input') return;
  if (ocr === undefined || ocr.length === 0) return;
  if (nearbyOcrMatches(node, ocr)) node.type = 'select';
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

function enrichExtra(node: ASTNode, ocr: VisionOcrItem[] | undefined): void {
  promoteSelectBySibling(node);
  for (const c of node.children) enrichExtra(c, ocr);
  promoteBadge(node);
  promoteSelectByOcr(node, ocr);
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

/**
 * Correct common legacy-detector mis-classifications revealed by real-image
 * validation:
 *   - a `table` whose children are mostly cards is a card list, not a table;
 *   - a leaf `container`/`unknown` with a saturated background fill and a
 *     small footprint is a button (the legacy detector often emits buttons as
 *     generic containers).
 * Runs before the promotion passes so the corrected types are stable.
 */
function correctMisclassified(ast: SemanticAST): void {
  const walk = (node: ASTNode): void => {
    if (node.type === 'table') {
      const cards = node.children.filter((c) => c.type === 'card');
      if (cards.length >= 2) {
        node.type = 'list';
        for (const c of cards) c.type = 'listItem';
      }
    }
    if ((node.type === 'container' || node.type === 'unknown') && node.children.length === 0) {
      if (
        node.bbox.w < BUTTON_MAX_W &&
        node.bbox.h < BUTTON_MAX_H &&
        styleBgSaturation(node) > BUTTON_MIN_BG_SAT
      ) {
        node.type = 'button';
      }
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

export function enrichNodeTypes(ast: SemanticAST, ocr?: VisionOcrItem[]): void {
  correctMisclassified(ast);
  enrich(ast.root);
  hierarchizeText(ast);
  enrichExtra(ast.root, ocr);
  pruneOutOfBounds(ast);
}
