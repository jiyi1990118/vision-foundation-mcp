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
import { getSkill } from '../skills/registry.js';
import { compilePrompt } from './prompt-compiler.js';
import { logger } from '../utils/logger.js';

// ── Intent → Skill mapping ──────────────────────────────

interface IntentMapping {
  keywords: string[];
  skills: string[];
}

const INTENT_MAPPINGS: IntentMapping[] = [
  // Requirement / product management screenshots need both visual understanding
  // and text extraction.  Covers TAPD, Jira, Confluence, Feishu/Lark, DingTalk
  // docs, PRD, stories, iterations, defects, tasks, and any requirement image.
  {
    keywords: [
      'requirement screenshot', 'prototype', 'wireframe', 'annotation', 'red box', 'highlight',
      'tapd', 'requirement image', 'product requirement', 'prd', 'user story', 'acceptance criteria',
      'jira', 'confluence', 'feishu', 'lark', 'dingtalk',
      '需求', '需求图片', '需求截图', '需求文档', '需求规格', '需求说明', '截图内容', '页面内容', '图片内容', '界面内容',
      '原型图', '标注', '红框', '字段', '按钮', '开关',
      '产品', '产品需求', '产品文档', '产品截图', 'story', '迭代', '缺陷', '任务', '用例', '验收标准',
      '飞书', '钉钉', '知识库', '需求池', '需求评审', '需求拆解',
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
  // Table - classify in parallel so the universal parser gets a scene signal.
  { keywords: ['table', 'spreadsheet', 'grid', '表格'], skills: ['classify', 'table'] },
  // Document - classify in parallel for scene detection.
  { keywords: ['document', 'page', 'letter', 'invoice', '文档', '页面'], skills: ['classify', 'document'] },
  // Poster / design - classify in parallel for scene detection.
  { keywords: ['poster', 'design', 'banner', 'ad', '海报', '设计'], skills: ['classify', 'poster'] },
  // Moderation / safety - standalone (no scene/entities needed).
  { keywords: ['safe', 'moderation', 'nsfw', 'inappropriate', '审核', '安全'], skills: ['moderation'] },
  // Layout - classify in parallel for scene detection.
  { keywords: ['layout', 'structure', 'arrangement', '布局', '结构'], skills: ['classify', 'layout'] },
];

/**
 * Ensure `summary` always has OCR ground truth (P0 fix). The summary skill's
 * prompt instructs the model to use OCR text as ground truth, but without OCR
 * in the plan the small VLM hallucinates. Add OCR whenever summary is
 * requested and OCR is not already present.
 *
 * Exported so vision-analyze.ts can apply the same logic BEFORE provider
 * selection and override setup, ensuring the dedicated OCR provider is
 * routed for mixed-skill plans that include summary.
 */
export function ensureOcrForSummary(skillNames: string[]): string[] {
  if (skillNames.includes('summary') && !skillNames.includes('ocr')) {
    return [...skillNames, 'ocr'];
  }
  return skillNames;
}

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
  const { metadata, intent, requestedSkills, options, activeProvider, activeRuntime } = input;
  // `resources` is consulted upstream by the provider-router; the planner
  // trusts the router-selected provider and does not re-evaluate resources.
  void input.resources;

  // 1. Determine Skills
  let skillNames = resolveSkillNames(requestedSkills, intent, options);

  // P0: Ensure `summary` always has OCR ground truth. Shared with
  // vision-analyze.ts so provider overrides are set up correctly.
  skillNames = ensureOcrForSummary(skillNames);

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

  // 5. Timeout and retry (use first skill's defaults)
  const firstSkill = getSkill(skillNames[0] ?? 'classify');
  const timeout = firstSkill?.defaultTimeout ?? 30000;
  const retry = firstSkill?.defaultRetry ?? { max: 1, strategy: 'reprompt' as const };

  const plan: ExecutionPlan = {
    provider,
    runtime,
    preprocess,
    skills,
    postprocess: ['merge'],
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
  let skills = skillNames;

  // P0-3: For key-content / annotation extraction intents, skip the VLM
  // `summary` skill.  UI screenshots with annotation boxes cause the VLM to
  // hallucinate; the OCR-driven summary (composeResult ->
  // shouldPreferOcrDrivenSummary + appendKeyContentSummary) produces better
  // results from the structured OCR + key-content extraction.
  if (shouldSkipSummaryForKeyContent(intent, options)) {
    skills = skills.filter((name) => name !== 'summary');
  }

  if (!shouldIncludeOcrForTarget(intent, options) || skills.includes('ocr')) {
    return skills;
  }

  return [...skills, 'ocr'];
}

/**
 * Whether to skip the VLM `summary` skill for this request.
 * Returns true when the intent asks for structured content extraction
 * where an OCR/algorithm-driven summary is more reliable than VLM
 * hallucination.  Covers: requirement/product, chart/dashboard, diagram,
 * invoice/document, code screenshot, and form field extraction intents.
 */
function shouldSkipSummaryForKeyContent(intent: string, options?: PlannerInput['options']): boolean {
  if (options?.target) return true;

  const lower = intent.toLowerCase();
  return [
    // requirement / product / annotation
    'target', 'key content', 'red box', 'highlight', 'annotat', 'boxed', 'circled',
    '目标', '关键内容', '红框', '蓝框', '绿框', '标注', '框中', '圈出', '标出', '选中', '标记',
    '需求', '产品', '原型', '字段',
    // chart / dashboard data extraction
    'chart', 'graph', 'dashboard', 'kpi', 'metric', '数据图', '图表', '柱状', '折线', '饼图', '趋势', '指标',
    // diagram / flowchart
    'diagram', 'flowchart', 'flow chart', 'architecture', '流程图', '架构图', '拓扑', '流向',
    // invoice / document structure
    'invoice', 'receipt', '票据', '发票', '收据', '账单', '明细',
    // code screenshot
    'code', '代码', '源码', '代码片段',
    // form fields
    'form', '表单', '填写',
  ].some((keyword) => lower.includes(keyword));
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
  return [
    'target', 'key content', 'red box', 'highlight',
    '目标', '关键内容', '红框', '标注',
    'chart', 'dashboard', 'kpi', '图表', '指标',
    'diagram', 'flowchart', '流程图', '架构图',
    'invoice', 'receipt', '票据', '发票',
    'code', '代码', 'form', '表单',
  ].some((keyword) => lower.includes(keyword));
}
