/**
 * Variant Engine - infers the per-component variant (primary / danger / ...)
 * and state (default / active / disabled / selected) for AST nodes by
 * inspecting node props (color / fill / state / variant) and bound text.
 *
 * Button variants are derived from color proximity to the theme primary (RGB
 * Euclidean distance) and red/green hue heuristics. State keywords are matched
 * against the node text; only button / checkbox / radio / tab carry inferred
 * state. Pure, deterministic, no IO, no model.
 *
 * @see src/ui-analysis/ir/types.ts  (SemanticAST / ASTNode / LayoutTheme)
 */
import type {
  SemanticAST,
  ASTNode,
  ComponentType,
  LayoutTheme,
} from '../ir/types.js';

export type Variant =
  | 'primary'
  | 'secondary'
  | 'success'
  | 'danger'
  | 'ghost'
  | 'default';

export type VariantState = 'default' | 'active' | 'disabled' | 'selected';

export interface VariantInfo {
  nodeId: string;
  type: ComponentType;
  variant: Variant;
  state: VariantState;
  reason: string;
}

const COLOR_MATCH_THRESHOLD = 48;

const STATEFUL_TYPES = new Set<ComponentType>(['button', 'checkbox', 'radio', 'tab']);

const DISABLED_KEYWORDS = ['已禁用', '禁用', 'disabled', '不可用', '不可点击'];
const SELECTED_KEYWORDS = ['已选', '选中', 'selected', 'active', '已激活', '当前'];

const VARIANT_ORDER: Variant[] = [
  'primary', 'secondary', 'success', 'danger', 'ghost', 'default',
];

const STATE_VALUES: VariantState[] = ['default', 'active', 'disabled', 'selected'];

function isVariant(value: string): value is Variant {
  return (VARIANT_ORDER as string[]).includes(value);
}

function isVariantState(value: string): value is VariantState {
  return (STATE_VALUES as string[]).includes(value);
}

/** Parse a #rgb / #rrggbb hex string into RGB channels; null if malformed. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}

/** RGB Euclidean distance between two hex colors; Infinity if either is invalid. */
export function hexDistance(a: string, b: string): number {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return Infinity;
  const dr = ra.r - rb.r;
  const dg = ra.g - rb.g;
  const db = ra.b - rb.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function isReddish(rgb: { r: number; g: number; b: number }): boolean {
  return rgb.r >= 140 && rgb.r - rgb.g >= 50 && rgb.r - rgb.b >= 50;
}

function isGreenish(rgb: { r: number; g: number; b: number }): boolean {
  return rgb.g >= 120 && rgb.g - rgb.r >= 40 && rgb.g - rgb.b >= 40;
}

function nodeColorHex(node: ASTNode): string | null {
  const raw = node.props.color ?? node.props.fill ?? node.props.bgColor ?? node.props.background;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(trimmed)) {
    return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  }
  return null;
}

function textMatches(text: string, keywords: string[]): boolean {
  if (text.length === 0) return false;
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

function inferVariant(node: ASTNode, theme: LayoutTheme | undefined): { variant: Variant; reason: string } {
  if (node.type !== 'button') {
    return { variant: 'default', reason: 'non-button type' };
  }
  const hex = nodeColorHex(node);
  if (hex === null) {
    const pv = node.props.variant;
    if (typeof pv === 'string' && isVariant(pv)) {
      return { variant: pv, reason: `props:variant=${pv}` };
    }
    return { variant: 'default', reason: 'no color signal' };
  }
  if (theme !== undefined && theme.primary.length > 0) {
    const dist = hexDistance(hex, theme.primary);
    if (dist < COLOR_MATCH_THRESHOLD) {
      return { variant: 'primary', reason: `color~primary(${Math.round(dist)})` };
    }
  }
  const rgb = hexToRgb(hex);
  if (rgb !== null && isReddish(rgb)) return { variant: 'danger', reason: 'color:red-ish' };
  if (rgb !== null && isGreenish(rgb)) return { variant: 'success', reason: 'color:green-ish' };
  const pv = node.props.variant;
  if (typeof pv === 'string' && isVariant(pv)) {
    return { variant: pv, reason: `props:variant=${pv}` };
  }
  return { variant: 'default', reason: 'color:other' };
}

function inferState(node: ASTNode): { state: VariantState; reason: string } {
  if (!STATEFUL_TYPES.has(node.type)) {
    return { state: 'default', reason: 'non-stateful type' };
  }
  const ps = node.props.state;
  if (typeof ps === 'string' && isVariantState(ps)) {
    return { state: ps, reason: `props:state=${ps}` };
  }
  const text = node.text ?? '';
  if (textMatches(text, DISABLED_KEYWORDS)) {
    return { state: 'disabled', reason: 'text:disabled' };
  }
  if (textMatches(text, SELECTED_KEYWORDS)) {
    return { state: 'selected', reason: 'text:selected' };
  }
  return { state: 'default', reason: 'no state signal' };
}

/**
 * Walk the SemanticAST and emit a VariantInfo for every node. Button variants
 * are derived from color / theme.primary proximity and hue; state is inferred
 * only for button / checkbox / radio / tab via props.state or text keywords.
 */
export function inferVariants(ast: SemanticAST, theme?: LayoutTheme): VariantInfo[] {
  const out: VariantInfo[] = [];
  const walk = (node: ASTNode): void => {
    const v = inferVariant(node, theme);
    const s = inferState(node);
    out.push({
      nodeId: node.id,
      type: node.type,
      variant: v.variant,
      state: s.state,
      reason: `${v.reason}; ${s.reason}`,
    });
    for (const child of node.children) walk(child);
  };
  walk(ast.root);
  return out;
}
