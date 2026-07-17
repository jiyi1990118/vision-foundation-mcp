/**
 * UI Analysis Orchestrator - async enrichment wrapper around the sync
 * {@link analyzeUiPipeline}. Consolidates the per-stream enrichment that
 * previously lived inline in the vision.analyze tool handler:
 *
 *   1. analyzeUiPipeline (sync core: IR -> SemanticAST + semantics + exports)
 *   2. per-node visual style sampling + injection (needs the source image)
 *   3. optional VLM image-content description (use_llm only)
 *   4. consolidated uiReconstruction build
 *
 * Each stage degrades gracefully: a failure is logged and the corresponding
 * output field is simply omitted rather than aborting the whole enrichment.
 * The caller attaches whichever fields succeeded onto the MCP result.
 *
 * @see src/ui-analysis/pipeline.ts            (sync core)
 * @see src/ui-analysis/style/style-extractor.ts (per-node style sampling)
 * @see src/ui-analysis/image-content/image-describer.ts (VLM descriptions)
 * @see src/ui-analysis/reconstruction/reconstruction-spec.ts (consolidation)
 */
import type { ImageInput } from '../types/domain.js';
import type { UiLayoutExtraction } from '../core/extractors/ui-layout-extractor.js';
import type { DesignExtraction } from '../core/extractors/design-extractor.js';
import type { OcrItem } from '../core/key-content-extractor.js';
import type { VisionProvider } from '../providers/types.js';
import type { SemanticAST, CodegenIR, VisionOcrItem } from './ir/types.js';
import type { UiReconstructionSpec } from './reconstruction/index.js';
import type { PageType, VariantInfo } from './semantic/index.js';
import type { ImageContentInfo } from './image-content/index.js';
import { analyzeUiPipeline } from './pipeline.js';
import { ocrItemsToVisionOcr } from './ir/ocr-adapter.js';
import { extractNodeStyles, injectNodeStyles } from './style/index.js';
import { describeImageContents, embedImageDataUrls } from './image-content/index.js';
import { filterSolidMediaAreas } from './image-content/media-area-filter.js';
import { buildUiReconstruction } from './reconstruction/index.js';
import { enrichNodeTypes } from './typing/index.js';
import { enrichInteractivity } from './interactivity/index.js';
import { toVisionIRFromLayout, toLayoutIR } from './ir/mappers.js';
import { detectOverlays, applyOverlays } from './overlay/index.js';
import { inferPageType, inferVariants, buildSemanticSummary } from './semantic/index.js';
import { validateReconstruction } from './validate.js';
import { logger } from '../utils/logger.js';

export interface UiAnalysisOptions {
  buildTree?: boolean;
  exportCodegen?: boolean;
  exportFigma?: boolean;
  exportMarkdown?: boolean;
  useLlm?: boolean;
  detectLayout?: boolean;
  detectComponent?: boolean;
  detectText?: boolean;
  detectIcon?: boolean;
  detectTheme?: boolean;
  strictMode?: boolean;
  embedImages?: boolean;
}

export interface UiAnalysisResult {
  ui?: SemanticAST;
  uiSemantics?: {
    pageType: PageType;
    pageTypeConfidence: number;
    pageTypeSignals: string[];
    variants: VariantInfo[];
    summary: string;
  };
  codegenIr?: CodegenIR;
  figmaJson?: unknown;
  uiMarkdown?: string;
  imageContents?: ImageContentInfo[];
  uiReconstruction?: UiReconstructionSpec;
}

export interface RunUiAnalysisInput {
  uiLayoutExtraction: UiLayoutExtraction;
  designExtraction?: DesignExtraction;
  image?: ImageInput;
  provider?: VisionProvider;
  ocrItems?: OcrItem[];
  options?: UiAnalysisOptions;
}

/**
 * Build a filtered copy of {@link UiLayoutExtraction} honoring the
 * `detect_component` / `detect_text` / `detect_icon` toggles. The original
 * object is never mutated; when all three detects are on (the default) the
 * input is returned as-is so existing behavior is unchanged.
 *
 * `regions` are always preserved: they are the structural backbone of the
 * SemanticAST tree and cannot be dropped without breaking `build_tree`.
 * `detect_layout` is handled later (after reconstruction) by clearing
 * constraints.
 */
function applyDetectFilters(ext: UiLayoutExtraction, opts: UiAnalysisOptions): UiLayoutExtraction {
  const detectComponent = opts.detectComponent !== false;
  const detectText = opts.detectText !== false;
  const detectIcon = opts.detectIcon !== false;
  if (detectComponent && detectText && detectIcon) return ext;
  return {
    ...ext,
    components: detectComponent ? ext.components : [],
    texts: detectText ? ext.texts : [],
    mediaAreas: detectIcon ? ext.mediaAreas : [],
  };
}

/**
 * Run the full UI analysis enrichment and return whichever output fields
 * succeeded. When `strict_mode` is enabled the final reconstruction is
 * structurally validated and a failure throws (propagated to the caller);
 * otherwise failures degrade to omitted fields + a logger.warn.
 */
export async function runUiAnalysis(input: RunUiAnalysisInput): Promise<UiAnalysisResult> {
  const result: UiAnalysisResult = {};
  const opts = input.options ?? {};
  const detectTheme = opts.detectTheme !== false;

  const filteredLayout = applyDetectFilters(input.uiLayoutExtraction, opts);
  const effectiveDesign = detectTheme ? input.designExtraction : undefined;
  const visionOcr = input.ocrItems ? ocrItemsToVisionOcr(input.ocrItems) : undefined;

  let effectiveLayout = filteredLayout;
  if (input.image && opts.detectIcon !== false && filteredLayout.mediaAreas.length > 0) {
    try {
      const solidAreas = await filterSolidMediaAreas(input.image, filteredLayout.mediaAreas);
      if (solidAreas.length !== filteredLayout.mediaAreas.length) {
        effectiveLayout = { ...filteredLayout, mediaAreas: solidAreas };
      }
    } catch (err) {
      logger.warn('ui media-area filter failed', { error: String(err) });
    }
  }

  const pipeline = analyzeUiPipeline({
    uiLayoutExtraction: effectiveLayout,
    ...(effectiveDesign ? { designExtraction: effectiveDesign } : {}),
    ...(visionOcr ? { ocrItems: visionOcr } : {}),
    options: {
      buildTree: opts.buildTree !== false,
      exportCodegen: opts.exportCodegen === true,
      exportFigma: opts.exportFigma === true,
      exportMarkdown: opts.exportMarkdown === true,
      useLlm: opts.useLlm === true,
    },
  });

  if (input.image && pipeline.ui) {
    try {
      const nodeStyles = await extractNodeStyles(input.image, pipeline.ui);
      injectNodeStyles(pipeline.ui, nodeStyles);
    } catch (err) {
      logger.warn('ui style extraction failed', { error: String(err) });
    }
  }

  if (pipeline.ui) {
    try {
      let pipelineOcr: VisionOcrItem[] | undefined;
      try {
        pipelineOcr = toVisionIRFromLayout(filteredLayout).ocr;
      } catch {
        pipelineOcr = undefined;
      }
      enrichNodeTypes(pipeline.ui, pipelineOcr);
    } catch (err) {
      logger.warn('ui type enrichment failed', { error: String(err) });
    }
  }

  if (pipeline.ui) {
    try {
      enrichInteractivity(pipeline.ui);
    } catch (err) {
      logger.warn('ui interactivity enrichment failed', { error: String(err) });
    }
  }

  if (input.image && pipeline.ui) {
    try {
      const overlays = await detectOverlays(input.image, pipeline.ui);
      applyOverlays(pipeline.ui, overlays);
    } catch (err) {
      logger.warn('ui overlay detection failed', { error: String(err) });
    }
  }

  // Re-infer semantics on the enriched/corrected AST so page-type sees the
  // post-correction types (e.g. cards promoted to listItem -> 'list', a blue
  // container corrected to button). Overwrites the pipeline's pre-correction
  // uiSemantics; failures keep the pre-correction value.
  if (pipeline.ui && pipeline.uiSemantics) {
    try {
      const reLayout = toLayoutIR(effectiveLayout, effectiveDesign);
      const reOcr = visionOcr ?? toVisionIRFromLayout(effectiveLayout).ocr;
      const pt = inferPageType({
        ast: pipeline.ui,
        layout: reLayout,
        ...(reOcr ? { ocr: reOcr } : {}),
      });
      const variants = inferVariants(pipeline.ui, reLayout.theme);
      const summary = buildSemanticSummary({
        ast: pipeline.ui,
        pageType: pt.pageType,
        variants,
        layout: reLayout,
      });
      pipeline.uiSemantics = {
        pageType: pt.pageType,
        pageTypeConfidence: pt.confidence,
        pageTypeSignals: pt.signals,
        variants,
        summary,
      };
    } catch (err) {
      logger.warn('ui semantic re-inference failed', { error: String(err) });
    }
  }

  if (
    opts.useLlm === true &&
    input.image &&
    input.provider &&
    pipeline.imageContents &&
    pipeline.imageContents.length > 0
  ) {
    try {
      await describeImageContents(input.provider, input.image, pipeline.imageContents);
    } catch (err) {
      logger.warn('ui image description failed', { error: String(err) });
    }
  }

  if (
    opts.embedImages === true &&
    input.image &&
    pipeline.imageContents &&
    pipeline.imageContents.length > 0
  ) {
    try {
      await embedImageDataUrls(input.image, pipeline.imageContents);
    } catch (err) {
      logger.warn('ui image embed failed', { error: String(err) });
    }
  }

  if (pipeline.ui) result.ui = pipeline.ui;
  if (pipeline.uiSemantics) result.uiSemantics = pipeline.uiSemantics;
  if (pipeline.codegenIr) result.codegenIr = pipeline.codegenIr;
  if (pipeline.figma) result.figmaJson = pipeline.figma;
  if (pipeline.markdown) result.uiMarkdown = pipeline.markdown;
  if (pipeline.imageContents) result.imageContents = pipeline.imageContents;

  if (pipeline.ui) {
    try {
      const responsiveRules = pipeline.codegenIr?.responsive;
      const recon = buildUiReconstruction({
        ast: pipeline.ui,
        ...(pipeline.uiSemantics
          ? {
              semantics: {
                pageType: pipeline.uiSemantics.pageType,
                confidence: pipeline.uiSemantics.pageTypeConfidence,
                summary: pipeline.uiSemantics.summary,
              },
            }
          : {}),
        ...(pipeline.codegenIr?.constraints ? { constraints: pipeline.codegenIr.constraints } : {}),
        ...(responsiveRules && responsiveRules.length > 0 ? { responsive: responsiveRules } : {}),
        ...(pipeline.codegenIr?.repeats ? { repeats: pipeline.codegenIr.repeats } : {}),
        ...(pipeline.imageContents ? { images: pipeline.imageContents } : {}),
        ...(effectiveDesign
          ? {
              theme: {
                palette: effectiveDesign.palette.map((p) => ({ hex: p.hex, role: p.role })),
                background: effectiveDesign.background,
                primary: effectiveDesign.primary,
                textColor: effectiveDesign.textColor,
                isDarkMode: effectiveDesign.isDarkMode,
                contrastRatio: effectiveDesign.contrastRatio,
              },
            }
          : {}),
      });
      if (opts.detectLayout === false) {
        recon.constraints = [];
      }
      result.uiReconstruction = recon;
    } catch (err) {
      logger.warn('ui reconstruction build failed', { error: String(err) });
    }
  }

  if (opts.strictMode === true && result.uiReconstruction) {
    validateReconstruction(result.uiReconstruction);
  }

  return result;
}
