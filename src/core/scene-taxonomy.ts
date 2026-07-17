/**
 * Scene Taxonomy - maps the classify category and scenario-resolver type
 * to the Universal Parser scene classification, and provides per-scene
 * next-action templates used as a fallback when the VLM reasoning call
 * fails or hallucinates.
 *
 * The parser prompt's scene list:
 * document / requirement / ui / prototype / photo / code / table / chart /
 * flowchart / mindmap / ppt / chat / error / other
 */
import type { ParseScene } from '../types/domain.js';

/** Map a classify() category to a primary parser scene. */
const CLASSIFY_TO_SCENE: Record<string, ParseScene> = {
  dashboard: 'chart',
  chart: 'chart',
  diagram: 'flowchart',
  document: 'document',
  poster: 'ppt',
  ui: 'ui',
  screenshot: 'ui',
  photo: 'photo',
  illustration: 'other',
  logo: 'other',
  icon: 'other',
  map: 'other',
  comic: 'other',
  meme: 'other',
  other: 'other',
};

/** Map a scenario-resolver ScenarioType to a primary parser scene. */
const SCENARIO_TO_SCENE: Record<string, ParseScene> = {
  requirement: 'requirement',
  chart: 'chart',
  diagram: 'flowchart',
  invoice: 'document',
  code: 'code',
  form: 'ui',
  general: 'other',
};

/** Confidence assigned to a scene derived from the classify category. */
const CLASSIFY_SCENE_CONFIDENCE = 0.7;
/** Confidence assigned to a scene derived from intent keywords (high specificity). */
const INTENT_SCENE_CONFIDENCE = 0.9;
/** Confidence assigned to a scene derived from a user scene hint. */
const HINT_SCENE_CONFIDENCE = 0.8;

export interface SceneSignal {
  scene: ParseScene;
  confidence: number;
  reason: string;
}

/** Convert a classify category into a scene signal (if mappable). */
export function sceneFromClassify(category: string | undefined): SceneSignal | undefined {
  if (!category) return undefined;
  const scene = CLASSIFY_TO_SCENE[category];
  if (!scene) return undefined;
  return { scene, confidence: CLASSIFY_SCENE_CONFIDENCE, reason: `classify=${category}` };
}

/** Convert a scenario-resolver scenario into a scene signal (if mappable). */
export function sceneFromScenario(scenario: string | undefined): SceneSignal | undefined {
  if (!scenario || scenario === 'general') return undefined;
  const scene = SCENARIO_TO_SCENE[scenario];
  if (!scene) return undefined;
  return { scene, confidence: INTENT_SCENE_CONFIDENCE, reason: `scenario=${scenario}` };
}

/** Keywords that refine a generic scene into a more specific one. */
const SCENE_REFINEMENTS: Array<{ scene: ParseScene; keywords: RegExp; reason: string }> = [
  { scene: 'mindmap', keywords: /mind\s?map|思维导图|脑图|中心主题|分支节点/i, reason: 'mindmap keywords' },
  { scene: 'prototype', keywords: /prototype|wireframe|原型|线框|mockup|高保真/i, reason: 'prototype keywords' },
  { scene: 'ppt', keywords: /slide|presentation|幻灯片|演示文稿|ppt/i, reason: 'ppt keywords' },
  { scene: 'chat', keywords: /聊天|对话|消息|chat|message|conversation|发送|recipient/i, reason: 'chat keywords' },
  { scene: 'error', keywords: /error|exception|错误|异常|失败|failed|traceback|报错|崩溃/i, reason: 'error keywords' },
  { scene: 'table', keywords: /表格|\btable\s+(structure|data|cell|header)|\btable\b/i, reason: 'table keywords' },
];

/** Refine a base scene using OCR/intent text signals. Returns a more specific scene. */
export function refineScene(
  base: ParseScene,
  text: string,
): { scene: ParseScene; confidence: number; reason: string } | undefined {
  for (const ref of SCENE_REFINEMENTS) {
    if (ref.keywords.test(text)) {
      return { scene: ref.scene, confidence: INTENT_SCENE_CONFIDENCE, reason: ref.reason };
    }
  }
  return undefined;
}

/** Confidence boost applied to a user-provided scene hint. */
export function sceneFromHint(hint: string | undefined): SceneSignal | undefined {
  if (!hint) return undefined;
  const lower = hint.toLowerCase().trim();
  if (lower.length === 0) return undefined;
  const knownScenes: ParseScene[] = [
    'document', 'requirement', 'ui', 'prototype', 'photo', 'code', 'table',
    'chart', 'flowchart', 'mindmap', 'ppt', 'chat', 'error', 'other',
  ];
  const match = knownScenes.find((s) => lower.includes(s));
  if (!match) return undefined;
  return { scene: match, confidence: HINT_SCENE_CONFIDENCE, reason: `scene-hint=${hint}` };
}

/**
 * Per-scene next-action templates. Used as a fallback when the VLM reasoning
 * call fails or hallucinates, ensuring the agent always gets actionable guidance.
 */
export function nextActionTemplates(scene: ParseScene): string[] {
  switch (scene) {
    case 'requirement':
      return ['生成PRD文档', '拆分任务/用户故事', '评估工时与排期', '梳理验收标准'];
    case 'ui':
      return ['生成前端组件代码', '提取页面交互逻辑', '还原页面布局结构'];
    case 'prototype':
      return ['转换为高保真设计稿', '提取页面流程', '生成可交互原型'];
    case 'code':
      return ['定位异常/修复Bug', '重构代码', '补充单元测试', '梳理调用关系'];
    case 'error':
      return ['定位错误根因', '检索相似问题解决方案', '修复并验证'];
    case 'chart':
      return ['提取数据点', '生成数据表格', '分析趋势与异常'];
    case 'flowchart':
      return ['梳理流程节点', '提取决策分支', '生成流程文档'];
    case 'mindmap':
      return ['展开为结构化大纲', '提取主题层级', '生成目录树'];
    case 'table':
      return ['导出为CSV/Excel', '校验数据完整性', '统计分析'];
    case 'document':
      return ['提取关键字段', '归档分类', '核对金额/日期'];
    case 'ppt':
      return ['提取大纲', '生成演讲备注', '转换为文档'];
    case 'chat':
      return ['提取关键对话信息', '识别待办事项', '总结沟通要点'];
    case 'photo':
      return ['打标签分类', '生成图片说明', '识别主体与场景'];
    default:
      return ['提取关键信息', '总结核心内容'];
  }
}
