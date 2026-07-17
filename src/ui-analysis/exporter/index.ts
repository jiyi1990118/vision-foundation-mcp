/**
 * Barrel export for the UI analysis exporter layer.
 *
 * @see ./codegen-exporter.ts
 * @see ./figma-exporter.ts
 * @see ./markdown-exporter.ts
 */
export { CodegenExporter, toCodegenIr } from './codegen-exporter.js';
export { FigmaExporter, toFigmaDocument } from './figma-exporter.js';
export type {
  FigmaAlignItems,
  FigmaBoundingBox,
  FigmaColor,
  FigmaDocument,
  FigmaLayoutMode,
  FigmaNode,
  FigmaNodeType,
  FigmaPaint,
  FigmaSolidPaint,
  FigmaTextStyle,
} from './figma-exporter.js';
export { MarkdownExporter, toMarkdown } from './markdown-exporter.js';
