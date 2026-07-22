import { describe, expect, it } from 'vitest';
import { enrichNodeTypes } from '../../src/ui-analysis/typing/index.js';
import type { SemanticAST, ASTNode, BBox, VisionOcrItem } from '../../src/ui-analysis/ir/types.js';

function box(x: number, y: number, w: number, h: number): BBox {
  return { x, y, w, h };
}
function leaf(id: string, type: ASTNode['type'], bbox: BBox, extra?: { text?: string; style?: unknown }): ASTNode {
  const props: Record<string, unknown> = {};
  if (extra?.style) props.style = extra.style;
  return { id, type, bbox, props, text: extra?.text, children: [] };
}
function ast(root: ASTNode): SemanticAST {
  return { root, version: '1.0.0' };
}
function ocr(text: string, bbox: BBox): VisionOcrItem {
  return { text, bbox, confidence: 1 };
}

describe('correctMisclassified + pruneOutOfBounds (S32)', () => {
  it('re-types a table of cards to a list of listItems', () => {
    const page = ast({
      id: 'p',
      type: 'page',
      bbox: box(0, 0, 400, 600),
      props: {},
      children: [
        {
          id: 't',
          type: 'table',
          bbox: box(0, 0, 400, 600),
          props: {},
          children: [
            leaf('c1', 'card', box(10, 10, 380, 80)),
            leaf('c2', 'card', box(10, 100, 380, 80)),
            leaf('c3', 'card', box(10, 190, 380, 80)),
          ],
        },
      ],
    });
    enrichNodeTypes(page);
    const table = page.root.children[0]!;
    expect(table.type).toBe('list');
    expect(table.children.every((c) => c.type === 'listItem')).toBe(true);
  });

  it('re-types a small saturated-bg leaf container to a button', () => {
    const page = ast({
      id: 'p',
      type: 'page',
      bbox: box(0, 0, 400, 600),
      props: {},
      children: [
        leaf('b', 'container', box(100, 400, 100, 36), { style: { backgroundColor: '#1677ff' } }),
      ],
    });
    enrichNodeTypes(page);
    expect(page.root.children[0]!.type).toBe('button');
  });

  it('re-types a large mobile footer CTA using page-relative size and action text', () => {
    const page = ast({
      id: 'p',
      type: 'page',
      bbox: box(0, 0, 1194, 2595),
      props: {},
      children: [
        leaf('cta', 'footer', box(60, 2433, 1074, 162), {
          text: '修改',
          style: { backgroundColor: '#ff4739' },
        }),
      ],
    });
    enrichNodeTypes(page);
    expect(page.root.children[0]!.type).toBe('button');
  });

  it('does not re-type a saturated structural footer without action text', () => {
    const page = ast({
      id: 'p',
      type: 'page',
      bbox: box(0, 0, 1194, 2595),
      props: {},
      children: [
        leaf('promo', 'footer', box(0, 2200, 1194, 300), {
          text: '会员专享区域',
          style: { backgroundColor: '#ff4739' },
        }),
      ],
    });
    enrichNodeTypes(page);
    expect(page.root.children[0]!.type).toBe('footer');
  });

  it('does not re-type a page-relative saturated square without action text', () => {
    const page = ast({
      id: 'p',
      type: 'page',
      bbox: box(0, 0, 1194, 2595),
      props: {},
      children: [
        leaf('swatch', 'container', box(60, 600, 87, 87), {
          style: { backgroundColor: '#fe6043' },
        }),
      ],
    });
    enrichNodeTypes(page);
    expect(page.root.children[0]!.type).toBe('container');
  });

  it('promotes a centered top text-bearing region to title', () => {
    const page = ast({
      id: 'p',
      type: 'page',
      bbox: box(0, 0, 1194, 2595),
      props: {},
      children: [
        leaf('back', 'container', box(60, 180, 120, 57), { text: '返回' }),
        leaf('heading', 'container', box(489, 180, 216, 57), { text: '地址修改' }),
        leaf('body', 'navbar', box(315, 630, 636, 48), { text: '江航路60弄瑞和新苑38号楼501室' }),
        leaf('caption-1', 'container', box(60, 830, 141, 45), { text: '联系人' }),
        leaf('caption-2', 'container', box(315, 830, 129, 45), { text: '许先生' }),
      ],
    });
    enrichNodeTypes(page, [
      ocr('返回', box(60, 180, 120, 57)),
      ocr('地址修改', box(480, 179, 242, 59)),
      ocr('江航路60弄瑞和新苑38号楼501室', box(309, 634, 651, 42)),
      ocr('联系人', box(54, 826, 163, 58)),
      ocr('许先生', box(300, 826, 159, 58)),
    ]);
    expect(page.root.children[1]!.type).toBe('title');
    expect(page.root.children[2]!.type).toBe('text');
  });

  it('marks a left-hand text in an aligned label-value pair as a semantic label', () => {
    const label = leaf('label', 'container', box(66, 630, 141, 51), { text: '门牌号' });
    const value = leaf('value', 'navbar', box(315, 633, 636, 48), {
      text: '江航路60弄瑞和新苑38号楼501室',
    });
    const page = ast({
      id: 'p',
      type: 'page',
      bbox: box(0, 0, 1194, 2595),
      props: {},
      children: [label, value],
    });
    enrichNodeTypes(page, [
      ocr('门牌号', box(50, 626, 167, 58)),
      ocr('江航路60弄瑞和新苑38号楼501室', box(309, 634, 651, 42)),
    ]);
    expect(label.type).toBe('text');
    expect(label.props.semanticRole).toBe('label');
    expect(value.type).toBe('text');
    expect(value.props.semanticRole).toBeUndefined();
  });

  it('does not promote a gray (low-saturation) container to button', () => {
    const page = ast({
      id: 'p',
      type: 'page',
      bbox: box(0, 0, 400, 600),
      props: {},
      children: [
        leaf('g', 'container', box(10, 10, 100, 36), { style: { backgroundColor: '#bfbfbf' } }),
      ],
    });
    enrichNodeTypes(page);
    expect(page.root.children[0]!.type).not.toBe('button');
  });

  it('prunes a node entirely outside the page bbox', () => {
    const page = ast({
      id: 'p',
      type: 'page',
      bbox: box(0, 0, 640, 480),
      props: {},
      children: [
        leaf('ok', 'card', box(10, 10, 100, 80)),
        leaf('oob', 'button', box(845, 661, 80, 30)),
      ],
    });
    enrichNodeTypes(page);
    expect(page.root.children).toHaveLength(1);
    expect(page.root.children[0]!.id).toBe('ok');
  });
});
