/**
 * Four-layer Intermediate Representation (IR) contract for the Vision UI
 * analysis engine.
 *
 * Layers (each builds on the previous, never rewrites lower layers):
 *   1. VisionIR     - raw detection facts (boxes, OCR, masks, color samples)
 *   2. LayoutIR     - geometric layout (regions, layoutType, spacing, theme)
 *   3. SemanticAST  - hierarchical component tree (parent/children semantics)
 *   4. CodegenIR    - framework-agnostic renderable description
 *
 * Field naming is aligned with the existing extractors:
 *   - `bbox` uses `{ x, y, w, h }`
 *   - `layoutType` reuses the existing 6-value enum
 *
 * @see src/core/extractors/ui-layout-extractor.ts  (LayoutIR source of truth)
 * @see src/core/extractors/design-extractor.ts     (theme source of truth)
 * @see 方案/02-开发实施方案.md  Stream S0
 */

// Re-export the existing VisualRegion shape so LayoutIR.regions stays
// structurally identical to what ui-layout-extractor produces (no drift).
// Imported for local use (LayoutIR.regions) and re-exported for downstream
// engines that consume the IR module as a single entry point.
import type { VisualRegion } from '../../core/extractors/ui-layout-extractor.js';
export type { VisualRegion };

// ── 1. BBox ──

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── 2. VisionIR ──

export interface VisionDetection {
  type: string;
  bbox: BBox;
  score: number;
  text?: string;
  state?: 'default' | 'active' | 'selected' | 'disabled';
  variant?: 'primary' | 'secondary' | 'success' | 'danger' | 'ghost' | 'default';
}

export interface VisionOcrItem {
  text: string;
  bbox: BBox;
  confidence: number;
}

export interface VisionMask {
  id: string;
  bbox: BBox;
  area: number;
}

export interface VisionColorSample {
  hex: string;
  role: string;
  frequency: number;
}

export interface VisionIR {
  detections: VisionDetection[];
  ocr: VisionOcrItem[];
  masks?: VisionMask[];
  colorSamples?: VisionColorSample[];
}

// ── 3. LayoutIR ──

export type LayoutType =
  | 'grid'
  | 'columns'
  | 'sidebar'
  | 'centered'
  | 'split-pane'
  | 'stack';

export interface LayoutSpacing {
  averageGap: number;
  scale: 'compact' | 'comfortable' | 'spacious';
  verticalGaps: number[];
  horizontalGaps: number[];
}

export interface LayoutPaletteEntry {
  hex: string;
  rgb: [number, number, number];
  role: string;
  frequency: number;
}

export interface LayoutTheme {
  palette: LayoutPaletteEntry[];
  background: string;
  primary: string;
  textColor: string;
  isDarkMode: boolean;
  contrastRatio: number;
}

export interface LayoutIR {
  regions: VisualRegion[];
  layoutType: LayoutType;
  spacing: LayoutSpacing;
  theme?: LayoutTheme;
}

// ── 4. ComponentType (30+ type union, superset of the legacy 11) ──

export type ComponentType =
  | 'page'
  | 'container'
  | 'header'
  | 'footer'
  | 'navbar'
  | 'sidebar'
  | 'toolbar'
  | 'card'
  | 'section'
  | 'list'
  | 'listItem'
  | 'table'
  | 'row'
  | 'column'
  | 'grid'
  | 'button'
  | 'iconButton'
  | 'text'
  | 'title'
  | 'subtitle'
  | 'input'
  | 'textarea'
  | 'checkbox'
  | 'radio'
  | 'switch'
  | 'select'
  | 'dropdown'
  | 'image'
  | 'avatar'
  | 'icon'
  | 'divider'
  | 'progress'
  | 'badge'
  | 'tag'
  | 'tab'
  | 'dialog'
  | 'drawer'
  | 'bottomSheet'
  | 'unknown';

// ── 5. ASTNode ──

export interface ASTNode {
  id: string;
  type: ComponentType;
  bbox: BBox;
  props: Record<string, unknown>;
  text?: string;
  children: ASTNode[];
}

// ── 6. SemanticAST ──

export interface SemanticAST {
  root: ASTNode;
  version: string;
}

// ── 7. CodegenIR ──

export interface CodegenNode {
  id: string;
  type: ComponentType;
  bbox: BBox;
  props: Record<string, unknown>;
  text?: string;
  children: CodegenNode[];
}

export interface CodegenConstraint {
  targetId: string;
  direction?: 'row' | 'column' | 'grid';
  gap?: number;
  align?: string;
}

export interface CodegenResponsiveRule {
  breakpoint: string;
  layout: string;
}

export interface CodegenSlot {
  id: string;
  name: string;
}

export interface CodegenRepeat {
  targetId: string;
  count: number;
  /** id of the first child in the isomorphic group - the reusable template. */
  templateId?: string;
  /** type of the template child; drives the slot name. */
  templateType?: ComponentType;
}

export interface CodegenIR {
  root: CodegenNode;
  constraints: CodegenConstraint[];
  responsive?: CodegenResponsiveRule[];
  slots: CodegenSlot[];
  repeats: CodegenRepeat[];
}

// ── 8. NodeStyle (Stream S11 - per-component visual style) ──

/**
 * Per-node visual style sampled from the source image pixels within the
 * node's bbox. All color fields are lowercase `#rrggbb` hex strings.
 *
 * Background/border apply to any node; the text fields are populated only
 * for text-bearing nodes (node.text set or node.type === 'text').
 *
 * `borderRadius` and `boxShadow` (Stream S18) are best-effort pixel
 * heuristics: `borderRadius` is non-zero only when a rounded corner cutout
 * is detected at one of the bbox corners; `boxShadow` is emitted only when
 * a strong dark band is found in the ring just outside the bbox. Both are
 * omitted (not set to a placeholder) when the signal is absent so that
 * downstream agents do not receive fake values.
 */
export interface GradientStop {
  offset: number;
  color: string;
}

export interface GradientInfo {
  type: 'linear' | 'radial';
  direction?: string;
  stops: GradientStop[];
}

export interface PaddingInfo {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface NodeStyle {
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderStyle?: 'solid' | 'dashed' | 'dotted' | 'none';
  textColor?: string;
  fontSize?: number;
  fontWeight?: number | string;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  textDecoration?: 'none' | 'underline' | 'line-through';
  borderRadius?: number;
  boxShadow?: string;
  gradient?: GradientInfo;
  padding?: PaddingInfo;
  opacity?: number;
}

/**
 * A decoded raw image buffer shared across pixel-sampling engines to avoid
 * re-decoding the same source image. Produced by `decodeRawImage`; consumed
 * by the style extractor / media-area filter / overlay detector so the
 * orchestrator decodes once and threads the buffer through.
 */
export interface DecodedImage {
  data: Buffer;
  width: number;
  height: number;
  stride: number;
}
