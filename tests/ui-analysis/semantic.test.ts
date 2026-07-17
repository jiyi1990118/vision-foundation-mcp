import { describe, expect, it } from 'vitest';
import {
  inferPageType,
  inferVariants,
  buildSemanticSummary,
} from '../../src/ui-analysis/semantic/index.js';
import type {
  LayoutIR,
  SemanticAST,
  VisionOcrItem,
  LayoutTheme,
} from '../../src/ui-analysis/ir/types.js';

function layout(centered: boolean, regions: LayoutIR['regions']): LayoutIR {
  return {
    regions,
    layoutType: centered ? 'centered' : 'stack',
    spacing: { averageGap: 8, scale: 'comfortable', verticalGaps: [], horizontalGaps: [] },
  };
}

const theme: LayoutTheme = {
  palette: [],
  background: '#ffffff',
  primary: '#1677ff',
  textColor: '#000000',
  isDarkMode: false,
  contrastRatio: 21,
};

describe('semantic page-type-engine', () => {
  it('classifies a centered input+button page with login OCR as login', () => {
    const ast: SemanticAST = {
      root: {
        id: 'page',
        type: 'page',
        bbox: { x: 0, y: 0, w: 300, h: 400 },
        props: {},
        children: [
          { id: 'input1', type: 'input', bbox: { x: 50, y: 120, w: 200, h: 32 }, props: {}, children: [] },
          { id: 'btn1', type: 'button', bbox: { x: 100, y: 220, w: 100, h: 36 }, props: {}, children: [] },
        ],
      },
      version: '1.0.0',
    };
    const ocr: VisionOcrItem[] = [
      { text: '登录', bbox: { x: 100, y: 220, w: 100, h: 36 }, confidence: 0.9 },
    ];

    const res = inferPageType({ ast, layout: layout(true, [
      { id: 'r0', type: 'main', bbox: { x: 0, y: 0, w: 300, h: 400 }, relativeArea: 1, children: [] },
    ]), ocr });

    expect(res.pageType).toBe('login');
    expect(res.confidence).toBeGreaterThan(0.5);
    expect(res.signals).toContain('ocr:登录');
    expect(res.signals).toContain('layout:centered');
  });

  it('classifies a table region with header-keyword OCR as table/list', () => {
    const ast: SemanticAST = {
      root: {
        id: 'page',
        type: 'page',
        bbox: { x: 0, y: 0, w: 600, h: 400 },
        props: {},
        children: [
          { id: 'tbl', type: 'table', bbox: { x: 0, y: 0, w: 600, h: 400 }, props: {}, children: [] },
        ],
      },
      version: '1.0.0',
    };
    const ocr: VisionOcrItem[] = [
      { text: '名称', bbox: { x: 10, y: 10, w: 60, h: 20 }, confidence: 0.9 },
      { text: '状态', bbox: { x: 200, y: 10, w: 60, h: 20 }, confidence: 0.9 },
      { text: '操作', bbox: { x: 400, y: 10, w: 60, h: 20 }, confidence: 0.9 },
    ];

    const res = inferPageType({ ast, layout: layout(false, [
      { id: 'rt', type: 'table', bbox: { x: 0, y: 0, w: 600, h: 400 }, relativeArea: 1, children: [] },
    ]), ocr });

    expect(['table', 'list']).toContain(res.pageType);
    expect(res.confidence).toBeGreaterThan(0.5);
  });
});

describe('semantic variant-engine', () => {
  it('marks a button whose color matches theme.primary as primary', () => {
    const ast: SemanticAST = {
      root: {
        id: 'page',
        type: 'page',
        bbox: { x: 0, y: 0, w: 200, h: 100 },
        props: {},
        children: [
          { id: 'btn', type: 'button', bbox: { x: 50, y: 30, w: 100, h: 40 }, props: { color: '#1677ff' }, children: [] },
        ],
      },
      version: '1.0.0',
    };

    const variants = inferVariants(ast, theme);
    const btn = variants.find((v) => v.nodeId === 'btn');
    expect(btn).toBeDefined();
    expect(btn!.variant).toBe('primary');
    expect(btn!.state).toBe('default');
  });

  it('infers disabled state from button text and danger variant from a red color', () => {
    const ast: SemanticAST = {
      root: {
        id: 'page',
        type: 'page',
        bbox: { x: 0, y: 0, w: 200, h: 100 },
        props: {},
        children: [
          { id: 'btn', type: 'button', bbox: { x: 50, y: 30, w: 100, h: 40 }, props: { color: '#dd2211' }, text: '删除（已禁用）', children: [] },
        ],
      },
      version: '1.0.0',
    };

    const variants = inferVariants(ast);
    const btn = variants.find((v) => v.nodeId === 'btn')!;
    expect(btn.variant).toBe('danger');
    expect(btn.state).toBe('disabled');
  });
});

describe('semantic summary-engine', () => {
  it('produces a Chinese summary with page type and component counts', () => {
    const ast: SemanticAST = {
      root: {
        id: 'page',
        type: 'page',
        bbox: { x: 0, y: 0, w: 300, h: 400 },
        props: {},
        children: [
          { id: 'in1', type: 'input', bbox: { x: 50, y: 120, w: 200, h: 32 }, props: {}, children: [] },
          { id: 'in2', type: 'input', bbox: { x: 50, y: 160, w: 200, h: 32 }, props: {}, children: [] },
          { id: 'btn', type: 'button', bbox: { x: 100, y: 220, w: 100, h: 36 }, props: {}, children: [] },
        ],
      },
      version: '1.0.0',
    };
    const variants = inferVariants(ast);
    const summary = buildSemanticSummary({
      ast,
      pageType: 'login',
      variants,
      layout: layout(true, [
        { id: 'r0', type: 'main', bbox: { x: 0, y: 0, w: 300, h: 400 }, relativeArea: 1, children: [] },
      ]),
    });

    expect(summary).toContain('登录');
    expect(summary).toMatch(/输入框/);
    expect(summary).toContain('居中布局');
  });
});
