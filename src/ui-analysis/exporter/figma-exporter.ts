/**
 * Figma Exporter - converts a SemanticAST into a Figma REST-API shaped
 * JSON document. Pure, deterministic, no IO, no model calls.
 *
 * Aligns with the field structure documented in `方案/调研-note.md`
 * (Tables A-E): nodes carry `id` / `name` / `type` / `absoluteBoundingBox`
 * / `fills` / `children`; FRAME nodes carry auto-layout fields
 * (`layoutMode` / `itemSpacing` / axis alignment); TEXT nodes carry
 * `characters` + nested `style`.
 *
 * Node-type mapping (per S3 spec, see 调研-note.md 表 A):
 *   - container-like AST types      -> FRAME
 *   - text-like (text/title/        -> TEXT (characters from `text`)
 *     subtitle/button/badge/tag)
 *   - rectangle-like (image/divider/-> RECTANGLE
 *     progress/input/textarea/select/dropdown)
 *
 * Gotcha honoured: Figma color channels are 0-1 floats, never 0-255.
 * Any `props.color` / `props.background` value (hex string or 0-255 rgb
 * array) is normalized to the 0-1 range before emission.
 *
 * @see src/ui-analysis/ir/types.ts
 * @see src/ui-analysis/constraint/constraint-engine.ts  (direction/gap source)
 * @see src/ui-analysis/plugin/types.ts  (Exporter trait)
 * @see 方案/调研-note.md  (Figma JSON field spec, Tables A-E)
 */
import type { Exporter } from '../plugin/types.js';
import type {
  ASTNode,
  BBox,
  CodegenConstraint,
  ComponentType,
  SemanticAST,
} from '../ir/types.js';
import { inferConstraints } from '../constraint/constraint-engine.js';

// ── Figma JSON types (REST-API shaped) ──

export interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface FigmaSolidPaint {
  type: 'SOLID';
  color: FigmaColor;
  opacity: number;
  visible: boolean;
}

export type FigmaPaint = FigmaSolidPaint;

export interface FigmaBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FigmaLayoutMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL';

export type FigmaAlignItems = 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN' | 'BASELINE';

export type FigmaNodeType = 'FRAME' | 'TEXT' | 'RECTANGLE';

export interface FigmaTextStyle {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  textAlignHorizontal?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  lineHeightPx?: number;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: FigmaNodeType;
  visible: boolean;
  absoluteBoundingBox: FigmaBoundingBox | null;
  fills: FigmaPaint[];
  cornerRadius?: number;
  layoutMode?: FigmaLayoutMode;
  itemSpacing?: number;
  primaryAxisAlignItems?: FigmaAlignItems;
  counterAxisAlignItems?: FigmaAlignItems;
  characters?: string;
  style?: FigmaTextStyle;
  children?: FigmaNode[];
}

export interface FigmaDocument {
  document: FigmaNode;
  version: string;
}

// ── AST type -> Figma node type ──

const TEXT_TYPES: ReadonlySet<ComponentType> = new Set<ComponentType>([
  'text',
  'title',
  'subtitle',
  'button',
  'badge',
  'tag',
]);

const RECTANGLE_TYPES: ReadonlySet<ComponentType> = new Set<ComponentType>([
  'image',
  'divider',
  'progress',
  'input',
  'textarea',
  'select',
  'dropdown',
]);

function figmaNodeType(type: ComponentType): FigmaNodeType {
  if (TEXT_TYPES.has(type)) return 'TEXT';
  if (RECTANGLE_TYPES.has(type)) return 'RECTANGLE';
  return 'FRAME';
}

// ── prop helpers ──

function numProp(props: Record<string, unknown>, key: string): number | undefined {
  const v = props[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : undefined;
}

function strProp(props: Record<string, unknown>, key: string): string | undefined {
  const v = props[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function styleProps(props: Record<string, unknown>): Record<string, unknown> {
  const style = props['style'];
  return typeof style === 'object' && style !== null && !Array.isArray(style)
    ? style as Record<string, unknown>
    : {};
}

function resolvedNumProp(props: Record<string, unknown>, key: string): number | undefined {
  return numProp(props, key) ?? numProp(styleProps(props), key);
}

function resolvedStrProp(props: Record<string, unknown>, key: string): string | undefined {
  return strProp(props, key) ?? strProp(styleProps(props), key);
}

// ── color normalization (0-1 float, Figma gotcha) ──

function toFigmaColor(input: unknown): FigmaColor | null {
  if (typeof input === 'string') {
    let hex = input.trim().replace(/^#/, '');
    if (hex.length === 3) {
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;
      if ([r, g, b, a].every((n) => !Number.isNaN(n))) {
        return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
      }
    }
    return null;
  }
  if (Array.isArray(input) && input.length >= 3) {
    const r = input[0];
    const g = input[1];
    const b = input[2];
    const a = input[3];
    if (typeof r === 'number' && typeof g === 'number' && typeof b === 'number') {
      const max = Math.max(r, g, b);
      const scale = max > 1 ? 255 : 1;
      const alpha = typeof a === 'number' ? a : 1;
      const normA = scale === 255 && alpha > 1 ? alpha / 255 : alpha;
      return { r: r / scale, g: g / scale, b: b / scale, a: normA };
    }
  }
  return null;
}

function resolveFills(props: Record<string, unknown>, textNode: boolean): FigmaPaint[] {
  const sampled = styleProps(props);
  const c = textNode
    ? toFigmaColor(props['color'])
      ?? toFigmaColor(sampled['textColor'])
      ?? toFigmaColor(props['background'])
      ?? toFigmaColor(sampled['backgroundColor'])
    : toFigmaColor(props['color'])
      ?? toFigmaColor(props['background'])
      ?? toFigmaColor(sampled['backgroundColor']);
  if (!c) return [];
  return [{ type: 'SOLID', color: c, opacity: 1, visible: true }];
}

function buildTextStyle(props: Record<string, unknown>): FigmaTextStyle | null {
  const style: FigmaTextStyle = {};
  const ff = resolvedStrProp(props, 'fontFamily');
  if (ff) style.fontFamily = ff;
  const fw = resolvedNumProp(props, 'fontWeight');
  if (fw !== undefined) style.fontWeight = fw;
  const fs = resolvedNumProp(props, 'fontSize');
  if (fs !== undefined) style.fontSize = fs;
  const ta = resolvedStrProp(props, 'textAlign');
  if (ta === 'left') style.textAlignHorizontal = 'LEFT';
  else if (ta === 'center') style.textAlignHorizontal = 'CENTER';
  else if (ta === 'right') style.textAlignHorizontal = 'RIGHT';
  else if (ta === 'justify') style.textAlignHorizontal = 'JUSTIFIED';
  const lh = resolvedNumProp(props, 'lineHeight');
  if (lh !== undefined) style.lineHeightPx = lh;
  return Object.keys(style).length > 0 ? style : null;
}

// ── bbox ──

function toBoundingBox(b: BBox): FigmaBoundingBox {
  return { x: b.x, y: b.y, width: b.w, height: b.h };
}

function layoutModeFromConstraint(ct: CodegenConstraint | undefined): FigmaLayoutMode {
  if (ct?.direction === 'row') return 'HORIZONTAL';
  if (ct?.direction === 'column') return 'VERTICAL';
  if (ct?.direction === 'grid') return 'NONE';
  return 'VERTICAL';
}

// ── ASTNode -> FigmaNode ──

function toFigmaNode(node: ASTNode, cmap: Map<string, CodegenConstraint>): FigmaNode {
  const ftype = figmaNodeType(node.type);
  const fills = resolveFills(node.props, ftype === 'TEXT');
  const cornerRadius = resolvedNumProp(node.props, 'borderRadius') ?? resolvedNumProp(node.props, 'radius');

  const figma: FigmaNode = {
    id: node.id,
    name: node.type,
    type: ftype,
    visible: true,
    absoluteBoundingBox: toBoundingBox(node.bbox),
    fills,
    ...(cornerRadius !== undefined ? { cornerRadius } : {}),
  };

  if (ftype === 'FRAME') {
    const children = node.children.map((c) => toFigmaNode(c, cmap));
    figma.children = children;
    if (children.length > 0) {
      const ct = cmap.get(node.id);
      figma.layoutMode = layoutModeFromConstraint(ct);
      const gapProp = numProp(node.props, 'gap');
      figma.itemSpacing = gapProp !== undefined ? gapProp : (ct?.gap ?? 0);
      figma.primaryAxisAlignItems = 'MIN';
      figma.counterAxisAlignItems = 'MIN';
    }
  } else if (ftype === 'TEXT') {
    figma.characters = node.text ?? '';
    const style = buildTextStyle(node.props);
    if (style) figma.style = style;
  }

  return figma;
}

/** Convert a SemanticAST into a Figma REST-API shaped document. */
export function toFigmaDocument(ast: SemanticAST): FigmaDocument {
  const constraints = inferConstraints(ast);
  const cmap = new Map<string, CodegenConstraint>();
  for (const c of constraints) cmap.set(c.targetId, c);
  return {
    document: toFigmaNode(ast.root, cmap),
    version: ast.version,
  };
}

/** Exporter trait implementation: SemanticAST -> Figma JSON document. */
export class FigmaExporter implements Exporter {
  readonly format = 'figma-json';
  export(ast: SemanticAST): FigmaDocument {
    return toFigmaDocument(ast);
  }
}
