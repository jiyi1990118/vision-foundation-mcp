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
import { SkillPipeline, composeResult } from '../core/skill-pipeline.js';
import type { TargetQuery } from '../core/skill-pipeline.js';
import { detectAnnotations } from '../core/annotation-detector.js';
import { extractKeyContent, shouldExtractKeyContent } from '../core/key-content-extractor.js';
import type { KeyContentActivationInput } from '../core/key-content-extractor.js';
import { Semaphore, withTimeout } from '../utils/concurrency.js';
import { chooseProvider, providerToCandidate, type RouterOptions, type RouterResources } from '../core/provider-router.js';
import type { VisionProvider } from '../providers/types.js';
import type { PlannerInput, PolicyContext, SkillResultSet } from '../types/skills.js';
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
      const { image: rawImage, intent: rawIntent, skills: requestedSkills, options } = args;
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
        return await withTimeout(
          (async () => {
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
            const skillResults = await pipeline.execute(finalPlan, image);

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
            const composeOptions = {
              ...(annotations ? { annotations } : {}),
              ...(target ? { target } : {}),
              ...(keyContentExtraction ? { keyContentExtraction } : {}),
            };
            const visionResult = composeResult(skillResults, provider.name, provider.runtime, duration, composeOptions);

            logger.info('vision.analyze completed', {
              duration,
              skillsSucceeded: visionResult.skills,
              category: visionResult.category,
            });

            return {
              content: [
                {
                  type: 'text' as const,
                  text: visionResult.summary || `Analysis complete: ${visionResult.category}`,
                },
              ],
              structuredContent: visionResult,
            };
          })(),
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
