/**
 * Interactivity Enricher (Stream S28, G-C2) - infers component interaction
 * state (input placeholder, button disabled, text link) from the already-
 * sampled `node.props.style` ({@link NodeStyle}) and writes the result onto
 * `node.props.interactive`. No image decode: it purely reuses the style
 * fields injected by {@link ../style/style-extractor.js} and the node
 * type/text finalized by {@link ../typing/type-enricher.js}.
 *
 * Heuristics (best-effort, deterministic):
 *   - placeholder: input/textarea/select with non-empty text whose sampled
 *     textColor is a light gray (luminance >= threshold) - the classic
 *     placeholder tint.
 *   - disabled: button/iconButton whose backgroundColor is a desaturated
 *     mid-gray (low saturation + mid luminance band) - disabled controls
 *     lose their brand color.
 *   - link: text/title/subtitle whose textColor is blue-dominant - links are
 *     conventionally blue.
 *
 * `node.props.interactive` is set only when at least one state is detected;
 * nodes with no style or no matching signal are left untouched (additive:
 * never mutates style / type / text / bbox / children).
 *
 * @see ../ir/types.js                       (ASTNode, NodeStyle, ComponentType)
 * @see ../style/style-extractor.js          (style injection, luminance convention)
 * @see ../orchestrator.js                   (invocation site, after enrichNodeTypes)
 */
import type {
  SemanticAST,
  ASTNode,
  NodeStyle,
  ComponentType,
} from '../ir/types.js';

/**
 * Inferred interaction state for a node. Each field is set only when the
 * corresponding heuristic fires; an absent field means "not detected".
 */
export interface Interactivity {
  placeholder?: boolean;
  disabled?: boolean;
  link?: boolean;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

const PLACEHOLDER_LUMINANCE = 140;
const DISABLED_MAX_SATURATION = 0.15;
const DISABLED_MIN_LUMINANCE = 80;
const DISABLED_MAX_LUMINANCE = 200;
const LINK_BLUE_DELTA = 20;

const PLACEHOLDER_TYPES: ReadonlySet<ComponentType> = new Set([
  'input',
  'textarea',
  'select',
]);

const DISABLED_TYPES: ReadonlySet<ComponentType> = new Set([
  'button',
  'iconButton',
]);

const LINK_TYPES: ReadonlySet<ComponentType> = new Set([
  'text',
  'title',
  'subtitle',
]);

function hexToRgb(hex: string | undefined): RGB | null {
  if (hex === undefined) return null;
  const body = hex.trim();
  const stripped = body.startsWith('#') ? body.slice(1) : body;
  if (!/^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(stripped)) return null;
  let r: number;
  let g: number;
  let b: number;
  if (stripped.length === 3) {
    r = parseInt(stripped.charAt(0) + stripped.charAt(0), 16);
    g = parseInt(stripped.charAt(1) + stripped.charAt(1), 16);
    b = parseInt(stripped.charAt(2) + stripped.charAt(2), 16);
  } else {
    r = parseInt(stripped.slice(0, 2), 16);
    g = parseInt(stripped.slice(2, 4), 16);
    b = parseInt(stripped.slice(4, 6), 16);
  }
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}

function luminance(rgb: RGB): number {
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
}

function saturation(rgb: RGB): number {
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  if (max === 0) return 0;
  return (max - min) / max;
}

function readStyle(node: ASTNode): NodeStyle | null {
  const s = node.props.style;
  if (s === undefined || typeof s !== 'object' || s === null) return null;
  return s as NodeStyle;
}

function hasText(node: ASTNode): boolean {
  return node.text !== undefined && node.text.trim().length > 0;
}

function detectPlaceholder(node: ASTNode, style: NodeStyle): boolean {
  if (!PLACEHOLDER_TYPES.has(node.type)) return false;
  if (!hasText(node)) return false;
  const rgb = hexToRgb(style.textColor);
  if (rgb === null) return false;
  return luminance(rgb) >= PLACEHOLDER_LUMINANCE;
}

function detectDisabled(node: ASTNode, style: NodeStyle): boolean {
  if (!DISABLED_TYPES.has(node.type)) return false;
  const rgb = hexToRgb(style.backgroundColor);
  if (rgb === null) return false;
  const lum = luminance(rgb);
  if (lum < DISABLED_MIN_LUMINANCE || lum > DISABLED_MAX_LUMINANCE) return false;
  return saturation(rgb) < DISABLED_MAX_SATURATION;
}

function detectLink(node: ASTNode, style: NodeStyle): boolean {
  if (!LINK_TYPES.has(node.type)) return false;
  if (!hasText(node)) return false;
  const rgb = hexToRgb(style.textColor);
  if (rgb === null) return false;
  return rgb.b > rgb.r + LINK_BLUE_DELTA && rgb.b > rgb.g + LINK_BLUE_DELTA;
}

function enrichNode(node: ASTNode): void {
  const style = readStyle(node);
  if (style === null) return;
  const placeholder = detectPlaceholder(node, style);
  const disabled = detectDisabled(node, style);
  const link = detectLink(node, style);
  if (!placeholder && !disabled && !link) return;
  const interactive: Interactivity = {};
  if (placeholder) interactive.placeholder = true;
  if (disabled) interactive.disabled = true;
  if (link) interactive.link = true;
  node.props.interactive = interactive;
}

function walk(node: ASTNode): void {
  enrichNode(node);
  for (const child of node.children) walk(child);
}

/**
 * Walk the {@link SemanticAST} in place and attach `node.props.interactive`
 * ({@link Interactivity}) to each node whose sampled style + type + text
 * match an interaction-state heuristic. Nodes without a sampled style, or
 * with no matching signal, are left untouched. Pure, deterministic, no IO.
 */
export function enrichInteractivity(ast: SemanticAST): void {
  walk(ast.root);
}
