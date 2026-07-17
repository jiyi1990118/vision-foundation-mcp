/**
 * Barrel export for the UI analysis plugin layer.
 *
 * @see ./types.ts for the Trait interfaces
 */
export type {
  AstBuilder,
  Detector,
  Exporter,
  LayoutEngine,
  OcrEngine,
  Segmenter,
} from './types.js';
export { UiLayoutLayoutEngine, visionOcrItemsToOcrItems } from './layout-engine-adapter.js';
export { UiLayoutDetector } from './detector-adapter.js';
export { PaddleOcrEngine, parseOcrTextToItems } from './ocr-engine-adapter.js';
