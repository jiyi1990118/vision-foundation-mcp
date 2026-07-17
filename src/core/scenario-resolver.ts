/**
 * Scenario Resolver - detects the analysis scenario for a request and decides
 * the strategy: which skills to run, whether to skip the VLM `summary` skill,
 * and which structured extractor to invoke post-OCR.
 *
 * The "requirement analysis strategy" (P0-1/2/3) established a robust pattern:
 * detect scenario -> skip hallucination-prone VLM summary -> use dedicated OCR
 * (paddle-ocr) -> structural/algorithmic extraction -> compose result from OCR
 * + structured data.  This module generalizes that pattern to all scenarios.
 *
 * @see Docs/01-architecture/03-execution-planner.md
 */
import type { ImageAnnotations } from './annotation-detector.js';

export type ScenarioType =
  | 'requirement'
  | 'chart'
  | 'diagram'
  | 'invoice'
  | 'code'
  | 'form'
  | 'general';

export interface ScenarioDetection {
  scenario: ScenarioType;
  /** Whether to skip the VLM `summary` skill (use OCR/algorithm-driven summary). */
  skipSummary: boolean;
  /** Whether this scenario should run structured extraction after OCR+classify. */
  shouldExtract: boolean;
  /** Human-readable label for logging / result metadata. */
  label: string;
}

export interface ScenarioDetectInput {
  intent: string;
  /** Classify result category (e.g. 'ui', 'chart', 'diagram', 'document'). */
  category?: string | undefined;
  /** Whether annotation boxes (red/blue/...) were detected. */
  hasAnnotations?: boolean | undefined;
  /** Explicit target query present. */
  hasTarget?: boolean | undefined;
}

interface ScenarioRule {
  scenario: ScenarioType;
  label: string;
  intentKeywords: string[];
  /** Categories (from classify) that indicate this scenario. */
  categories: string[];
}

// Order matters: more specific scenarios first.  `general` is the fallback.
const SCENARIO_RULES: ScenarioRule[] = [
  {
    scenario: 'requirement',
    label: '需求分析',
    intentKeywords: [
      'requirement', 'tapd', 'prd', 'product', 'story', 'jira', 'confluence', 'feishu', 'lark', 'dingtalk',
      'prototype', 'wireframe', '需求', '产品', '原型', '迭代', '缺陷', '任务', '用例', '飞书', '钉钉',
    ],
    categories: ['ui', 'screenshot'],
  },
  {
    scenario: 'chart',
    label: '数据图表',
    intentKeywords: [
      'chart', 'graph', 'dashboard', 'kpi', 'metric', '数据图', '图表', '柱状', '折线', '饼图', '趋势', '指标', '看板',
    ],
    categories: ['chart', 'dashboard'],
  },
  {
    scenario: 'diagram',
    label: '流程图/架构图',
    intentKeywords: [
      'diagram', 'flowchart', 'flow chart', 'architecture', '流程图', '架构图', '拓扑', '流向', '时序图', '思维导图',
    ],
    categories: ['diagram'],
  },
  {
    scenario: 'invoice',
    label: '票据/文档',
    intentKeywords: [
      'invoice', 'receipt', 'bill', '票据', '发票', '收据', '账单', '明细', '报销', '对账',
    ],
    categories: ['document'],
  },
  {
    scenario: 'code',
    label: '代码截图',
    intentKeywords: ['code', '代码', '源码', '代码片段', 'snippet', 'terminal', '终端', 'console'],
    categories: ['screenshot'],
  },
  {
    scenario: 'form',
    label: '表单',
    intentKeywords: ['form', '表单', '填写', '问卷', '字段表'],
    categories: ['document', 'ui'],
  },
];

/**
 * Detect the scenario for a request.  Combines intent keywords with the
 * classify category for robustness: a keyword hit OR a matching category
 * triggers the scenario (keyword takes precedence for specificity).
 */
export function detectScenario(input: ScenarioDetectInput): ScenarioDetection {
  const lower = input.intent.toLowerCase();

  for (const rule of SCENARIO_RULES) {
    const intentHit = rule.intentKeywords.some((kw) => lower.includes(kw));
    const categoryHit = input.category !== undefined && rule.categories.includes(input.category);

    if (intentHit || categoryHit) {
      // All structured scenarios skip VLM summary (hallucination-prone on
      // dense text / UI / charts) and run extraction.
      return {
        scenario: rule.scenario,
        skipSummary: true,
        shouldExtract: true,
        label: rule.label,
      };
    }
  }

  // Requirement scenario also triggers on annotation boxes even without
  // explicit keywords (e.g. "auto" intent on a screenshot with red boxes).
  if (input.hasAnnotations || input.hasTarget) {
    return {
      scenario: 'requirement',
      skipSummary: true,
      shouldExtract: true,
      label: '需求分析',
    };
  }

  return {
    scenario: 'general',
    skipSummary: false,
    shouldExtract: false,
    label: '通用分析',
  };
}

/**
 * Whether a scenario should skip the VLM summary skill.
 * Delegate used by the planner.
 */
export function shouldSkipSummaryForScenario(
  intent: string,
  category: string | undefined,
  annotations: ImageAnnotations | undefined,
  hasTarget: boolean,
): boolean {
  return detectScenario({
    intent,
    category,
    hasAnnotations: (annotations?.coloredBoxes?.length ?? annotations?.redBoxes.length ?? 0) > 0,
    hasTarget,
  }).skipSummary;
}
