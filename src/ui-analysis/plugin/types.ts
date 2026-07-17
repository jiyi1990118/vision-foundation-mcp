/**
 * Unified Trait interfaces for the Vision UI analysis plugin layer.
 *
 * Each Trait describes a single capability (detection / OCR / segmentation /
 * layout / AST building / export) consumed by the orchestrator. Concrete
 * adapters live in sibling files and compose the existing extractors /
 * providers without modifying them.
 *
 * @see src/ui-analysis/ir/types.ts  (IR contract - frozen by S0)
 * @see src/providers/types.ts       (VisionProvider interface style reference)
 */
import type { ImageInput } from '../../types/domain.js';
import type {
  BBox,
  LayoutIR,
  SemanticAST,
  VisionDetection,
  VisionMask,
  VisionOcrItem,
} from '../ir/types.js';

/** Detects visual components / regions in an image. */
export interface Detector {
  readonly name: string;
  readonly version: string;
  initialize(): Promise<void>;
  detect(image: ImageInput): Promise<VisionDetection[]>;
}

/** Recognizes text lines with bounding boxes. */
export interface OcrEngine {
  readonly name: string;
  recognize(image: ImageInput): Promise<VisionOcrItem[]>;
}

/** Produces pixel-accurate masks for regions or prompted boxes. */
export interface Segmenter {
  segment(image: ImageInput, prompts?: BBox[]): Promise<VisionMask[]>;
}

/** Builds a LayoutIR from detections, OCR, and (optionally) the image. */
export interface LayoutEngine {
  build(detections: VisionDetection[], ocr: VisionOcrItem[], image?: ImageInput): Promise<LayoutIR>;
}

/** Builds a hierarchical SemanticAST from a flat LayoutIR. */
export interface AstBuilder {
  build(layout: LayoutIR): SemanticAST;
}

/** Exports a SemanticAST to a framework-specific representation. */
export interface Exporter {
  readonly format: string;
  export(ast: SemanticAST): unknown;
}
