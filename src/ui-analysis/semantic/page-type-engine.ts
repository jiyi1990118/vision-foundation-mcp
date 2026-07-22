/**
 * Page Type Engine - infers the high-level page category (login / form / list /
 * table / dashboard / detail / setting / navigation) from a SemanticAST plus
 * LayoutIR plus OCR. This is the algorithmic "understanding" layer: the LLM is
 * optional because these heuristics encode the common page signatures.
 *
 * Each candidate page type owns a set of rules; every matched rule records a
 * signal string and raises that type's confidence (matched / total rules).
 * The highest-confidence type wins; below 0.5 the result degrades to 'unknown'.
 *
 * Pure, deterministic, no IO, no model.
 *
 * @see src/ui-analysis/ir/types.ts  (SemanticAST / LayoutIR / VisionOcrItem)
 * @see src/ui-analysis/ast/ast-builder.ts  (AST shape / node ids)
 */
import type {
  SemanticAST,
  ASTNode,
  LayoutIR,
  VisionOcrItem,
} from '../ir/types.js';

export type PageType =
  | 'login'
  | 'list'
  | 'detail'
  | 'dashboard'
  | 'form'
  | 'setting'
  | 'table'
  | 'navigation'
  | 'unknown';

export interface PageTypeResult {
  pageType: PageType;
  confidence: number;
  signals: string[];
}

export interface PageTypeInput {
  ast: SemanticAST;
  layout: LayoutIR;
  ocr?: VisionOcrItem[];
}

interface RuleContext {
  nodes: ASTNode[];
  texts: string[];
  inputCount: number;
  buttonCount: number;
  cardCount: number;
  listItemCount: number;
  tableCount: number;
  navbarTabCount: number;
  interactiveCount: number;
  componentCount: number;
  regionCount: number;
  layoutType: LayoutIR['layoutType'];
  hasTableRegion: boolean;
}

type RuleCheck = (ctx: RuleContext) => string | null;

interface PageRule {
  type: PageType;
  checks: RuleCheck[];
}

const INTERACTIVE_TYPES = new Set<ASTNode['type']>([
  'input',
  'textarea',
  'button',
  'iconButton',
  'checkbox',
  'radio',
  'switch',
  'select',
  'dropdown',
  'tab',
]);

const CONTROL_TYPES = new Set<ASTNode['type']>([
  'input',
  'textarea',
  'switch',
  'checkbox',
  'radio',
  'select',
]);

const LOGIN_KEYWORDS = ['登录', 'login', 'sign in', 'sign-in', '注册', 'register'];
const TABLE_HEADER_KEYWORDS = [
  '名称', '状态', '操作', '价格', '姓名', '时间', '数量', '金额', '类型', '编号',
];
const METRIC_KEYWORDS = [
  '统计', '数据', '总数', '合计', '率', '占比', 'metric', 'total', 'count', '%',
];
const SETTING_KEYWORDS = ['设置', 'setting', '配置', '偏好', '选项'];
const SUBMIT_KEYWORDS = [
  '提交', 'submit', '确认', '确定', '保存', '登录', '注册', '下一步', 'search', '搜索',
];

const MIN_CONFIDENCE = 0.5;

function flatten(node: ASTNode, out: ASTNode[] = []): ASTNode[] {
  out.push(node);
  for (const child of node.children) {
    flatten(child, out);
  }
  return out;
}

function collectTexts(nodes: ASTNode[], ocr: VisionOcrItem[]): string[] {
  const texts: string[] = [];
  const seen = new Set<string>();
  const add = (text: string, bbox: ASTNode['bbox']): void => {
    if (text.length === 0) return;
    const key = `${text.trim().toLowerCase()}:${bbox.x},${bbox.y},${bbox.w},${bbox.h}`;
    if (seen.has(key)) return;
    seen.add(key);
    texts.push(text);
  };
  for (const n of nodes) {
    if (n.text !== undefined) add(n.text, n.bbox);
  }
  for (const o of ocr) {
    add(o.text, o.bbox);
  }
  return texts;
}

function textContains(texts: string[], keywords: string[]): boolean {
  if (texts.length === 0) return false;
  const blob = texts.join(' ').toLowerCase();
  return keywords.some((k) => blob.includes(k.toLowerCase()));
}

function countByType(nodes: ASTNode[], predicate: (n: ASTNode) => boolean): number {
  let count = 0;
  for (const n of nodes) if (predicate(n)) count++;
  return count;
}

function hasNodeOfType(nodes: ASTNode[], type: ASTNode['type']): boolean {
  return nodes.some((n) => n.type === type);
}

function hasSubmitButton(nodes: ASTNode[], texts: string[]): boolean {
  return nodes.some((n) => n.type === 'button' || n.type === 'iconButton')
    && textContains(texts, SUBMIT_KEYWORDS);
}

const RULES: PageRule[] = [
  {
    type: 'login',
    checks: [
      (c) => (c.inputCount >= 1 && c.buttonCount >= 1 ? 'components:input+button' : null),
      (c) => (textContains(c.texts, LOGIN_KEYWORDS) ? 'ocr:登录' : null),
      (c) => (c.componentCount < 6 ? 'components:few(<6)' : null),
      (c) => (c.layoutType === 'centered' ? 'layout:centered' : null),
    ],
  },
  {
    type: 'form',
    checks: [
      (c) => (c.inputCount >= 2 ? 'components:multi-input' : null),
      (c) => (c.inputCount >= 1 && c.texts.length > 0 ? 'text:labels' : null),
      (c) => (hasSubmitButton(c.nodes, c.texts) ? 'button:submit' : null),
    ],
  },
  {
    type: 'table',
    checks: [
      (c) => (c.tableCount >= 1 || c.hasTableRegion ? 'components:table' : null),
      (c) => (textContains(c.texts, TABLE_HEADER_KEYWORDS) ? 'ocr:header-keyword' : null),
    ],
  },
  {
    type: 'list',
    checks: [
      (c) => (c.listItemCount >= 2 ? 'components:multi-listItem' : null),
      (c) => (c.listItemCount >= 1 && c.texts.length >= 3 ? 'ocr:multi-row' : null),
    ],
  },
  {
    type: 'dashboard',
    checks: [
      (c) => (c.regionCount >= 4 ? 'layout:multi-region(>=4)' : null),
      (c) => (textContains(c.texts, METRIC_KEYWORDS) ? 'ocr:metric' : null),
      (c) => (c.cardCount >= 2 ? 'components:multi-card' : null),
    ],
  },
  {
    type: 'detail',
    checks: [
      (c) => (hasNodeOfType(c.nodes, 'title') || hasNodeOfType(c.nodes, 'subtitle')
        ? 'components:title' : null),
      (c) => (hasNodeOfType(c.nodes, 'section') || hasNodeOfType(c.nodes, 'container')
        ? 'components:section' : null),
      (c) => (c.interactiveCount <= 2 ? 'components:few-interactive' : null),
    ],
  },
  {
    type: 'setting',
    checks: [
      (c) => (textContains(c.texts, SETTING_KEYWORDS) ? 'ocr:setting' : null),
      (c) => (countByType(c.nodes, (n) => CONTROL_TYPES.has(n.type)) >= 2
        ? 'components:controls' : null),
    ],
  },
  {
    type: 'navigation',
    checks: [
      (c) => (c.navbarTabCount >= 1 ? 'components:navbar/tab' : null),
      (c) => (c.navbarTabCount >= 1 && c.componentCount <= 4 ? 'content:sparse' : null),
    ],
  },
];

function buildContext(input: PageTypeInput): RuleContext {
  const ocr = input.ocr ?? [];
  const nodes = flatten(input.ast.root);
  const texts = collectTexts(nodes, ocr);
  return {
    nodes,
    texts,
    inputCount: countByType(nodes, (n) => n.type === 'input'),
    buttonCount: countByType(nodes, (n) => n.type === 'button' || n.type === 'iconButton'),
    cardCount: countByType(nodes, (n) => n.type === 'card'),
    listItemCount: countByType(nodes, (n) => n.type === 'listItem'),
    tableCount: countByType(nodes, (n) => n.type === 'table'),
    navbarTabCount: countByType(nodes, (n) => n.type === 'navbar' || n.type === 'tab'),
    interactiveCount: countByType(nodes, (n) => INTERACTIVE_TYPES.has(n.type)),
    componentCount: countByType(nodes, (n) => n.type !== 'page'),
    regionCount: input.layout.regions.length,
    layoutType: input.layout.layoutType,
    hasTableRegion: input.layout.regions.some((r) => r.type === 'table'),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Infer the page type from the SemanticAST + LayoutIR + OCR. Returns the best
 * candidate with its confidence and the list of matched signal descriptions.
 * Falls back to 'unknown' (confidence 0, no signals) when no candidate reaches
 * the 0.5 confidence floor.
 */
export function inferPageType(input: PageTypeInput): PageTypeResult {
  const ctx = buildContext(input);
  let best: { type: PageType; confidence: number; signals: string[] } = {
    type: 'unknown',
    confidence: 0,
    signals: [],
  };
  for (const rule of RULES) {
    const signals: string[] = [];
    for (const check of rule.checks) {
      const signal = check(ctx);
      if (signal !== null) signals.push(signal);
    }
    const confidence = rule.checks.length === 0 ? 0 : signals.length / rule.checks.length;
    const beats = confidence > best.confidence
      || (confidence === best.confidence && signals.length > best.signals.length);
    if (beats) {
      best = { type: rule.type, confidence, signals };
    }
  }
  if (best.confidence < MIN_CONFIDENCE) {
    return { pageType: 'unknown', confidence: 0, signals: [] };
  }
  return { pageType: best.type, confidence: round2(best.confidence), signals: best.signals };
}
