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
import type { SemanticAST, CodegenIR, VisionOcrItem, DecodedImage, ASTNode, BBox } from './ir/types.js';
import type { UiReconstructionSpec } from './reconstruction/index.js';
import type { PageType, VariantInfo } from './semantic/index.js';
import type { ImageContentInfo } from './image-content/index.js';
import { analyzeUiPipeline } from './pipeline.js';
import { ocrItemsToVisionOcr } from './ir/ocr-adapter.js';
import { extractNodeStyles, injectNodeStyles } from './style/index.js';
import { classifyMediaAreas, describeImageContents, embedImageDataUrls } from './image-content/index.js';
import { filterSolidMediaAreas } from './image-content/media-area-filter.js';
import { decodeRawImage } from './image-content/decode.js';
import { buildUiReconstruction } from './reconstruction/index.js';
import { enrichNodeTypes } from './typing/index.js';
import { enrichInteractivity } from './interactivity/index.js';
import { toVisionIRFromLayout, toLayoutIR } from './ir/mappers.js';
import { detectOverlays, applyOverlays } from './overlay/index.js';
import type { OverlayInfo } from './overlay/index.js';
import { inferPageType, inferVariants, buildSemanticSummary } from './semantic/index.js';
import { FigmaExporter, MarkdownExporter, toCodegenIr } from './exporter/index.js';
import { validateReconstruction } from './validate.js';
import { applyCompositeGrammar } from './composition/composite-grammar.js';
import { layerizeBanner } from './composition/banner-layerizer.js';
import { assignRenderModes } from './policy/reconstruction-policy.js';
import { analyzeControlAppearance } from './control/index.js';
import { computeQualityReport } from './policy/index.js';
import type { RenderMode } from './policy/index.js';
import { logger } from '../utils/logger.js';
import { DetectorHub } from './evidence/detector-hub.js';
import { fuseEvidence } from './evidence/fusion-engine.js';
import { OnnxDetectorAdapter } from './evidence/onnx-detector-adapter.js';
import { OmniParserAdapter } from './evidence/omniparser-adapter.js';
import { isValidBBox, type EvidenceCandidate } from './evidence/types.js';
import { projectEvidenceToNodes, injectEvidenceIntoAst } from './evidence/ast-projection.js';

const MAX_MEDIA_AREAS = 20;

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
  summaryOnly?: boolean;
  reconstructionMode?: 'fast' | 'balanced' | 'high_fidelity';
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
  /**
   * Optional abort signal. Propagated into the IO-bound enrichment stages
   * (VLM image descriptions, data-URL embedding) so a request timeout or
   * client abort cancels in-flight work instead of running to completion.
   * CPU-only stages (pipeline / type / interactivity / overlay) are too
   * fast to benefit from cooperative cancellation.
   */
  signal?: AbortSignal;
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
    components: detectComponent
      ? detectText ? ext.components : ext.components.map((component) => ({ ...component, text: '' }))
      : [],
    texts: detectText ? ext.texts : [],
    mediaAreas: detectIcon
      ? detectText ? ext.mediaAreas : ext.mediaAreas.map((area) => ({ ...area, nearbyText: undefined }))
      : [],
  };
}

function filteredLayoutSummary(extraction: UiLayoutExtraction): string {
  const parts: string[] = [];
  if (extraction.structure.regions.length > 0) {
    const regionTypes = [...new Set(extraction.structure.regions.map((region) => region.type))];
    parts.push(`${extraction.structure.regions.length} 个视觉区域（${regionTypes.join('/')}）`);
  }
  parts.push(`${extraction.components.length} 个组件`);
  if (extraction.mediaAreas.length > 0) parts.push(`${extraction.mediaAreas.length} 个图标/图片区域`);
  parts.push(`间距风格：${extraction.spacing.scale}`);
  const titleCount = extraction.texts.filter((text) => text.estimatedLevel === 'title').length;
  if (titleCount > 0) parts.push(`标题 ${titleCount} 个`);
  return parts.join('，');
}

/** Filter the legacy UI-layout branch before it is exposed in MCP output. */
export function filterUiLayoutExtractionForOutput(
  ext: UiLayoutExtraction,
  opts: UiAnalysisOptions,
): UiLayoutExtraction {
  const filtered = applyDetectFilters(ext, opts);
  const output = opts.detectLayout === false
    ? {
        ...filtered,
        structure: { ...filtered.structure, regions: [] },
      }
    : filtered;
  return { ...output, summary: filteredLayoutSummary(output) };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  throw error;
}

/**
 * Multi-source detector hub. When `reconstructionMode` is `balanced` or
 * `high_fidelity`, the existing CV component detections and OCR text entries
 * are re-exposed as evidence sources alongside the optional ONNX UI detector
 * and OmniParser sidecar. The fused candidates are returned for downstream
 * AST integration; the existing CV/OCR path remains the source of truth for
 * the AST until that integration lands.
 *
 * Returns `null` for `fast` mode (hub skipped) so the caller keeps the
 * unchanged legacy code path. Any adapter failure degrades to a skipped
 * source rather than aborting the hub.
 */
async function runDetectorHub(
  layout: UiLayoutExtraction,
  image: ImageInput | undefined,
  mode: 'fast' | 'balanced' | 'high_fidelity',
  signal: AbortSignal | undefined,
): Promise<EvidenceCandidate[] | null> {
  if (mode === 'fast') return null;

  const hub = new DetectorHub({ ...(signal ? { signal } : {}), timeoutMs: 10000 });

  // Register CV source from existing layout components. UiComponent carries
  // no confidence score, so a neutral default is assigned; the fusion engine
  // still merges/suppresses overlapping boxes via IoU.
  const cvCandidates: EvidenceCandidate[] = layout.components
    .map((c, i): EvidenceCandidate | null => {
      if (!isValidBBox(c.bbox)) return null;
      return {
        id: `cv-${i}`,
        type: c.type,
        bbox: c.bbox,
        score: 0.7,
        sources: ['cv'],
        sourceVotes: [{ source: 'cv', score: 0.7, type: c.type }],
        ...(c.text ? { text: c.text } : {}),
        ...(c.state && c.state !== 'default' ? { state: c.state } : {}),
      };
    })
    .filter((c): c is EvidenceCandidate => c !== null);

  // Register structural regions as CV evidence. The legacy extractor often
  // produces 0 fine-grained components but populates structure.regions
  // (header/main/card/nav/...). These coarse regions are the primary CV
  // signal for most images and must be available as evidence so the quality
  // report can compute critical-element coverage.
  const regionCandidates: EvidenceCandidate[] = layout.structure.regions
    .map((r, i): EvidenceCandidate | null => {
      if (!isValidBBox(r.bbox)) return null;
      return {
        id: `cv-region-${i}`,
        type: r.type,
        bbox: r.bbox,
        score: 0.6,
        sources: ['cv'],
        sourceVotes: [{ source: 'cv', score: 0.6, type: r.type }],
      };
    })
    .filter((c): c is EvidenceCandidate => c !== null);

  const allCvCandidates = [...cvCandidates, ...regionCandidates];
  if (allCvCandidates.length > 0) {
    hub.register('cv', async () => allCvCandidates);
  }

  // Register OCR source. TextEntry.bbox is already the {x,y,w,h} form.
  const ocrCandidates: EvidenceCandidate[] = layout.texts
    .map((t, i): EvidenceCandidate | null => {
      const bbox = t.bbox;
      if (bbox === undefined || !isValidBBox(bbox)) return null;
      return {
        id: `ocr-${i}`,
        type: 'text',
        bbox,
        score: 0.9,
        sources: ['ocr'],
        sourceVotes: [{ source: 'ocr', score: 0.9, type: 'text' }],
        text: t.text,
      };
    })
    .filter((c): c is EvidenceCandidate => c !== null);
  if (ocrCandidates.length > 0) {
    hub.register('ocr', async () => ocrCandidates);
  }

  // Register ONNX UI detector for balanced+ (only with a source image).
  if ((mode === 'balanced' || mode === 'high_fidelity') && image !== undefined) {
    try {
      const onnxAdapter = new OnnxDetectorAdapter();
      await onnxAdapter.initialize();
      if (onnxAdapter.isLoaded) {
        hub.register('ui-detector', async () => onnxAdapter.detect(image));
      }
    } catch {
      // Model not available, skip
    }
  }

  // Register OmniParser sidecar for high_fidelity (only with a source image).
  if (mode === 'high_fidelity' && image !== undefined) {
    try {
      const omniAdapter = new OmniParserAdapter();
      const available = await omniAdapter.checkAvailability();
      if (available) {
        hub.register('omniparser', async () => omniAdapter.detect(image));
      }
    } catch {
      // Sidecar not available, skip
    }
  }

  const candidates = await hub.runAll();
  const fused = fuseEvidence(candidates, { iouThreshold: 0.5, wbfThreshold: 0.7 });
  return fused.candidates;
}

/**
 * Run the full UI analysis enrichment and return whichever output fields
 * succeeded. When `strict_mode` is enabled the final reconstruction is
 * structurally validated and a failure throws (propagated to the caller);
 * otherwise failures degrade to omitted fields + a logger.warn.
 */
export async function runUiAnalysis(input: RunUiAnalysisInput): Promise<UiAnalysisResult> {
  throwIfAborted(input.signal);
  const result: UiAnalysisResult = {};
  const opts = input.options ?? {};
  const detectTheme = opts.detectTheme !== false;
  const skipped: string[] = [];

  // Decode the source image once and share the raw buffer across every
  // pixel-sampling stage (media-area filter / style extractor / overlay
  // detector) so the same image is not decoded three times. A decode failure
  // leaves this undefined; each consumer then re-attempts and skips on failure.
  let decodedImage: DecodedImage | undefined;
  if (input.image) {
    try {
      decodedImage = await decodeRawImage(input.image);
      throwIfAborted(input.signal);
    } catch {
      throwIfAborted(input.signal);
      // leave undefined; each consumer re-attempts and skips on failure
    }
  }

  const filteredLayout = applyDetectFilters(input.uiLayoutExtraction, opts);
  const effectiveDesign = detectTheme ? input.designExtraction : undefined;
  const visionOcr = opts.detectText === false
    ? undefined
    : input.ocrItems ? ocrItemsToVisionOcr(input.ocrItems) : undefined;

  let effectiveLayout = filteredLayout;
  if (input.image && opts.detectIcon !== false && filteredLayout.mediaAreas.length > 0) {
    try {
      const solidAreas = await filterSolidMediaAreas(
        input.image,
        filteredLayout.mediaAreas,
        decodedImage,
        MAX_MEDIA_AREAS,
      );
      throwIfAborted(input.signal);
      const classifiedAreas = (decodedImage
        ? classifyMediaAreas(solidAreas, { x: 0, y: 0, w: decodedImage.width, h: decodedImage.height })
        : solidAreas)
        .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
      effectiveLayout = { ...filteredLayout, mediaAreas: classifiedAreas };
    } catch (err) {
      throwIfAborted(input.signal);
      skipped.push('mediaAreaFilter');
      logger.warn('ui media-area filter failed', { error: String(err) });
    }
  }

  // Detector hub: run multi-source evidence fusion when reconstruction_mode
  // requires it. Fast mode (and undefined) skips the hub entirely so the
  // legacy CV/OCR code path is unchanged. Fused candidates are produced for
  // future AST integration; failures degrade to a skipped stage.
  const reconstructionMode = opts.reconstructionMode ?? 'fast';
  let hubCandidates: EvidenceCandidate[] | null = null;
  if (reconstructionMode !== 'fast') {
    try {
      hubCandidates = await runDetectorHub(filteredLayout, input.image, reconstructionMode, input.signal);
      throwIfAborted(input.signal);
    } catch (err) {
      throwIfAborted(input.signal);
      skipped.push('detectorHub');
      logger.warn('ui detector hub failed', { error: String(err) });
    }
  }
  if (hubCandidates !== null && hubCandidates.length > 0) {
    logger.debug('ui detector hub produced fused candidates', { count: hubCandidates.length });
  }

  const pipeline = analyzeUiPipeline({
    uiLayoutExtraction: effectiveLayout,
    ...(effectiveDesign ? { designExtraction: effectiveDesign } : {}),
    ...(visionOcr ? { ocrItems: visionOcr } : {}),
    ...(decodedImage
      ? { pageBbox: { x: 0, y: 0, w: decodedImage.width, h: decodedImage.height } }
      : {}),
    options: {
      // The AST remains private analysis state when buildTree=false so final
      // exports still receive every enrichment pass.
      buildTree: true,
      exportCodegen: false,
      exportFigma: false,
      exportMarkdown: false,
      useLlm: opts.useLlm === true,
    },
  });

  // Evidence reflow (A1): project fused detector-hub candidates onto AST
  // nodes and attach per-node evidence metadata. This makes the multi-source
  // fusion result consumable by the quality report (critical-element
  // coverage) and downstream diagnostics. Fast mode produces no candidates
  // so this is a no-op there.
  if (pipeline.ui && hubCandidates !== null && hubCandidates.length > 0) {
    try {
      const evidenceMap = projectEvidenceToNodes(hubCandidates, pipeline.ui);
      injectEvidenceIntoAst(pipeline.ui, evidenceMap);
      throwIfAborted(input.signal);
    } catch (err) {
      throwIfAborted(input.signal);
      skipped.push('evidenceProjection');
      logger.warn('ui evidence projection failed', { error: String(err) });
    }
  }

  if (input.image && pipeline.ui) {
    try {
      const nodeStyles = await extractNodeStyles(input.image, pipeline.ui, decodedImage);
      throwIfAborted(input.signal);
      injectNodeStyles(pipeline.ui, nodeStyles);
    } catch (err) {
      throwIfAborted(input.signal);
      skipped.push('styleExtraction');
      logger.warn('ui style extraction failed', { error: String(err) });
    }
  }

  let overlays: OverlayInfo[] = [];
  if (pipeline.ui && opts.detectComponent !== false) {
    try {
      overlays = await detectOverlays(
        input.image,
        pipeline.ui,
        decodedImage,
        toLayoutIR(effectiveLayout, effectiveDesign).regions,
      );
      throwIfAborted(input.signal);
    } catch (err) {
      throwIfAborted(input.signal);
      skipped.push('overlayDetection');
      logger.warn('ui overlay detection failed', { error: String(err) });
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
      enrichNodeTypes(pipeline.ui, pipelineOcr, { detectComponent: opts.detectComponent !== false });
    } catch (err) {
      throwIfAborted(input.signal);
      skipped.push('typeEnrichment');
      logger.warn('ui type enrichment failed', { error: String(err) });
    }
  }

  if (pipeline.ui) {
    try {
      enrichInteractivity(pipeline.ui);
    } catch (err) {
      throwIfAborted(input.signal);
      skipped.push('interactivity');
      logger.warn('ui interactivity enrichment failed', { error: String(err) });
    }
  }

  // Control appearance analysis (P2): pixel-based detection of checkbox /
  // radio / switch family + state. Runs before composite grammar + render
  // policy so that (a) small `input` leaves are promoted to the detected
  // control family, (b) `props.control` is set, and (c) the render policy can
  // then assign native mode to controls with detected state.
  if (pipeline.ui && decodedImage && opts.detectComponent !== false) {
    const controlImg = decodedImage;
    try {
      const walkControl = (node: ASTNode): void => {
        const isControlLike =
          node.type === 'checkbox' || node.type === 'radio' || node.type === 'switch';
        const isSmallInput =
          node.type === 'input' && node.bbox.w <= 48 && node.bbox.h <= 48;
        if (isControlLike || isSmallInput) {
          const appearance = analyzeControlAppearance(controlImg, node.bbox);
          if (appearance !== null) {
            node.props.control = appearance;
            // Promote a small input leaf to the detected control family.
            if (isSmallInput) {
              node.type = appearance.family;
            }
          }
        }
        for (const c of node.children) walkControl(c);
      };
      walkControl(pipeline.ui.root);
      throwIfAborted(input.signal);
    } catch (err) {
      throwIfAborted(input.signal);
      skipped.push('controlAnalysis');
      logger.warn('ui control analysis failed', { error: String(err) });
    }
  }

  if (pipeline.ui) {
    try {
      applyCompositeGrammar(pipeline.ui.root);
      assignRenderModes(pipeline.ui.root, decodedImage !== undefined
        ? { bannerFallback: true, image: decodedImage, layerizeFn: layerizeBanner }
        : undefined);
      throwIfAborted(input.signal);
    } catch (err) {
      throwIfAborted(input.signal);
      skipped.push('compositeGrammar');
      logger.warn('ui composite grammar failed', { error: String(err) });
    }
  }

  if (pipeline.ui && overlays.length > 0) {
    try {
      applyOverlays(pipeline.ui, overlays);
    } catch (err) {
      throwIfAborted(input.signal);
      skipped.push('overlayApplication');
      logger.warn('ui overlay application failed', { error: String(err) });
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
      throwIfAborted(input.signal);
      skipped.push('semanticReinference');
      logger.warn('ui semantic re-inference failed', { error: String(err) });
    }
  }

  if (
    opts.summaryOnly !== true &&
    opts.useLlm === true &&
    input.image &&
    input.provider &&
    pipeline.imageContents &&
    pipeline.imageContents.length > 0
  ) {
    try {
      await describeImageContents(
        input.provider,
        input.image,
        pipeline.imageContents,
        input.signal ? { signal: input.signal } : undefined,
      );
      throwIfAborted(input.signal);
    } catch (err) {
      throwIfAborted(input.signal);
      skipped.push('imageDescription');
      logger.warn('ui image description failed', { error: String(err) });
    }
  }

  if (
    opts.summaryOnly !== true &&
    opts.embedImages === true &&
    input.image &&
    pipeline.imageContents &&
    pipeline.imageContents.length > 0
  ) {
    try {
      await embedImageDataUrls(
        input.image,
        pipeline.imageContents,
        input.signal ? { signal: input.signal } : undefined,
      );
      throwIfAborted(input.signal);
    } catch (err) {
      throwIfAborted(input.signal);
      skipped.push('imageEmbedding');
      logger.warn('ui image embed failed', { error: String(err) });
    }
  }

  // The async enrichment stages mutate the AST in place. Rebuild every
  // structural export now so types, props, references and repeated templates
  // all describe the final tree rather than the pipeline's pre-enrichment
  // snapshot. The AST can remain private when buildTree=false while explicit
  // exports still use this final enriched representation.
  let finalCodegenIr = pipeline.codegenIr;
  let finalFigma: unknown;
  let finalMarkdown: string | undefined;
  if (pipeline.ui) {
    const finalLayout = toLayoutIR(effectiveLayout, effectiveDesign);
    finalCodegenIr = toCodegenIr(pipeline.ui, finalLayout);
    if (opts.summaryOnly !== true && opts.exportFigma === true) {
      finalFigma = new FigmaExporter().export(pipeline.ui);
    }
    if (opts.summaryOnly !== true && opts.exportMarkdown === true) {
      finalMarkdown = new MarkdownExporter().export(pipeline.ui);
    }
  }
  if (finalCodegenIr && opts.detectLayout === false) {
    finalCodegenIr = { ...finalCodegenIr, constraints: [], responsive: [] };
  }

  const exposeTree = opts.buildTree !== false && opts.summaryOnly !== true;
  if (pipeline.ui && exposeTree) result.ui = pipeline.ui;
  if (pipeline.uiSemantics && exposeTree) result.uiSemantics = pipeline.uiSemantics;
  if (finalCodegenIr && opts.summaryOnly !== true && opts.exportCodegen === true) result.codegenIr = finalCodegenIr;
  if (finalFigma && opts.summaryOnly !== true) result.figmaJson = finalFigma;
  if (finalMarkdown && opts.summaryOnly !== true) result.uiMarkdown = finalMarkdown;
  if (pipeline.imageContents && opts.summaryOnly !== true) result.imageContents = pipeline.imageContents;

  if (pipeline.ui && opts.buildTree !== false) {
    try {
      const responsiveRules = finalCodegenIr?.responsive;
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
        ...(finalCodegenIr?.constraints ? { constraints: finalCodegenIr.constraints } : {}),
        ...(responsiveRules && responsiveRules.length > 0 ? { responsive: responsiveRules } : {}),
        ...(finalCodegenIr?.repeats ? { repeats: finalCodegenIr.repeats } : {}),
        ...(finalCodegenIr?.slots && finalCodegenIr.slots.length > 0
          ? { slots: finalCodegenIr.slots }
          : {}),
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
        ...(skipped.length > 0 ? { diagnostics: { skipped } } : {}),
        ...(pipeline.ui ? {
          quality: computeQualityReport({
            nodes: collectRenderNodes(pipeline.ui.root),
            totalNodes: countNodes(pipeline.ui.root),
            ...(decodedImage
              ? { imageWidth: decodedImage.width, imageHeight: decodedImage.height }
              : {}),
          }),
        } : {}),
      });
      if (opts.detectLayout === false) {
        recon.constraints = [];
      }
      if (opts.summaryOnly === true) {
        recon.tree = { ...recon.tree, children: [] };
        recon.constraints = [];
        recon.images = [];
        delete recon.repeats;
        delete recon.slots;
        delete recon.responsive;
      }
      result.uiReconstruction = recon;
    } catch (err) {
      if (opts.strictMode === true) throw err;
      logger.warn('ui reconstruction build failed', { error: String(err) });
    }
  }

  if (opts.strictMode === true && opts.buildTree !== false) {
    if (!result.uiReconstruction) {
      throw new Error('uiReconstruction validation failed: reconstruction was not produced');
    }
    validateReconstruction(result.uiReconstruction, { summaryOnly: opts.summaryOnly === true });
  }
  if (opts.strictMode === true && opts.buildTree === false) {
    const requestedExports = [
      opts.exportCodegen === true,
      opts.exportFigma === true,
      opts.exportMarkdown === true,
    ];
    if (!requestedExports.some(Boolean)) {
      throw new Error('strict mode requires buildTree=true or at least one explicit export');
    }
    if (opts.exportCodegen === true && !result.codegenIr) {
      throw new Error('codegen export validation failed: export was not produced');
    }
    if (opts.exportFigma === true && !result.figmaJson) {
      throw new Error('figma export validation failed: export was not produced');
    }
    if (opts.exportMarkdown === true && !result.uiMarkdown) {
      throw new Error('markdown export validation failed: export was not produced');
    }
  }

  return result;
}

function collectRenderNodes(node: ASTNode): Array<{
  id: string;
  type: string;
  bbox: BBox;
  render: { mode: RenderMode };
  evidence?: unknown[];
}> {
  const result: Array<{
    id: string;
    type: string;
    bbox: BBox;
    render: { mode: RenderMode };
    evidence?: unknown[];
  }> = [];
  const walk = (n: ASTNode): void => {
    const render = n.props.render;
    if (render !== null && typeof render === 'object' && 'mode' in render) {
      const evidence = n.props.evidence;
      result.push({
        id: n.id,
        type: n.type,
        bbox: n.bbox,
        render: render as { mode: RenderMode },
        ...(Array.isArray(evidence) && evidence.length > 0 ? { evidence } : {}),
      });
    }
    for (const c of n.children) walk(c);
  };
  walk(node);
  return result;
}

function countNodes(node: ASTNode): number {
  let count = 1;
  for (const c of node.children) count += countNodes(c);
  return count;
}
