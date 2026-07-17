import { describe, expect, it } from 'vitest';
import {
  detectScenario,
  shouldSkipSummaryForScenario,
} from '../src/core/scenario-resolver.js';
import {
  detectChartType,
  extractCategories,
  extractMetrics,
  extractTitle,
} from '../src/core/extractors/chart-extractor.js';
import {
  buildNodes,
  detectFlowDirection,
  inferEdges,
  extractConditions,
} from '../src/core/extractors/diagram-extractor.js';
import {
  detectDocumentType,
  extractFields,
  extractLineItems,
  partitionZones,
} from '../src/core/extractors/document-extractor.js';
import {
  detectLanguage,
  detectLineNumbers,
  reconstructLines,
  stripLineNumbers,
} from '../src/core/extractors/code-extractor.js';
import {
  detectCheckState,
  extractFormFields,
} from '../src/core/extractors/form-extractor.js';
import type { OcrItem } from '../src/core/key-content-extractor.js';

// Helper: create an OcrItem with a box.
function item(text: string, x1: number, y1: number, x2: number, y2: number, source: 'full' | 'local' = 'full'): OcrItem {
  return { text, box: { x1, y1, x2, y2 }, source };
}

// ── Scenario Resolver ─────────────────────────────────────

describe('scenario-resolver', () => {
  it('detects requirement scenario from product/PRD keywords', () => {
    const d = detectScenario({ intent: '分析这个 PRD 产品需求文档' });
    expect(d.scenario).toBe('requirement');
    expect(d.skipSummary).toBe(true);
    expect(d.shouldExtract).toBe(true);
  });

  it('detects requirement scenario from TAPD/jira/confluence/feishu keywords', () => {
    for (const intent of ['看这个 jira story', '飞书需求文档', 'confluence 页面内容', '钉钉迭代']) {
      expect(detectScenario({ intent }).scenario).toBe('requirement');
    }
  });

  it('detects chart scenario from intent + category', () => {
    expect(detectScenario({ intent: '提取图表中的数据', category: 'chart' }).scenario).toBe('chart');
    expect(detectScenario({ intent: '看这个 dashboard KPI 指标' }).scenario).toBe('chart');
  });

  it('detects diagram scenario from keywords', () => {
    expect(detectScenario({ intent: '解析流程图节点' }).scenario).toBe('diagram');
    expect(detectScenario({ intent: '分析架构图' }).scenario).toBe('diagram');
  });

  it('detects invoice scenario from keywords', () => {
    expect(detectScenario({ intent: '提取发票金额', category: 'document' }).scenario).toBe('invoice');
  });

  it('detects code scenario', () => {
    expect(detectScenario({ intent: '识别这段代码' }).scenario).toBe('code');
  });

  it('detects form scenario', () => {
    expect(detectScenario({ intent: '提取表单字段' }).scenario).toBe('form');
  });

  it('falls back to requirement when annotations present even on auto intent', () => {
    expect(detectScenario({ intent: 'auto', hasAnnotations: true }).scenario).toBe('requirement');
  });

  it('falls back to general for plain describe intent', () => {
    const d = detectScenario({ intent: '描述这张图片' });
    expect(d.scenario).toBe('general');
    expect(d.skipSummary).toBe(false);
  });

  it('shouldSkipSummaryForScenario returns true for all structured scenarios', () => {
    expect(shouldSkipSummaryForScenario('提取图表数据', 'chart', undefined, false)).toBe(true);
    expect(shouldSkipSummaryForScenario('分析架构图', 'diagram', undefined, false)).toBe(true);
    expect(shouldSkipSummaryForScenario('描述图片', 'photo', undefined, false)).toBe(false);
  });
});

// ── Chart Extractor ─────────────────────────────────────

describe('chart-extractor', () => {
  it('detects chart type from keywords', () => {
    expect(detectChartType('chart', [item('柱状图', 0, 0, 10, 10)])).toBe('bar');
    expect(detectChartType('chart', [item('折线趋势', 0, 0, 10, 10)])).toBe('line');
    expect(detectChartType('chart', [item('饼图占比', 0, 0, 10, 10)])).toBe('pie');
    expect(detectChartType('dashboard', [])).toBe('dashboard');
    expect(detectChartType('table', [])).toBe('table');
  });

  it('extracts metrics: label-value pairs', () => {
    const items = [
      item('GMV', 10, 10, 50, 30),
      item('1,234.56', 10, 40, 60, 60),
      item('转化率', 10, 70, 50, 90),
      item('23.4%', 10, 100, 50, 120),
    ];
    const metrics = extractMetrics(items);
    // Standalone numbers with units should be picked up.
    expect(metrics.length).toBeGreaterThan(0);
  });

  it('rejects coordinate-like strings as metrics', () => {
    const metrics = extractMetrics([item('10,20,100,200', 0, 0, 10, 10)]);
    expect(metrics).toHaveLength(0);
  });

  it('extracts categories from bottom axis region', () => {
    const items = [
      item('一月', 10, 10, 50, 30),
      item('二月', 60, 10, 100, 30),
      item('柱1', 10, 200, 50, 220),
      item('柱2', 60, 200, 100, 220),
    ];
    const cats = extractCategories(items, 'bar');
    expect(cats.length).toBeGreaterThan(0);
  });

  it('extracts title from top-most line', () => {
    const items = [item('月度销售报表', 10, 5, 200, 25), item('数据', 10, 100, 50, 120)];
    expect(extractTitle(items)).toBe('月度销售报表');
  });
});

// ── Diagram Extractor ────────────────────────────────────

describe('diagram-extractor', () => {
  it('builds nodes by clustering same-y-band items', () => {
    const items = [
      item('开始', 100, 50, 160, 80),
      item('处理订单', 100, 150, 180, 180),
      item('结束', 100, 250, 160, 280),
    ];
    const nodes = buildNodes(items);
    expect(nodes).toHaveLength(3);
    expect(nodes[0]!.label).toBe('开始');
  });

  it('detects top-down flow direction for vertical layout', () => {
    const nodes = [
      { id: 0, label: 'A', box: { x1: 100, y1: 50, x2: 150, y2: 80 }, next: [] },
      { id: 1, label: 'B', box: { x1: 100, y1: 200, x2: 150, y2: 230 }, next: [] },
    ];
    expect(detectFlowDirection(nodes)).toBe('top-down');
  });

  it('detects left-right flow direction for horizontal layout', () => {
    const nodes = [
      { id: 0, label: 'A', box: { x1: 50, y1: 100, x2: 80, y2: 130 }, next: [] },
      { id: 1, label: 'B', box: { x1: 300, y1: 100, x2: 330, y2: 130 }, next: [] },
    ];
    expect(detectFlowDirection(nodes)).toBe('left-right');
  });

  it('infers edges connecting each node to nearest downstream neighbor', () => {
    const nodes = [
      { id: 0, label: 'A', box: { x1: 100, y1: 50, x2: 150, y2: 80 }, next: [] },
      { id: 1, label: 'B', box: { x1: 100, y1: 150, x2: 150, y2: 180 }, next: [] },
      { id: 2, label: 'C', box: { x1: 100, y1: 250, x2: 150, y2: 280 }, next: [] },
    ];
    const edges = inferEdges(nodes, 'top-down');
    expect(edges).toContainEqual([0, 1]);
    expect(edges).toContainEqual([1, 2]);
  });

  it('extracts branch conditions', () => {
    const items = [item('是', 0, 0, 10, 10), item('否', 20, 0, 30, 10), item('处理', 0, 20, 30, 30)];
    const conds = extractConditions(items);
    expect(conds).toEqual(['是', '否']);
  });

  it('marks decision nodes by keyword', () => {
    const items = [item('是否登录?', 100, 100, 200, 130)];
    const nodes = buildNodes(items);
    expect(nodes[0]!.isDecision).toBe(true);
  });
});

// ── Document Extractor ──────────────────────────────────

describe('document-extractor', () => {
  it('detects invoice type from keywords', () => {
    expect(detectDocumentType('document', '发票', [])).toBe('invoice');
    expect(detectDocumentType('document', '收据', [])).toBe('receipt');
    expect(detectDocumentType('document', '账单', [])).toBe('bill');
  });

  it('partitions into header/body/footer zones', () => {
    const items = [
      item('title', 50, 10, 100, 30),
      item('body1', 50, 100, 100, 120),
      item('body2', 50, 150, 100, 170),
      item('footer', 50, 280, 100, 300),
    ];
    const zones = partitionZones(items);
    expect(zones.header.length).toBeGreaterThan(0);
    expect(zones.body.length).toBeGreaterThan(0);
    expect(zones.footer.length).toBeGreaterThan(0);
  });

  it('extracts invoice fields via regex', () => {
    const items: OcrItem[] = [
      { text: '发票号：012345678901234567' },
      { text: '日期：2024-01-15' },
      { text: '价税合计：¥1,234.56' },
      { text: '税额：¥123.45' },
      { text: '税号：91110000ABCDEFGH' },
    ];
    const fields = extractFields(items, 'invoice');
    const labels = fields.map((f) => f.label);
    expect(labels).toContain('发票号');
    expect(labels).toContain('价税合计');
    expect(labels).toContain('税额');
    expect(labels).toContain('税号');
  });

  it('extracts line items from body rows', () => {
    const items = [
      item('商品A', 10, 100, 80, 120),
      item('2', 90, 100, 110, 120),
      item('50.00', 120, 100, 160, 120),
      item('100.00', 170, 100, 220, 120),
    ];
    const lines = extractLineItems(items);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]!.description).toContain('商品A');
  });
});

// ── Code Extractor ──────────────────────────────────────

describe('code-extractor', () => {
  it('detects language from keywords', () => {
    expect(detectLanguage(['def foo():', '  print("hi")'], '')).toBe('python');
    expect(detectLanguage(['function foo() {', '  console.log("hi");', '}'], '')).toBe('javascript');
    expect(detectLanguage(['SELECT * FROM users'], '')).toBe('sql');
    expect(detectLanguage(['public class Main {'], '')).toBe('java');
  });

  it('detects line numbers from gutter', () => {
    expect(detectLineNumbers(['1  const x = 1;', '2  const y = 2;', '3  const z = 3;'])).toBe(true);
    expect(detectLineNumbers(['const x = 1;', 'const y = 2;'])).toBe(false);
  });

  it('strips line numbers', () => {
    expect(stripLineNumbers(['1  const x = 1;', '12  return x;'])).toEqual(['const x = 1;', 'return x;']);
  });

  it('reconstructs lines by clustering same-y tokens', () => {
    const items = [
      item('const', 10, 10, 50, 30),
      item('x', 60, 10, 80, 30),
      item('=', 90, 10, 100, 30),
      item('1', 110, 10, 120, 30),
      item('return', 10, 50, 70, 70),
      item('x', 80, 50, 100, 70),
    ];
    const lines = reconstructLines(items);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('const');
    expect(lines[1]).toContain('return');
  });
});

// ── Form Extractor ──────────────────────────────────────

describe('form-extractor', () => {
  it('detects checked/unchecked checkbox states', () => {
    expect(detectCheckState('✓ 已同意')).toBe(true);
    expect(detectCheckState('☑')).toBe(true);
    expect(detectCheckState('☐ 未勾选')).toBe(false);
    expect(detectCheckState('普通文字')).toBeUndefined();
  });

  it('extracts label:value fields', () => {
    const items: OcrItem[] = [
      { text: '用户名：张三' },
      { text: '邮箱：test@example.com' },
    ];
    const fields = extractFormFields(items);
    expect(fields.some((f) => f.label === '用户名' && f.value === '张三')).toBe(true);
    expect(fields.some((f) => f.label === '邮箱' && f.value === 'test@example.com')).toBe(true);
  });

  it('extracts checkbox fields with state', () => {
    const items = [
      item('☑', 10, 10, 30, 30),
      item('同意条款', 40, 10, 120, 30),
    ];
    const fields = extractFormFields(items);
    const check = fields.find((f) => f.control === 'checkbox');
    expect(check).toBeDefined();
    expect(check?.checked).toBe(true);
    expect(check?.label).toContain('同意条款');
  });

  it('skips complex multi-colon values', () => {
    const items: OcrItem[] = [{ text: '变动配料：左：菠萝 右：黄桃' }];
    const fields = extractFormFields(items);
    expect(fields).toHaveLength(0);
  });
});
