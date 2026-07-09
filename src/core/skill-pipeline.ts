/**
 * Skill Pipeline — orchestrates execution of multiple Skills.
 *
 * Responsibilities:
 * 1. Execute Skills per ExecutionPlan (serial/parallel/conditional)
 * 2. Validate each Skill's output against its schema
 * 3. Auto-repair common issues (markdown removal, JSON extraction)
 * 4. Compose results into unified VisionResult
 *
 * @see Docs/01-architecture/05-skill-engine.md
 * @see Docs/01-architecture/02-request-lifecycle.md (Stages 7-9)
 */
import type {
  ExecutionPlan,
  SkillTask,
  SkillResult,
  SkillResultSet,
} from '../types/skills.js';
import type {
  ImageInput,
  InferenceRequest,
  InferenceResponse,
  VisionResult,
} from '../types/domain.js';
import type { VisionProvider } from '../providers/types.js';
import { logger } from '../utils/logger.js';

// ── Pipeline ────────────────────────────────────────────

export class SkillPipeline {
  constructor(
    private provider: VisionProvider,
    private providerOverrides: Record<string, VisionProvider> = {},
  ) {}

  /**
   * Execute all Skills in the plan using dependency-aware parallel execution.
   *
   * Strategy:
   * - Skills without dependencies → execute in parallel (Promise.all)
   * - Skills with dependencies → wait for dependencies to finish, then execute
   * - Failed dependency → skip dependents
   *
   * @see Docs/01-architecture/05-skill-engine.md (§5.2 编排模式)
   */
  async execute(
    plan: ExecutionPlan,
    image: ImageInput,
  ): Promise<SkillResultSet> {
    const results: SkillResultSet = {};
    const sorted = [...plan.skills].sort((a, b) => a.priority - b.priority);

    // Build dependency graph: map skill → list of skills that depend on it
    const dependents = new Map<string, string[]>();
    for (const task of sorted) {
      if (task.dependsOn) {
        for (const dep of task.dependsOn) {
          if (!dependents.has(dep)) dependents.set(dep, []);
          dependents.get(dep)!.push(task.skill);
        }
      }
    }

    // Track in-flight promises so we can batch independent skills
    const inFlight = new Map<string, Promise<SkillResult>>();

    for (const task of sorted) {
      // If this task has unmet dependencies, wait for them
      if (task.dependsOn && task.dependsOn.length > 0) {
        const depPromises = task.dependsOn
          .map((dep) => inFlight.get(dep))
          .filter((p): p is Promise<SkillResult> => p !== undefined);

        if (depPromises.length > 0) {
          await Promise.all(depPromises);
        }

        // Check if any dependency failed → skip
        const depFailed = task.dependsOn.some(
          (dep) => results[dep]?.success === false,
        );
        if (depFailed) {
          results[task.skill] = {
            skill: task.skill,
            success: false,
            error: 'skipped: dependency failed',
            duration: 0,
          };
          logger.debug('Skill skipped (dependency failed)', { skill: task.skill });
          continue;
        }

        // Check condition
        if (task.condition) {
          const depResult = results['classify'];
          if (depResult?.data && typeof depResult.data === 'object') {
            const data = depResult.data as Record<string, unknown>;
            const fieldValue = data[task.condition.field.split('.').pop() ?? ''];
            if (String(fieldValue) !== task.condition.equals) {
              results[task.skill] = {
                skill: task.skill,
                success: false,
                error: 'skipped: condition not met',
                duration: 0,
              };
              continue;
            }
          }
        }
      }

      // Execute the skill — store promise for parallel tracking
      const promise = this.executeSkill(task, image, plan, results).then((result) => {
        results[task.skill] = result;
        return result;
      });
      inFlight.set(task.skill, promise);

      // For independent skills (no dependents waiting), start them immediately
      // For skills that others depend on, we don't await — they'll be awaited
      // when the dependent processes them
    }

    // Wait for all in-flight skills to complete
    await Promise.all(inFlight.values());

    return results;
  }

  /**
   * Execute a single Skill task.
   */
  private async executeSkill(
    task: SkillTask,
    image: ImageInput,
    plan: ExecutionPlan,
    results: SkillResultSet,
  ): Promise<SkillResult> {
    const start = Date.now();
    logger.info('Skill executing', { skill: task.skill });

    let lastError: string | undefined;
    const maxRetry = plan.retry.max;
    let currentPrompt = task.prompt;

    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      try {
        const prompt = appendOcrContext(currentPrompt, results['ocr']?.data, task.skill);

        // Build inference request
        const inferReq: InferenceRequest = {
          image,
          prompt,
          maxTokens: plan.maxTokens ?? 256,
          temperature: 0,
          cache: plan.cache,
        };

        // Call provider
        const provider = this.providerOverrides[task.skill] ?? this.provider;
        if (!provider.isLoaded()) {
          await provider.load();
        }
        const response: InferenceResponse = await provider.infer(inferReq);

        // Parse and validate output
        const parsed = this.parseAndValidate(response.text, task.schema, task.skill);

        if (parsed.valid) {
          logger.info('Skill completed', {
            skill: task.skill,
            attempt,
            duration: Date.now() - start,
          });
          return {
            skill: task.skill,
            success: true,
            data: parsed.data,
            duration: Date.now() - start,
          };
        }

        // Validation failed
        lastError = parsed.error;
        logger.warn('Skill validation failed', {
          skill: task.skill,
          attempt,
          error: parsed.error,
          repairs: parsed.repairs,
        });

        // Retry with enhanced prompt
        if (attempt < maxRetry && plan.retry.strategy === 'reprompt') {
          currentPrompt = enhancePromptForRetry(currentPrompt, parsed.error ?? 'validation failed');
        }
      } catch (e) {
        lastError = (e as Error).message;
        logger.warn('Skill execution error', {
          skill: task.skill,
          attempt,
          error: lastError,
        });
      }
    }

    // All retries exhausted
    return {
      skill: task.skill,
      success: false,
      error: lastError ?? 'unknown error',
      duration: Date.now() - start,
      partial: true,
    };
  }

  // ── Output parsing + validation ──────────────────────

  private parseAndValidate(
    rawText: string,
    schema: object,
    skillName: string,
  ): { valid: boolean; data?: unknown; error?: string; repairs?: string[] } {
    const repairs: string[] = [];

    // Step 1: Clean the raw text
    let text = rawText.trim();

    // Step 2: Strip markdown code blocks
    if (text.includes('```')) {
      text = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
      repairs.push('stripped-markdown');
    }

    // Step 3: Extract JSON object (in case model added extra text)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch && jsonMatch[0] !== text) {
      text = jsonMatch[0];
      repairs.push('extracted-json');
    }

    // Step 4: Parse JSON — try direct parse first, then wrap natural language
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
      // If the model output a bare string/number (e.g. `"document"`), treat it
      // as natural language and wrap it via wrapAsJson so schema validation sees
      // an object with the expected fields.
      if (parsed !== null && typeof parsed !== 'object') {
        const wrapped = wrapAsJson(text, skillName);
        if (wrapped) {
          try {
            parsed = JSON.parse(wrapped);
            repairs.push('wrapped-natural-language');
          } catch {
            // keep original parsed value
          }
        }
      }
    } catch (e) {
      void (e as Error);

      // Try fixing common JSON syntax issues first
      if (text.startsWith('{')) {
        const fixed = text
          .replace(/,\s*}/g, '}')
          .replace(/,\s*]/g, ']')
          .replace(/'/g, '"');
        try {
          parsed = JSON.parse(fixed);
          repairs.push('fixed-syntax');
        } catch {
          // Incomplete JSON — try to close braces
          const opens = (text.match(/\{/g) ?? []).length;
          const closes = (text.match(/}/g) ?? []).length;
          if (opens > closes && opens - closes < 5) {
            try {
              parsed = JSON.parse(text + '}'.repeat(opens - closes));
              repairs.push('auto-closed-braces');
            } catch {
              // Fall through to wrapAsJson
            }
          }
        }
      }

      // If still not parsed, the model likely output natural language.
      // SmolVLM-500M doesn't reliably output JSON — wrap the text instead.
      if (parsed === undefined) {
        const wrapped = wrapAsJson(text, skillName);
        if (wrapped) {
          try {
            parsed = JSON.parse(wrapped);
            repairs.push('wrapped-natural-language');
          } catch {
            return { valid: false, error: 'JSON parse failed', repairs };
          }
        } else {
          return { valid: false, error: 'JSON parse failed', repairs };
        }
      }
    }

    // Step 5: Basic schema validation (check required fields)
    const schemaObj = schema as { properties?: Record<string, unknown>; required?: string[] };
    if (schemaObj.required && Array.isArray(schemaObj.required)) {
      const data = parsed as Record<string, unknown>;
      for (const field of schemaObj.required) {
        if (data[field] === undefined || data[field] === null) {
          return {
            valid: false,
            error: `missing required field: ${field}`,
            repairs,
          };
        }
      }
    }

    // Step 6: Fill in defaults for missing optional fields (per skill)
    const data = parsed as Record<string, unknown>;
    if (skillName === 'classify' && data.confidence === undefined) {
      data.confidence = 0.5;
      repairs.push('default-confidence');
    }
    if (skillName === 'ocr' && data.language === undefined) {
      data.language = 'unknown';
      repairs.push('default-language');
    }

    return { valid: true, data: parsed, repairs };
  }
}

function appendOcrContext(prompt: string, ocrData: unknown, skillName: string): string {
  if (skillName !== 'summary') return prompt;

  const ocrText = extractOcrText(ocrData);
  if (!ocrText) return prompt;

  const maxOcrContextChars = 800;
  const clipped = ocrText.length > maxOcrContextChars
    ? `${ocrText.slice(0, maxOcrContextChars)}\n...[truncated]`
    : ocrText;
  return `${prompt}\n\nOCR context from a dedicated OCR provider. Use this text as ground truth for visible UI labels, table headers, buttons, and field names. Do not invent text that conflicts with this OCR context.\n\n${clipped}`;
}

// ── Retry prompt enhancement ────────────────────────────

function enhancePromptForRetry(originalPrompt: string, error: string): string {
  let hint = '';

  if (error.includes('JSON parse failed')) {
    hint = 'IMPORTANT: Your previous response was not valid JSON. Output ONLY raw JSON, no markdown, no explanation.';
  } else if (error.includes('missing required field')) {
    const field = error.replace('missing required field: ', '');
    hint = `IMPORTANT: Your previous response was missing the required field "${field}". Include ALL required fields.`;
  } else {
    hint = 'IMPORTANT: Your previous response was invalid. Please output valid JSON only.';
  }

  return originalPrompt + '\n\n' + hint;
}

/**
 * When the model outputs plain text (natural language) instead of JSON,
 * convert the text into the expected JSON structure per skill.
 *
 * This is the PRIMARY parsing path for SmolVLM-500M, which doesn't
 * reliably output structured JSON.
 */
// ── Post-classify heuristic ─────────────────────────────
// SmolVLM-500M has a strong bias toward "document" for any image with
// content. When the summary text clearly describes a non-text scene, use
// keyword signals to infer a better category. Returns null if no signal.

interface CategorySignal {
  category: string;
  keywords: RegExp;
}

interface CategoryInference {
  category: string;
  matchCount: number;
  priorityIndex: number;
  confidence: number;
}

interface UiEvidence {
  likelyPageType: 'admin-ui';
  navigation: string[];
  actions: string[];
  fields: string[];
  tableHeaders: string[];
  values: string[];
  modules: string[];
  rawTextCount: number;
}

interface OcrItem {
  text: string;
  box?: Box;
}

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface UiLayout {
  leftSidebar: string[];
  mainContent: {
    titleCandidates: string[];
    tableHeaders: string[];
    rowValues: string[];
    rowActions: string[];
  };
  footerActions: string[];
}

export interface ComposeResultOptions {
  annotations?: unknown;
  target?: TargetQuery | undefined;
  keyContentExtraction?: unknown;
}

export interface TargetQuery {
  color?: string | undefined;
  position?: string | undefined;
  description?: string | undefined;
}

// Category exclusion rules: if modelCategory is X and summaryCategory is Y, prefer summaryCategory
// This handles cases where the model's classification conflicts with strong summary signals
const CATEGORY_EXCLUSION_RULES: Record<string, string[]> = {
  // If model says "document", summary signals for these categories should override
  'document': ['screenshot', 'diagram', 'dashboard', 'chart', 'ui', 'photo', 'illustration'],
  // If model says "photo", summary signals for these more specific categories should override
  'photo': ['screenshot', 'ui'],
  // If model says "illustration", summary signals for technical diagrams should override
  'illustration': ['diagram', 'screenshot'],
  // If model says "screenshot", summary signals for artwork should override (Phase 4)
  // This handles AI-generated/drawn images that contain technical content
  'screenshot': ['illustration'],
  // If model says "dashboard", summary signals for artwork should override (Phase 7)
  // This handles cartoon/artistic images with simple backgrounds being mistaken for dashboards
  'dashboard': ['illustration'],
  // If model falls back to "other", strong summary signals should choose a concrete category.
  'other': ['illustration', 'icon', 'logo', 'poster', 'comic', 'meme', 'map', 'diagram', 'dashboard', 'chart', 'ui', 'document', 'photo'],
};

const SUMMARY_CATEGORY_SIGNALS: CategorySignal[] = [
  // CRITICAL: Check artistic medium FIRST (media-first principle)
  // illustration / artwork - AI-generated, drawn, painted, rendered
  { category: 'illustration', keywords: /\b(sword|dragon|knight|warrior|magic|glowing|render|painted|drawn|artwork|anime|manga|fantasy|spell|rune|creature|monster|AI-generated|generated|character|cartoon|stylized|animated|illustrated|artistic|sketch|vector|cel|digital|penguin|cat|dog|bear|rabbit|fox|bird|animal|mascot|cute|adorable|scientist|lab coat|flask|test tube)\b/i },
  // Single-purpose graphic assets should beat generic UI/poster/artwork signals.
  { category: 'icon', keywords: /\b(app icon|single icon|emoji-style|glyph|rounded square|favicon|launcher icon)\b/i },
  { category: 'logo', keywords: /\b(brand logo|logo mark|wordmark|logotype|brand mark|abstract mark|minimalist logo)\b/i },
  // Designed text+graphic layouts.
  { category: 'poster', keywords: /\b(poster|flyer|event flyer|advertisement|promo graphic|large title text|date and venue|venue)\b/i },
  // Sequential-art and meme layouts.
  { category: 'comic', keywords: /\b(comic strip|comic panel|comic panels|speech bubbles?|manga panel|sequential art|three panels?)\b/i },
  { category: 'meme', keywords: /\b(meme|top text|bottom text|reaction photo|reaction image|captioned image|overlaid meme text)\b/i },
  // Geographic/floor-plan maps.
  { category: 'map', keywords: /\b(geographic map|street map|road map|route marker|city labels?|roads?|river|floor plan|map with)\b/i },
  // Then check for specific technical visual artifacts
  { category: 'screenshot', keywords: /\b(code|programming|terminal|console|editor|IDE|command line|bash|python|javascript|typescript|coding|laptop|computer|monitors? displaying|screen showing|working on)\b/i },
  { category: 'diagram', keywords: /\b(flowchart|architecture|workflow|diagram|boxes?|arrows?|connections?|nodes?|schema|process flow|system design|blueprint)\b/i },
  { category: 'dashboard', keywords: /\b(dashboard|kpi|metric|scorecard|gauge)\b|\b(multiple|several) panels?\b/i },
  { category: 'chart', keywords: /\b(bar chart|line chart|pie|graph|axis|data point|trend|sales|quarter|revenue)\b/i },
  { category: 'ui', keywords: /\b(button|menu|sidebar|toolbar|toggle|checkbox|dialog|window|app|interface|panel|settings|form|input)\b|菜单|首页|管理|配置|操作|编辑|详情|停用|启用|保存|取消|新增|删除|查询|筛选|表格|字段|按钮|分类|价格|状态|页面|界面/i },
  // genuine document
  { category: 'document', keywords: /\b(invoice|receipt|letter|contract|form|page of text|paragraph|printed|scanned|signature|stamp)\b/i },
  // photo of people / real-world scene
  { category: 'photo', keywords: /\b(girl|boy|man|woman|person|people|standing|sitting|walking|room|kitchen|outdoor|indoor|selfie|portrait|chair|table|couple|family|child)\b/i },
];

function inferCategoryFromSummary(summary: string): CategoryInference | null {
  const lower = summary.toLowerCase();
  
  // Phase 6: Check secondary artwork signals FIRST (before primary signals)
  // This acts as a pre-filter to detect artistic rendering based on color/atmosphere combinations
  const colorWords = /\b(hues?|vibrant|saturated|intense|dramatic|glowing|vivid|atmospheric|cinematic)\b/gi;
  const characterWords = /\b(person|character|figure|boy|girl|man|woman)\b/gi;
  
  const colorMatches = lower.match(colorWords);
  const characterMatches = lower.match(characterWords);
  
  if (colorMatches && characterMatches && colorMatches.length >= 1 && characterMatches.length >= 1) {
    // Secondary signal detected: color descriptions + character = likely artwork
    const matchCount = colorMatches.length + characterMatches.length;
    const baseConfidence = 0.5;
    const matchBonus = Math.min(matchCount * 0.03, 0.15); // Lower bonus than primary signals
    const confidence = Math.min(baseConfidence + matchBonus, 0.65); // Cap at 0.65 for secondary signals
    
    return { category: 'illustration', matchCount, priorityIndex: 0, confidence };
  }
  
  // Check primary signals from SUMMARY_CATEGORY_SIGNALS
  for (let i = 0; i < SUMMARY_CATEGORY_SIGNALS.length; i++) {
    const { category, keywords } = SUMMARY_CATEGORY_SIGNALS[i]!;
    
    // Count how many keywords match
    const matches = lower.match(keywords);
    if (matches) {
      const matchCount = matches.length;
      
      // Calculate dynamic confidence
      // Base: 0.5, Match bonus: +0.05 per match (max +0.2), Priority bonus: high priority gets more
      const baseConfidence = 0.5;
      const matchBonus = Math.min(matchCount * 0.05, 0.2);
      const priorityBonus = (SUMMARY_CATEGORY_SIGNALS.length - i) * 0.02;
      const confidence = Math.min(baseConfidence + matchBonus + priorityBonus, 0.75);
      
      return { category, matchCount, priorityIndex: i, confidence };
    }
  }
  
  return null;
}

function wrapAsJson(text: string, skillName: string): string | null {
  const cleaned = text.trim().replace(/^["']|["']$/g, '');

  switch (skillName) {
    case 'classify': {
      const categories = ['dashboard', 'chart', 'diagram', 'document', 'poster',
        'ui', 'screenshot', 'photo', 'illustration', 'logo', 'icon', 'map', 'comic', 'meme', 'other'];
      const lower = cleaned.toLowerCase().replace(/[.'"]/g, '');
      // Match whole-word only so 'document' doesn't match 'documentation'.
      const match = categories.find((c) => new RegExp(`\\b${c}\\b`).test(lower));
      return JSON.stringify({
        category: match ?? 'other',
        confidence: match ? 0.7 : 0.3,
      });
    }
    case 'summary': {
      // Use the raw text as the description
      const description = cleaned.length > 0 ? cleaned : 'Unable to describe image.';
      return JSON.stringify({ description });
    }
    case 'ocr': {
      // Split by newlines to get individual text items
      if (cleaned.length === 0 || cleaned.toUpperCase() === 'NONE') {
        return JSON.stringify({ texts: [], language: 'unknown' });
      }
      const lines = cleaned.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      const texts = lines.map((line) => ({
        text: line,
        position: 'center',
        confidence: 0.7,
      }));
      // Simple language detection
      const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(cleaned);
      const language = hasCJK ? 'zh' : 'en';
      return JSON.stringify({ texts, language });
    }
    default:
      // Generic: wrap as {result: text}
      if (cleaned.length > 0) {
        return JSON.stringify({ result: cleaned });
      }
      return null;
  }
}

// ── Result Composer ─────────────────────────────────────

/**
 * Compose Skill results into a unified VisionResult.
 * @see Docs/01-architecture/05-skill-engine.md (§6.3 Result Composer)
 */
export function composeResult(
  results: SkillResultSet,
  provider: string,
  runtime: string,
  durationMs: number,
  options: ComposeResultOptions = {},
): VisionResult {
  const skillsRan = Object.keys(results);
  const skillsSucceeded = skillsRan.filter((s) => results[s]!.success);

  const ocrResult = results['ocr'];
  const ocrLines = ocrResult?.success && ocrResult.data ? extractOcrLines(ocrResult.data) : [];
  const ocrItems = ocrResult?.success && ocrResult.data ? extractOcrItems(ocrResult.data) : [];
  const ocrText = ocrLines.length > 0 ? ocrLines.join('\n') : undefined;
  const uiEvidence = buildUiEvidence(ocrLines);
  const layout = buildUiLayout(ocrItems);

  // Get category from classify if available
  let category = 'unknown';
  let confidence = 0;
  const classifyResult = results['classify'];
  let originalCategory: string | undefined;
  let originalConfidence: number | undefined;
  if (classifyResult?.success && classifyResult.data) {
    const data = classifyResult.data as Record<string, unknown>;
    if (data.category) {
      category = String(data.category);
      originalCategory = category;
    }
    if (data.confidence) {
      confidence = Number(data.confidence);
      originalConfidence = confidence;
    }
  }

  // Get summary text
  let summary = '';
  const summaryResult = results['summary'];
  if (summaryResult?.success && summaryResult.data) {
    const data = summaryResult.data as Record<string, unknown>;
    summary = String(data.description ?? data.summary ?? '');
  }

  // Post-classify heuristic: Apply category exclusion rules
  // When the classifier's category conflicts with strong summary signals,
  // correct the category using the exclusion rules and dynamic confidence.
  const evidenceText = [summary, ocrText].filter((text): text is string => Boolean(text)).join('\n');
  const exclusionList = CATEGORY_EXCLUSION_RULES[category];
  if (uiEvidence && ['document', 'other', 'unknown', 'screenshot'].includes(category)) {
    category = 'ui';
    confidence = Math.max(confidence, 0.75);
  } else if (exclusionList && evidenceText.length > 0) {
    const inference = inferCategoryFromSummary(evidenceText);
    if (inference && exclusionList.includes(inference.category)) {
      logger.info('Post-classify heuristic corrected category', {
        from: category,
        to: inference.category,
        matchCount: inference.matchCount,
        priorityIndex: inference.priorityIndex,
        dynamicConfidence: inference.confidence,
        summaryPreview: evidenceText.slice(0, 80),
        exclusionRule: `${category} -> [${exclusionList.join(', ')}]`,
      });
      category = inference.category;
      confidence = inference.confidence; // Use dynamic confidence
    } else if (inference?.category === category) {
      // Summary confirms the model's category — keep, but flag if confidence was default
      if (confidence === 0.7) confidence = 0.65;
    } else {
      // No strong signal from summary — model may have defaulted; lower confidence
      if (confidence >= 0.7) confidence = 0.5;
    }
  } else if (category === 'document' && summary.length === 0) {
    // Special case: no summary content for "document" — likely model default
    if (confidence >= 0.7) confidence = 0.5;
  }

  const ocrDrivenSummary = uiEvidence ? buildOcrDrivenUiSummary(uiEvidence) : undefined;
  if (ocrDrivenSummary && shouldPreferOcrDrivenSummary(summary, ocrText)) {
    summary = ocrDrivenSummary;
  }
  if (options.keyContentExtraction) {
    summary = appendKeyContentSummary(summary, options.keyContentExtraction);
  } else if (hasRedBoxes(options.annotations)) {
    summary = appendAnnotationSummary(summary, options.annotations);
  }

  // Build result map (only successful results)
  const resultMap: Record<string, unknown> = {};
  for (const skillName of skillsRan) {
    const result = results[skillName]!;
    if (result.success && result.data) {
      if (skillName === 'classify' && typeof result.data === 'object' && result.data !== null) {
        const normalized = { ...(result.data as Record<string, unknown>) };
        normalized.category = category;
        normalized.confidence = confidence;
        if (originalCategory && originalCategory !== category) {
          normalized.originalCategory = originalCategory;
        }
        if (originalConfidence !== undefined && originalConfidence !== confidence) {
          normalized.originalConfidence = originalConfidence;
        }
        resultMap[skillName] = normalized;
      } else {
        resultMap[skillName] = result.data;
      }
    } else {
      resultMap[skillName] = {
        error: result.error ?? 'unknown',
        partial: true,
      };
    }
  }

  if (uiEvidence) {
    resultMap.ui = uiEvidence;
  }
  if (layout) {
    resultMap.layout = layout;
  }
  if (options.annotations) {
    resultMap.annotations = options.annotations;
  }
  if (options.keyContentExtraction) {
    resultMap.targetExtraction = options.keyContentExtraction;
  }

  const visionResult: VisionResult = {
    category,
    confidence,
    summary,
    skills: skillsSucceeded,
    result: resultMap,
    metadata: {
      provider,
      runtime,
      duration: durationMs,
      cached: false,
    },
  };

  if (ocrText !== undefined) {
    visionResult.ocrText = ocrText;
  }

  return visionResult;
}

function extractOcrText(data: unknown): string | undefined {
  const lines = extractOcrLines(data);
  return lines.length > 0 ? lines.join('\n') : '';
}

function extractOcrLines(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) return [];
  const texts = (data as { texts?: unknown }).texts;
  if (!Array.isArray(texts)) return [];

  return texts
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (typeof item === 'object' && item !== null) {
        const text = (item as { text?: unknown }).text;
        return typeof text === 'string' ? text.trim() : '';
      }
      return '';
    })
    .filter((line) => line.length > 0);
}

function extractOcrItems(data: unknown): OcrItem[] {
  if (typeof data !== 'object' || data === null) return [];
  const texts = (data as { texts?: unknown }).texts;
  if (!Array.isArray(texts)) return [];

  return texts
    .map((item): OcrItem | undefined => {
      if (typeof item === 'string') {
        const text = item.trim();
        return text ? { text } : undefined;
      }
      if (typeof item !== 'object' || item === null) return undefined;
      const text = (item as { text?: unknown }).text;
      if (typeof text !== 'string' || text.trim().length === 0) return undefined;
      const position = (item as { position?: unknown }).position;
      const box = typeof position === 'string' ? parseBox(position) : undefined;
      return {
        text: text.trim(),
        ...(box ? { box } : {}),
      };
    })
    .filter((item): item is OcrItem => item !== undefined);
}

function parseBox(position: string): Box | undefined {
  const parts = position.split(',').map((value) => Number(value.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return undefined;
  const [x1, y1, x2, y2] = parts as [number, number, number, number];
  return { x1, y1, x2, y2 };
}

function buildUiEvidence(lines: string[]): UiEvidence | undefined {
  if (lines.length < 8) return undefined;

  const uiSignalCount = lines.filter((line) => /菜单|首页|管理|配置|操作|编辑|详情|停用|启用|保存|取消|新增|删除|查询|筛选|分类|价格|状态|CODE|POS/i.test(line)).length;
  if (uiSignalCount < 4) return undefined;

  const navigation = unique(lines.filter((line) => /菜单|首页|管理|配置|分类|POS|比萨/.test(line)).slice(0, 12));
  const actions = unique(lines.filter((line) => /操作|编辑|详情|停用|启用|保存|取消|新增|删除|查询|配置价格/.test(line)).slice(0, 12));
  const fields = unique(lines.filter((line) => /名称|价格|价|CODE|状态|分类|字段|尺寸|默认|半份/.test(line)).slice(0, 12));
  const tableHeaders = unique(lines.filter((line) => /名称|价格|价|CODE|状态|分类|字段|尺寸|默认|半份|操作/.test(line)).slice(0, 12));
  const values = unique(lines.filter((line) => /^(?:\d+(?:\.\d+)?|\d+".*|Mini)$/i.test(line)).slice(0, 12));
  const modules = unique(lines.filter((line) => /管理|配置|中心/.test(line)).slice(0, 12));

  return {
    likelyPageType: 'admin-ui',
    navigation,
    actions,
    fields,
    tableHeaders,
    values,
    modules,
    rawTextCount: lines.length,
  };
}

function buildUiLayout(items: OcrItem[]): UiLayout | undefined {
  const boxedItems = items.filter((item): item is OcrItem & { box: Box } => item.box !== undefined);
  if (boxedItems.length < 8) return undefined;

  const maxX = Math.max(...boxedItems.map((item) => item.box.x2));
  const maxY = Math.max(...boxedItems.map((item) => item.box.y2));
  const sidebarBoundary = Math.max(260, maxX * 0.25);
  const footerStart = maxY * 0.82;

  const leftSidebar = unique(boxedItems
    .filter((item) => item.box.x1 <= sidebarBoundary)
    .map((item) => item.text));
  const mainItems = boxedItems.filter((item) => item.box.x1 > sidebarBoundary);
  const footerActions = unique(boxedItems
    .filter((item) => item.box.y1 >= footerStart && /取消|保存|确定|提交|关闭/.test(item.text))
    .map((item) => item.text));
  const tableHeaders = unique(mainItems
    .filter((item) => /名称|价格|价|CODE|状态|分类|字段|尺寸|默认|半份|操作/.test(item.text))
    .map((item) => item.text));
  const rowValues = unique(mainItems
    .filter((item) => /^(?:\d+(?:\.\d+)?|\d+".*|Mini)$/i.test(item.text))
    .map((item) => item.text));
  const rowActions = unique(mainItems
    .filter((item) => /编辑|详情|停用|启用|配置价格|删除|查看/.test(item.text))
    .map((item) => item.text));
  const titleCandidates = unique(mainItems
    .filter((item) => /管理|配置|中心/.test(item.text) && !leftSidebar.includes(item.text))
    .map((item) => item.text)
    .slice(0, 8));

  return {
    leftSidebar,
    mainContent: {
      titleCandidates,
      tableHeaders,
      rowValues,
      rowActions,
    },
    footerActions,
  };
}

function buildOcrDrivenUiSummary(evidence: UiEvidence): string {
  const parts = ['这是一个中文后台管理系统页面。'];
  if (evidence.navigation.length > 0) {
    parts.push(`左侧导航或页面模块包含${evidence.navigation.join('、')}。`);
  }
  if (evidence.fields.length > 0) {
    parts.push(`主内容区域可见字段或表格列包括${evidence.fields.join('、')}。`);
  }
  if (evidence.actions.length > 0) {
    parts.push(`可见操作包括${evidence.actions.join('、')}。`);
  }
  parts.push(`OCR 共识别到 ${evidence.rawTextCount} 条文本，以上中文标签应作为页面内容理解的主要依据。`);
  return parts.join('');
}

function shouldPreferOcrDrivenSummary(summary: string, ocrText: string | undefined): boolean {
  if (!summary.trim()) return true;
  if (!ocrText) return false;
  if (summary.length < 80 && /[\u4e00-\u9fff]/.test(summary)) return true;
  return ocrText.includes(summary.trim());
}

function hasRedBoxes(annotations: unknown): boolean {
  if (typeof annotations !== 'object' || annotations === null) return false;
  const redBoxes = (annotations as { redBoxes?: unknown }).redBoxes;
  return Array.isArray(redBoxes) && redBoxes.length > 0;
}

function appendAnnotationSummary(summary: string, annotations: unknown): string {
  if (!hasRedBoxes(annotations)) return summary;
  const redBoxes = (annotations as { redBoxes: Array<Record<string, unknown>> }).redBoxes;
  const textGroups = redBoxes
    .map((box) => {
      const inside = Array.isArray(box.insideText) ? box.insideText.filter((text): text is string => typeof text === 'string') : [];
      const nearby = Array.isArray(box.nearbyText) ? box.nearbyText.filter((text): text is string => typeof text === 'string') : [];
      return unique([...inside, ...nearby]).slice(0, 8).join('、');
    })
    .filter((text) => text.length > 0);
  const annotationText = textGroups.length > 0
    ? `红框标注区域包含或靠近：${textGroups.join('；')}。`
    : `检测到 ${redBoxes.length} 个红框标注区域。`;
  return summary ? `${summary}${annotationText}` : annotationText;
}

function appendKeyContentSummary(summary: string, extraction: unknown): string {
  if (typeof extraction !== 'object' || extraction === null) return summary;
  const extractionSummary = (extraction as { summary?: unknown }).summary;
  if (typeof extractionSummary !== 'string' || extractionSummary.length === 0) return summary;
  return summary ? `${summary}${extractionSummary}` : extractionSummary;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
