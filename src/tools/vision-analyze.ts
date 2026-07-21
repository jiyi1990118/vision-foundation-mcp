/**
 * vision.analyze — the single MCP Tool entry point.
 *
 * M2: Full layered architecture — Tool → Planner → Policy → Pipeline → Provider.
 *
 * @see Docs/02-contracts/02-api-contract.md
 * @see Docs/01-architecture/02-request-lifecycle.md
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NormalizeError, normalizeImageInput } from '../core/request-normalizer.js';
import { extractMetadata } from '../core/metadata-extractor.js';
import { planExecution, resolveSkillNames } from '../core/execution-planner.js';
import { evaluatePolicy, PolicyDeniedError } from '../core/policy-engine.js';
import { SkillPipeline, composeResult, resolveResultCategory } from '../core/skill-pipeline.js';
import type { TargetQuery } from '../core/skill-pipeline.js';
import { detectAnnotations } from '../core/annotation-detector.js';
import { extractKeyContent, shouldExtractKeyContent, extractOcrItems } from '../core/key-content-extractor.js';
import type { KeyContentActivationInput } from '../core/key-content-extractor.js';
import { extractForScenario } from '../core/extractors/scenario-dispatcher.js';
import { extractDesignTokens } from '../core/extractors/design-extractor.js';
import { extractUiLayoutForAnalysis } from '../ui-analysis/adapters/index.js';
import {
  filterUiLayoutExtractionForOutput,
  runUiAnalysis,
  type UiAnalysisOptions,
} from '../ui-analysis/orchestrator.js';
import { runReasoning } from '../core/universal-parser.js';
import { sceneFromClassify, sceneFromHint, sceneFromScenario, refineScene } from '../core/scene-taxonomy.js';
import type { ParseScene } from '../types/domain.js';
import { Semaphore, withAbortableTimeout } from '../utils/concurrency.js';
import { chooseProvider, providerToCandidate, type RouterOptions, type RouterResources } from '../core/provider-router.js';
import type { VisionProvider } from '../providers/types.js';
import type { PlannerInput, PolicyContext, SkillResult, SkillResultSet } from '../types/skills.js';
import { logger } from '../utils/logger.js';
import { DEFAULT_CONFIG, getConfig } from '../core/config.js';

// Concurrency control — limit simultaneous vision analyses
const semaphore = new Semaphore(DEFAULT_CONFIG.server.maxConcurrent);

interface ClassifiedVisionError {
  code: string;
  message: string;
  retryable: boolean;
}

const inputSchema = z.object({
  image: z
    .string()
    .min(1)
    .describe('Image to analyze: file path, base64, data URI, or http(s) URL'),
  intent: z
    .string()
    .optional()
    .describe('Natural language intent. Empty or "auto" for automatic analysis.'),
  scene: z
    .string()
    .optional()
    .describe('Scene hint to guide parsing (e.g. requirement, ui, code, chart). Guides but does not override image evidence.'),
  skills: z
    .array(z.string())
    .optional()
    .describe('Explicitly specify skills to run. Overrides intent inference.'),
  options: z
    .object({
      quality: z.enum(['fast', 'high']).optional(),
      provider: z.string().optional(),
      cache: z.boolean().optional(),
      maxTokens: z.number().optional(),
      target: z.object({
        color: z.string().optional(),
        position: z.string().optional(),
        description: z.string().optional(),
      }).optional(),
      build_tree: z.boolean().optional().describe('Build hierarchical SemanticAST for UI scenes (default true when scene=ui).'),
      export_codegen: z.boolean().optional().describe('Export CodegenIR from the UI AST.'),
      export_figma: z.boolean().optional().describe('Export Figma REST-API shaped JSON from the UI AST.'),
      export_markdown: z.boolean().optional().describe('Export human-readable Markdown from the UI AST.'),
      use_llm: z.boolean().optional().describe('Enable LLM enhancement of UI semantics (default false; v1 algorithmic only).'),
      detect_layout: z.boolean().optional().describe('Include layout regions/constraints (default true).'),
      detect_component: z.boolean().optional().describe('Include detected components (default true).'),
      detect_text: z.boolean().optional().describe('Include OCR text binding (default true).'),
      detect_icon: z.boolean().optional().describe('Include icon/image/logo areas (default true).'),
      detect_theme: z.boolean().optional().describe('Include theme/design tokens (default true).'),
      strict_mode: z.boolean().optional().describe('Validate output structure; fail on missing required fields instead of degrading silently.'),
      embed_images: z.boolean().optional().describe('Embed small icon/image crops as base64 data URLs (default false; bounded by size/count).'),
      summary_only: z.boolean().optional().describe('Trim uiReconstruction to a root-only tree + stats (omit deep children/constraints/images) to cap output size for large UIs.'),
      reconstruction_mode: z.enum(['fast', 'balanced', 'high_fidelity']).optional().describe('UI analysis depth: fast (CV+OCR only), balanced (+UI detector), high_fidelity (+OmniParser/icon caption). Default fast.'),
    })
    .optional(),
});

export interface SelectProviderInput {
  options: RouterOptions;
  resources: RouterResources;
  requestedSkills: string[];
}

/**
 * Pick the provider instance that should execute a request, given the
 * registered providers and the request's options/resources/skills.
 *
 * Falls back to the first registered provider if no candidate can satisfy
 * high-quality routing (e.g. only one provider registered, or resources
 * insufficient for the high-quality one).
 */
export function selectProvider(
  providers: VisionProvider[],
  input: SelectProviderInput,
): VisionProvider {
  if (providers.length === 0) {
    throw new Error('No vision provider registered');
  }

  // Fast path: when quality is not "high", no explicit provider is requested,
  // and the default provider covers the requested skills, just use it. OCR-only
  // requests still go through routing so future dedicated OCR providers can win.
  const wantsHigh = input.options.quality === 'high';
  const hasExplicitProvider = typeof input.options.provider === 'string' && input.options.provider.length > 0;
  const skills = input.requestedSkills.length > 0
    ? input.requestedSkills
    : ['classify', 'summary'];
  const defaultProvider = providers[0]!;
  const shouldRoute = wantsHigh || hasExplicitProvider || isOcrOnly(skills) || !coversSkills(defaultProvider, skills);
  if (!shouldRoute) {
    return defaultProvider;
  }

  const candidates = providers.map((p) => providerToCandidate(p));

  try {
    const choice = chooseProvider({
      candidates,
      options: input.options,
      resources: input.resources,
      requestedSkills: skills,
    });
    const found = providers.find((p) => p.name === choice.name);
    if (found) return found;
  } catch (e) {
    if (hasExplicitProvider) {
      throw e;
    }
    logger.warn('Provider routing failed, falling back to default provider', {
      error: (e as Error).message,
    });
  }

  return providers[0]!;
}

function isOcrOnly(skills: string[]): boolean {
  return skills.length === 1 && skills[0] === 'ocr';
}

function coversSkills(provider: VisionProvider, skills: string[]): boolean {
  const supported = new Set(provider.supportedSkills);
  return skills.every((skill) => supported.has(skill));
}

function isDedicatedOcrProvider(provider: VisionProvider): boolean {
  return provider.supportedSkills.length === 1 && provider.supportedSkills[0] === 'ocr';
}

export function buildSkillProviderOverrides(
  providers: VisionProvider[],
  selectedProvider: VisionProvider,
  skillNames: string[],
): Record<string, VisionProvider> {
  const overrides: Record<string, VisionProvider> = {};
  if (!skillNames.includes('ocr') || isOcrOnly(skillNames)) {
    return overrides;
  }

  const dedicatedOcr = providers.find((provider) => (
    provider !== selectedProvider
    && provider.supportedSkills.length === 1
    && provider.supportedSkills[0] === 'ocr'
  ));
  if (dedicatedOcr) {
    overrides.ocr = dedicatedOcr;
  }

  return overrides;
}

export function shouldRunKeyContentExtraction(
  skillResults: SkillResultSet,
  input: KeyContentActivationInput,
): boolean {
  const ocrResult = skillResults.ocr;
  return ocrResult?.success === true
    && ocrResult.data !== undefined
    && shouldExtractKeyContent(input);
}

export function shouldInspectAnnotationsForRequest(input: {
  target?: TargetQuery | undefined;
  intent?: string | undefined;
  skillNames: string[];
}): boolean {
  if (!input.skillNames.includes('ocr')) return false;
  return shouldExtractKeyContent({
    target: input.target,
    intent: input.intent,
    skillNames: input.skillNames,
  });
}

export function buildOcrProviderWarnings(input: {
  intent?: string | undefined;
  skillNames: string[];
  selectedProvider: VisionProvider;
  providerOverrides: Record<string, VisionProvider>;
}): string[] {
  if (!input.skillNames.includes('ocr')) return [];
  if (!shouldExtractKeyContent({ intent: input.intent, skillNames: input.skillNames })) return [];
  if (input.providerOverrides.ocr || isDedicatedOcrProvider(input.selectedProvider)) return [];

  return ['未启用专用 OCR provider，需求图红框/小字提取可能不可靠；建议设置 VISION_OCR_PROVIDER=ppu-paddle-ocr。'];
}

export function registerVisionAnalyzeTool(
  server: McpServer,
  providers: VisionProvider[],
): void {
  server.registerTool(
    'vision.analyze',
    {
      title: 'Vision Analyze',
      description:
        'Analyze an image and return structured vision understanding result. ' +
        'Supports file paths, base64, data URIs, and HTTP URLs as input.',
      inputSchema,
    },
    async (args) => {
      const { image: rawImage, intent: rawIntent, scene: sceneHint, skills: requestedSkills, options } = args;
      const intent = rawIntent || 'auto';
      const startTime = Date.now();
      const config = await getConfig();

      logger.info('vision.analyze called', {
        intent, hasSkills: !!requestedSkills,
        semaphoreAvailable: semaphore.available,
        semaphoreWaiting: semaphore.waiting,
      });

      // Acquire concurrency slot
      await semaphore.acquire();
      logger.debug('Concurrency slot acquired', { available: semaphore.available });

      try {
        // Wrap entire pipeline in a timeout
        return await withAbortableTimeout(
          async (signal) => {
            // ── Stage 2: Normalize input ──
            const image = await normalizeImageInput(rawImage);

            // ── Stage 3: Extract metadata ──
            const metadata = await extractMetadata(image);

            // ── Stage 4: Plan execution ──
            const { detectHardware } = await import('../core/runtime-detector.js');
            const hw = await detectHardware();
            const resources = {
              cpuCores: hw.cpuCores,
              totalMemoryMB: hw.totalMemoryMB,
              memoryAvailableMB: hw.availableMemoryMB,
              hasGPU: hw.hasMetal || hw.hasCUDA,
            };

            // ── Stage 4b: Route to the best provider for this request ──
            const skillNames = resolveSkillNames(requestedSkills, intent, options ?? {});
            const provider = selectProvider(providers, {
              options: options ?? {},
              resources,
              requestedSkills: skillNames,
            });
            if (!provider.isLoaded()) {
              await provider.load();
            }
            const providerOverrides = buildSkillProviderOverrides(providers, provider, skillNames);
            await Promise.all(
              Object.values(providerOverrides).map(async (overrideProvider) => {
                if (!overrideProvider.isLoaded()) {
                  await overrideProvider.load();
                }
              }),
            );
            logger.info('Provider selected', {
              provider: provider.name,
              runtime: provider.runtime,
              requestedQuality: options?.quality ?? 'fast',
              providerOverrides: Object.fromEntries(
                Object.entries(providerOverrides).map(([skill, overrideProvider]) => [skill, overrideProvider.name]),
              ),
            });

            const plannerInput: PlannerInput = {
              image,
              metadata,
              intent,
              requestedSkills,
              options: options ?? {},
              resources,
              activeProvider: provider.name,
              activeRuntime: provider.runtime,
            };

            const draftPlan = await planExecution(plannerInput);

            // ── Stage 5: Policy evaluation ──
            const policyCtx: PolicyContext = {
              plan: draftPlan,
              metadata,
              intent,
              options: options ?? {},
              resources,
            };

            const finalPlan = await evaluatePolicy(policyCtx);

            logger.info('Execution plan finalized', {
              provider: finalPlan.provider,
              skills: finalPlan.skills.map((s) => s.skill),
              preprocess: finalPlan.preprocess,
            });

            // ── Stage 6-7: Execute Skill Pipeline ──
            const pipeline = new SkillPipeline(provider, providerOverrides);
            const skillResults = await pipeline.execute(finalPlan, image, signal);

            // ── Stage 8-9: Compose result ──
            const duration = Date.now() - startTime;
            const shouldInspectAnnotations = shouldInspectAnnotationsForRequest({
              target: options?.target as TargetQuery | undefined,
              intent,
              skillNames,
            });
            const annotations = skillResults.ocr?.success && shouldInspectAnnotations
              ? await detectAnnotations(image, skillResults.ocr.data)
              : undefined;
            const target = options?.target as TargetQuery | undefined;
            const ocrProvider = providerOverrides.ocr ?? (isDedicatedOcrProvider(provider) ? provider : undefined);
            const ocrResult = skillResults.ocr;
            const shouldExtractKeyContentForRequest = shouldRunKeyContentExtraction(skillResults, {
              target,
              intent,
              annotations,
              skillNames,
            });
            const keyContentExtraction = shouldExtractKeyContentForRequest && ocrResult?.success === true
              ? await extractKeyContent({
                image,
                target,
                intent,
                annotations,
                ocrData: ocrResult.data,
                ocrProvider,
                signal,
              })
              : undefined;
            // Scenario-driven structured extraction (chart/diagram/invoice/code/form).
            // Runs when the scenario has a dedicated extractor and key-content did
            // not already handle it (requirement scenario).
            let scenarioExtraction: { summary: string } | undefined;
            let scenarioExtractionData: unknown;
            let scenarioType = 'general';
            if (keyContentExtraction) {
              // Key-content extraction only runs for requirement/annotation/target
              // intents (see shouldExtractKeyContent), so the scenario is
              // requirement. extractForScenario is skipped to avoid duplicate work.
              scenarioType = 'requirement';
            } else if (ocrResult?.success === true) {
              const category = skillResults.classify?.success
                ? String((skillResults.classify.data as Record<string, unknown> | undefined)?.category ?? '')
                : undefined;
              const { detection, extraction } = await extractForScenario({
                image,
                intent,
                ...(category ? { category } : {}),
                hasAnnotations: (annotations?.coloredBoxes?.length ?? annotations?.redBoxes.length ?? 0) > 0,
                ...(target ? { hasTarget: true } : {}),
                ocrData: ocrResult.data,
              });
              scenarioType = detection.scenario;
              if (detection.scenario !== 'requirement' && extraction) {
                scenarioExtraction = { summary: extraction.summary };
                scenarioExtractionData = extraction;
                logger.info('Scenario extraction completed', {
                  scenario: detection.scenario,
                  label: detection.label,
                });
              }
            }
            // Design token extraction: algorithmic color palette extraction
            // (median-cut quantization + role classification + WCAG contrast).
            // Runs for UI / screenshot / poster scenes. ~50ms, no VLM.
            const summarySkillText = String(
              (skillResults.summary?.data as Record<string, unknown> | undefined)?.description
              ?? (skillResults.summary?.data as Record<string, unknown> | undefined)?.summary
              ?? '',
            );
            const resolvedCategory = resolveResultCategory(skillResults, summarySkillText).category;
            const isUiScene = shouldExtractDesign(resolvedCategory, sceneHint);
            const uiOptions: UiAnalysisOptions = {
              buildTree: options?.build_tree !== false,
              exportCodegen: options?.export_codegen === true,
              exportFigma: options?.export_figma === true,
              exportMarkdown: options?.export_markdown === true,
              useLlm: options?.use_llm === true,
              detectLayout: options?.detect_layout !== false,
              detectComponent: options?.detect_component !== false,
              detectText: options?.detect_text !== false,
              detectIcon: options?.detect_icon !== false,
              detectTheme: options?.detect_theme !== false,
              strictMode: options?.strict_mode === true,
              embedImages: options?.embed_images === true,
              summaryOnly: options?.summary_only === true,
            };
            const hasExplicitUiExport = uiOptions.exportCodegen === true
              || uiOptions.exportFigma === true
              || uiOptions.exportMarkdown === true;
            if (
              isUiScene
              && uiOptions.strictMode === true
              && uiOptions.buildTree === false
              && !hasExplicitUiExport
            ) {
              throw new Error('strict mode requires build_tree=true or at least one explicit UI export');
            }
            const designExtraction = isUiScene && uiOptions.detectTheme !== false
              ? await extractDesignTokens(image).catch((err) => {
                logger.warn('design extraction failed', { error: String(err) });
                return undefined;
              })
              : undefined;
            // UI layout extraction: visual region detection + component
            // boundaries + text hierarchy + spacing + icon areas.
            // Same trigger as design extraction. ~100ms, no VLM.
            const uiLayoutExtraction = isUiScene
              ? await extractUiLayoutForAnalysis(
                  image,
                  uiOptions.detectText !== false && skillResults.ocr?.success
                    ? extractOcrItems(skillResults.ocr.data, 'full')
                    : undefined,
                  designExtraction?.palette.map((p) => ({ hex: p.hex, role: p.role })),
                  { detectMedia: uiOptions.detectIcon !== false },
                ).catch((err) => {
                  logger.warn('ui layout extraction failed', { error: String(err) });
                  if (uiOptions.strictMode === true) {
                    throw new Error(`ui layout extraction failed: ${String(err)}`);
                  }
                  return undefined;
                })
              : undefined;
            if (isUiScene && uiOptions.strictMode === true && !uiLayoutExtraction) {
              throw new Error('ui layout extraction failed: no layout was produced');
            }
            // Universal parser reasoning: one focused VLM call for
            // insights/risks/next_actions. Falls back to scene templates on
            // failure or hallucination (handled inside runReasoning).
            const ocrTextForReasoning = skillResults.ocr?.success
              ? extractOcrTextForReasoning(skillResults.ocr.data)
              : undefined;
            const summaryForReasoning = summarySkillText;
            // Skip the reasoning VLM call when there is no context to ground it
            // (e.g. classify-only / single-skill requests): templates are more
            // reliable than a bare 500M-model guess and we save ~3-5s latency.
            const hasReasoningContext = Boolean(
              ocrTextForReasoning || summaryForReasoning || scenarioExtractionData || keyContentExtraction,
            );
            const reasoningResult = hasReasoningContext
              ? await runReasoning(provider, {
                image: { buffer: image.buffer, mimeType: image.mimeType },
                scene: resolveReasoningScene({
                  category: skillResults.classify,
                  scenario: scenarioType,
                  sceneHint,
                  ocrText: ocrTextForReasoning,
                  summary: summaryForReasoning,
                  intent,
                }),
                ocrText: ocrTextForReasoning,
                summary: summaryForReasoning,
                scenarioExtractionData,
                keyContentExtraction,
              }, signal).catch((err) => {
                logger.warn('runReasoning threw; using templates', { error: String(err) });
                return undefined;
              })
              : undefined;
            const ocrProviderWarnings = buildOcrProviderWarnings({
              intent,
              skillNames,
              selectedProvider: provider,
              providerOverrides,
            });
            if (keyContentExtraction && ocrProviderWarnings.length > 0) {
              keyContentExtraction.warnings = [...new Set([...keyContentExtraction.warnings, ...ocrProviderWarnings])];
            }
            const summaryOnly = uiOptions.summaryOnly === true;
            const publicUiLayout = uiLayoutExtraction && !summaryOnly
              ? filterUiLayoutExtractionForOutput(uiLayoutExtraction, uiOptions)
              : undefined;
            const publicDesign = !summaryOnly && uiOptions.detectTheme !== false
              ? designExtraction
              : undefined;
            const composeOptions = {
              ...(annotations ? { annotations } : {}),
              ...(target ? { target } : {}),
              ...(keyContentExtraction ? { keyContentExtraction } : {}),
              ...(scenarioExtraction ? { scenarioExtraction } : {}),
              ...(scenarioExtractionData ? { scenarioExtractionData } : {}),
              ...(publicDesign ? { designExtraction: publicDesign } : {}),
              ...(publicUiLayout ? { uiLayoutExtraction: publicUiLayout } : {}),
              scenario: scenarioType,
              reasoningResult,
              sceneHint,
              metadata,
              intent,
            };
            const visionResult = composeResult(skillResults, provider.name, provider.runtime, duration, composeOptions);
            scrubLegacyUiBranches(
              visionResult.result,
              uiOptions,
              skillResults.layout !== undefined,
            );

            logger.info('vision.analyze completed', {
              duration,
              skillsSucceeded: visionResult.skills,
              category: visionResult.category,
            });

            // UI semantic AST pipeline: layer flat uiLayoutExtraction into a hierarchical
            // SemanticAST (+ per-node styles + optional VLM image descriptions + a
            // consolidated uiReconstruction). Orchestrated in src/ui-analysis/orchestrator.ts;
            // each stage degrades gracefully. Gated by scene + build_tree option.
            if (uiLayoutExtraction && isUiScene && (uiOptions.buildTree !== false || hasExplicitUiExport)) {
              try {
                const uiResult = await runUiAnalysis({
                  uiLayoutExtraction,
                  signal,
                  ...(designExtraction ? { designExtraction } : {}),
                  ...(image ? { image } : {}),
                  ...(provider ? { provider } : {}),
                  ...(skillResults.ocr?.success ? { ocrItems: extractOcrItems(skillResults.ocr.data, 'full') } : {}),
                  options: uiOptions,
                });
                if (uiResult.ui) visionResult.result.ui = uiResult.ui;
                if (uiResult.uiSemantics) visionResult.result.uiSemantics = uiResult.uiSemantics;
                if (uiResult.codegenIr) visionResult.result.codegenIr = uiResult.codegenIr;
                if (uiResult.figmaJson) visionResult.result.figmaJson = uiResult.figmaJson;
                if (uiResult.uiMarkdown) visionResult.result.uiMarkdown = uiResult.uiMarkdown;
                if (uiResult.imageContents) visionResult.result.imageContents = uiResult.imageContents;
                if (uiResult.uiReconstruction) visionResult.result.uiReconstruction = uiResult.uiReconstruction;
              } catch (err) {
                if (options?.strict_mode === true) throw err;
                logger.warn('ui analysis failed', { error: String(err) });
              }
            }
            if (uiOptions.strictMode === true) {
              if (isUiScene && uiOptions.buildTree !== false && !visionResult.result.uiReconstruction) {
                throw new Error('uiReconstruction validation failed: reconstruction was not produced');
              }
              if (uiOptions.exportCodegen === true && !visionResult.result.codegenIr) {
                throw new Error('codegen export validation failed: export was not produced');
              }
              if (uiOptions.exportFigma === true && !visionResult.result.figmaJson) {
                throw new Error('figma export validation failed: export was not produced');
              }
              if (uiOptions.exportMarkdown === true && !visionResult.result.uiMarkdown) {
                throw new Error('markdown export validation failed: export was not produced');
              }
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: visionResult.summary || `Analysis complete: ${visionResult.category}`,
                },
              ],
              structuredContent: visionResult,
            };
          },
          config.server.requestTimeoutMs,
          'Vision analysis timed out',
        );
      } catch (e) {
        const classified = classifyVisionError(e);
        logger.error('vision.analyze failed', {
          error: classified.message,
          code: classified.code,
          duration: Date.now() - startTime,
        });

        return {
          content: [{ type: 'text' as const, text: `Vision analysis failed: ${classified.message}` }],
          isError: true,
          structuredContent: {
            error: classified,
          },
        };
      } finally {
        semaphore.release();
      }
    },
  );
}

export function classifyVisionError(errorLike: unknown): ClassifiedVisionError {
  const error = errorLike as Error & { code?: string };
  const message = error?.message ?? 'Unknown error';

  if (errorLike instanceof PolicyDeniedError) {
    return { code: 'POLICY_DENIED', message, retryable: false };
  }

  if (errorLike instanceof NormalizeError) {
    return {
      code: errorLike.code.startsWith('NORMALIZE_') ? 'NORMALIZE_INVALID_INPUT' : errorLike.code,
      message,
      retryable: false,
    };
  }

  if (/timed out|timeout/i.test(message)) {
    return { code: 'TIMEOUT', message, retryable: true };
  }

  if (/llama-server not found|runtime not found|no available runtime/i.test(message)) {
    return { code: 'RUNTIME_NOT_FOUND', message, retryable: false };
  }

  if (/model file not found|mmproj file not found|failed to download/i.test(message)) {
    return { code: 'MODEL_DOWNLOAD_FAILED', message, retryable: true };
  }

  if (/corrupt|checksum|sha256/i.test(message)) {
    return { code: 'MODEL_CORRUPTED', message, retryable: true };
  }

  return { code: 'INTERNAL_ERROR', message, retryable: true };
}

/**
 * Whether design token extraction should run. Triggers for UI / screenshot /
 * poster categories, or when the user provides a ui/prototype scene hint.
 */
function shouldExtractDesign(category: string, sceneHint: string | undefined): boolean {
  const uiCategories = new Set(['ui', 'screenshot', 'poster']);
  if (uiCategories.has(category)) return true;
  if (sceneHint) {
    const lower = sceneHint.toLowerCase();
    if (lower.includes('ui') || lower.includes('prototype')) return true;
  }
  return false;
}

function scrubLegacyUiBranches(
  result: Record<string, unknown>,
  options: UiAnalysisOptions,
  hasLayoutSkillResult: boolean,
): void {
  const hideUiEvidence = options.summaryOnly === true
    || options.buildTree === false
    || options.detectText === false
    || options.detectComponent === false;
  const hideLayout = options.summaryOnly === true
    || options.detectLayout === false
    || options.detectText === false
    || options.detectComponent === false;
  if (hideUiEvidence) delete result.ui;
  if (hideLayout && !hasLayoutSkillResult) delete result.layout;
  const parse = result.parse;
  if (typeof parse === 'object' && parse !== null) {
    if (hideLayout) delete (parse as Record<string, unknown>).layout;
  }
}

/**
 * Extract joined OCR text from the ocr skill result for the reasoning call.
 */
function extractOcrTextForReasoning(ocrData: unknown): string | undefined {
  if (typeof ocrData !== 'object' || ocrData === null) return undefined;
  const texts = (ocrData as { texts?: unknown }).texts;
  if (!Array.isArray(texts)) return undefined;
  const lines = texts
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (typeof item === 'object' && item !== null) {
        const text = (item as { text?: unknown }).text;
        return typeof text === 'string' ? text.trim() : '';
      }
      return '';
    })
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Pick the single highest-confidence scene for the reasoning VLM prompt.
 * Mirrors buildSceneDetection's fusion (classify + scenario + hint + refine)
 * but returns one ParseScene so the reasoning prompt stays consistent with
 * the final parse result.
 */
function resolveReasoningScene(input: {
  category: SkillResult | undefined;
  scenario: string;
  sceneHint: string | undefined;
  ocrText: string | undefined;
  summary: string;
  intent: string;
}): ParseScene {
  const categoryStr = input.category?.success && input.category.data
    ? String((input.category.data as Record<string, unknown>).category ?? '')
    : undefined;
  const signals = [
    sceneFromClassify(categoryStr),
    sceneFromScenario(input.scenario),
    sceneFromHint(input.sceneHint),
  ].filter((s): s is NonNullable<typeof s> => s !== undefined);
  const base = signals.length > 0
    ? signals.sort((a, b) => b.confidence - a.confidence)[0]!.scene
    : 'other';
  // Apply keyword refinement using the same text as buildSceneDetection
  // (OCR + summary + intent) so the reasoning prompt scene matches the final
  // parse result.
  const text = `${input.ocrText ?? ''}\n${input.summary}\n${input.intent}`;
  const refined = refineScene(base, text);
  return refined?.scene ?? base;
}
