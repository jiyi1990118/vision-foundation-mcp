import type { UiLayoutExtraction } from '../core/extractors/ui-layout-extractor.js';
import type { DesignExtraction } from '../core/extractors/design-extractor.js';
import type {
  VisionOcrItem,
  VisionIR,
  LayoutIR,
  SemanticAST,
  CodegenIR,
  BBox,
} from './ir/types.js';
import { toVisionIRFromLayout, toLayoutIR } from './ir/mappers.js';
import { buildSemanticAst } from './ast/ast-builder.js';
import { toCodegenIr } from './exporter/codegen-exporter.js';
import { FigmaExporter } from './exporter/figma-exporter.js';
import { MarkdownExporter } from './exporter/markdown-exporter.js';
import { extractImageContents } from './image-content/index.js';
import type { ImageContentInfo } from './image-content/index.js';
import { inferPageType, inferVariants, buildSemanticSummary } from './semantic/index.js';
import type { PageType, VariantInfo } from './semantic/index.js';

export interface UiPipelineOptions {
  buildTree?: boolean;
  exportCodegen?: boolean;
  exportFigma?: boolean;
  exportMarkdown?: boolean;
  useLlm?: boolean;
}

export interface UiPipelineInput {
  uiLayoutExtraction: UiLayoutExtraction;
  designExtraction?: DesignExtraction;
  ocrItems?: VisionOcrItem[] | undefined;
  pageBbox?: BBox | undefined;
  options?: UiPipelineOptions;
}

export interface UiPipelineResult {
  ui?: SemanticAST;
  codegenIr?: CodegenIR;
  figma?: unknown;
  markdown?: string;
  uiSemantics?: {
    pageType: PageType;
    pageTypeConfidence: number;
    pageTypeSignals: string[];
    variants: VariantInfo[];
    summary: string;
  };
  imageContents?: ImageContentInfo[];
}

export function analyzeUiPipeline(input: UiPipelineInput): UiPipelineResult {
  const result: UiPipelineResult = {};
  const opts: UiPipelineOptions = input.options ?? {};
  const buildTree = opts.buildTree !== false;

  let visionIR: VisionIR | undefined;
  try {
    visionIR = toVisionIRFromLayout(input.uiLayoutExtraction);
  } catch {
    visionIR = undefined;
  }

  let layoutIR: LayoutIR | undefined;
  try {
    layoutIR = toLayoutIR(input.uiLayoutExtraction, input.designExtraction);
  } catch {
    layoutIR = undefined;
  }

  const ocr = input.ocrItems ?? visionIR?.ocr;
  let ast: SemanticAST | undefined;
  if (layoutIR) {
    try {
      const detections = visionIR?.detections;
      ast = buildSemanticAst(layoutIR, ocr, detections, input.uiLayoutExtraction.mediaAreas, input.pageBbox);
    } catch {
      ast = undefined;
    }
  }

  if (ast && buildTree && layoutIR) {
    result.ui = ast;
    try {
      const pt = inferPageType({ ast, layout: layoutIR, ...(ocr ? { ocr } : {}) });
      const variants = inferVariants(ast, layoutIR.theme);
      const summary = buildSemanticSummary({ ast, pageType: pt.pageType, variants, layout: layoutIR });
      result.uiSemantics = {
        pageType: pt.pageType,
        pageTypeConfidence: pt.confidence,
        pageTypeSignals: pt.signals,
        variants,
        summary,
      };
    } catch {}
  }

  try {
    result.imageContents = extractImageContents(input.uiLayoutExtraction.mediaAreas);
  } catch {}

  if (ast) {
    try {
      result.codegenIr = toCodegenIr(ast, layoutIR);
    } catch {}
  }
  if (ast && opts.exportFigma) {
    try {
      result.figma = new FigmaExporter().export(ast);
    } catch {}
  }
  if (ast && opts.exportMarkdown) {
    try {
      result.markdown = new MarkdownExporter().export(ast);
    } catch {}
  }

  return result;
}
