/**
 * Execution Planner — decides which Skills to run and which Provider to use.
 *
 * Produces a draft ExecutionPlan (Policy Engine validates/overrides it).
 *
 * @see Docs/01-architecture/03-execution-planner.md
 */
import type {
  PlannerInput,
  ExecutionPlan,
  SkillTask,
} from '../types/skills.js';
import type { ImageInput } from '../types/domain.js';
import { getSkill } from '../skills/registry.js';
import { compilePrompt } from './prompt-compiler.js';
import { logger } from '../utils/logger.js';
import { createHash } from 'node:crypto';

// ── Intent → Skill mapping ──────────────────────────────

interface IntentMapping {
  keywords: string[];
  skills: string[];
}

const INTENT_MAPPINGS: IntentMapping[] = [
  // Requirement/product screenshots need both visual understanding and text extraction.
  {
    keywords: [
      'requirement screenshot', 'prototype', 'wireframe', 'annotation', 'red box', 'highlight',
      'tapd', 'requirement image',
      '需求', '需求图片', '需求截图', '截图内容', '页面内容', '图片内容', '界面内容', '原型图', '标注', '红框', '字段', '按钮', '开关',
    ],
    skills: ['classify', 'ocr', 'summary'],
  },
  // Classification
  { keywords: ['what', 'type', 'category', 'classify', 'kind', '什么', '类型', '分类'], skills: ['classify'] },
  // OCR
  { keywords: ['text', 'ocr', 'extract', 'read', 'word', '文字', '提取', '识别'], skills: ['ocr'] },
  // Summary / description
  { keywords: ['describe', 'summary', 'explain', 'analyze', 'auto', '描述', '总结', '分析', '解析'], skills: ['classify', 'summary'] },
  // Detailed analysis
  { keywords: ['detail', 'full', 'comprehensive', '详细', '全面'], skills: ['classify', 'ocr', 'summary'] },
  // Table
  { keywords: ['table', 'spreadsheet', 'grid', '表格'], skills: ['table'] },
  // Document
  { keywords: ['document', 'page', 'letter', 'invoice', '文档', '页面'], skills: ['document'] },
  // Poster / design
  { keywords: ['poster', 'design', 'banner', 'ad', '海报', '设计'], skills: ['poster'] },
  // Moderation / safety
  { keywords: ['safe', 'moderation', 'nsfw', 'inappropriate', '审核', '安全'], skills: ['moderation'] },
  // Layout
  { keywords: ['layout', 'structure', 'arrangement', '布局', '结构'], skills: ['layout'] },
];

/**
 * Map a natural-language intent to a list of Skills.
 */
export function mapIntentToSkills(intent: string): string[] {
  const lower = intent.toLowerCase();

  for (const mapping of INTENT_MAPPINGS) {
    if (mapping.keywords.some((kw) => lower.includes(kw))) {
      return mapping.skills;
    }
  }

  // Default: auto analysis → classify + summary
  return ['classify', 'summary'];
}

export function resolveSkillNames(
  requestedSkills: string[] | undefined,
  intent: string,
  options?: PlannerInput['options'],
): string[] {
  if (requestedSkills && requestedSkills.length > 0) {
    const validSkills = requestedSkills.filter((s) => getSkill(s) !== undefined);
    if (validSkills.length > 0) return validSkills;

    logger.warn('No valid skills found in requestedSkills', { requestedSkills });
    return augmentTargetSkills(['classify', 'summary'], intent, options);
  }

  return augmentTargetSkills(mapIntentToSkills(intent), intent, options);
}

// ── Planner ─────────────────────────────────────────────

/**
 * Create a draft ExecutionPlan from a PlannerInput.
 * Does NOT execute — just decides strategy.
 */
export async function planExecution(input: PlannerInput): Promise<ExecutionPlan> {
  const { image, metadata, intent, requestedSkills, options, activeProvider, activeRuntime } = input;
  // `resources` is consulted upstream by the provider-router; the planner
  // trusts the router-selected provider and does not re-evaluate resources.
  void input.resources;

  // 1. Determine Skills
  const skillNames = resolveSkillNames(requestedSkills, intent, options);

  logger.info('Planner decision', {
    intent,
    skills: skillNames,
    requested: requestedSkills ?? 'none',
  });

  // 2. Build SkillTasks
  const mixedOcrAnalysis = skillNames.includes('ocr') && skillNames.some((name) => name !== 'ocr');
  const skills = skillNames.map((name, index) => {
    const manifest = getSkill(name)!;
    const prompt = compilePrompt(manifest, {
      intent,
      focus: focusForSkill(name, options),
      metadata,
    });

    const dependsOn = mixedOcrAnalysis
      ? dependenciesForMixedOcrAnalysis(name, skillNames)
      : name === 'summary' && skillNames.includes('classify')
        ? ['classify']
        : undefined;

    return {
      skill: name,
      prompt,
      schema: manifest.schema,
      priority: mixedOcrAnalysis ? priorityForMixedOcrAnalysis(name, index) : index,
      dependsOn,
    } satisfies SkillTask;
  });

  // 3. Determine provider/runtime.
  // Routing (resource/quality feasibility) is decided upstream by the
  // provider-router; here we trust `activeProvider` (the router-selected
  // instance) and only honour an explicit `options.provider` override.
  // We deliberately do NOT rewrite to a hardcoded legacy fallback on low
  // memory — the router already filtered out infeasible high-quality
  // providers, so the active instance is the correct one to execute.
  const provider = options.provider ?? activeProvider ?? 'smolvlm';
  const runtime = activeRuntime ?? (provider === 'smolvlm' ? 'onnx' : 'llama-cpp');

  // 4. Determine preprocess
  const preprocess: string[] = [];
  if (metadata.width > 3000 || metadata.height > 3000) {
    preprocess.push('resize');
  }

  // 5. Cache key
  const cacheKey = buildCacheKey(image, intent, skillNames, options);

  // 6. Timeout and retry (use first skill's defaults)
  const firstSkill = getSkill(skillNames[0] ?? 'classify');
  const timeout = firstSkill?.defaultTimeout ?? 30000;
  const retry = firstSkill?.defaultRetry ?? { max: 1, strategy: 'reprompt' as const };

  const plan: ExecutionPlan = {
    provider,
    runtime,
    preprocess,
    skills,
    postprocess: ['merge'],
    cacheKey,
    timeout,
    retry,
    maxTokens: options.maxTokens,
    cache: options.cache,
  };

  logger.debug('ExecutionPlan created', {
    provider: plan.provider,
    skillCount: plan.skills.length,
    preprocess: plan.preprocess,
  });

  return plan;
}

function priorityForMixedOcrAnalysis(name: string, fallback: number): number {
  if (name === 'ocr') return 0;
  if (name === 'classify') return 1;
  if (name === 'summary') return 2;
  return fallback + 3;
}

function dependenciesForMixedOcrAnalysis(name: string, skillNames: string[]): string[] | undefined {
  if (name === 'summary') {
    return ['ocr', ...(skillNames.includes('classify') ? ['classify'] : [])];
  }
  return undefined;
}

function augmentTargetSkills(
  skillNames: string[],
  intent: string,
  options?: PlannerInput['options'],
): string[] {
  if (!shouldIncludeOcrForTarget(intent, options) || skillNames.includes('ocr')) {
    return skillNames;
  }

  return [...skillNames, 'ocr'];
}

function focusForSkill(name: string, options: PlannerInput['options']): string | undefined {
  if (name !== 'ocr' || !options.target) return undefined;

  const parts = [
    options.target.color ? `color=${options.target.color}` : undefined,
    options.target.position ? `position=${options.target.position}` : undefined,
    options.target.description ? `description=${options.target.description}` : undefined,
  ].filter((part): part is string => part !== undefined);

  return parts.length > 0 ? parts.join('; ') : undefined;
}

function shouldIncludeOcrForTarget(intent: string, options?: PlannerInput['options']): boolean {
  if (options?.target) return true;

  const lower = intent.toLowerCase();
  return ['target', 'key content', 'red box', 'highlight', '目标', '关键内容', '红框', '标注'].some((keyword) => (
    lower.includes(keyword)
  ));
}

function buildCacheKey(
  image: ImageInput,
  intent: string,
  skills: string[],
  options: PlannerInput['options'],
): string {
  const imageHash = createHash('sha256').update(image.buffer).digest('hex').slice(0, 16);
  const configStr = JSON.stringify({
    intent,
    skills: [...skills].sort(),
    quality: options.quality ?? 'fast',
  });
  const configHash = createHash('sha256').update(configStr).digest('hex').slice(0, 8);
  return `${imageHash}:${configHash}`;
}
