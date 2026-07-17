import { describe, expect, it } from 'vitest';
import { enrichInteractivity } from '../../src/ui-analysis/interactivity/index.js';
import type { ASTNode, SemanticAST, BBox, NodeStyle } from '../../src/ui-analysis/ir/types.js';

function ast(root: ASTNode): SemanticAST {
  return { root, version: '1.0.0' };
}

function box(x: number, y: number, w: number, h: number): BBox {
  return { x, y, w, h };
}

function styledLeaf(
  id: string,
  type: ASTNode['type'],
  bbox: BBox,
  style: NodeStyle,
  text?: string,
): ASTNode {
  const n: ASTNode = { id, type, bbox, props: { style }, children: [] };
  if (text !== undefined) n.text = text;
  return n;
}

function leaf(id: string, type: ASTNode['type'], bbox: BBox, text?: string): ASTNode {
  const n: ASTNode = { id, type, bbox, props: {}, children: [] };
  if (text !== undefined) n.text = text;
  return n;
}

function container(id: string, type: ASTNode['type'], bbox: BBox, children: ASTNode[]): ASTNode {
  return { id, type, bbox, props: {}, children };
}

function wrap(child: ASTNode): SemanticAST {
  return ast(container('root', 'page', box(0, 0, 240, 200), [child]));
}

describe('interactivity-enricher (Stream S28, G-C2)', () => {
  describe('placeholder (input/textarea/select light-gray text)', () => {
    it('flags an input with light-gray (#999999) text as placeholder', () => {
      const input = styledLeaf('inp', 'input', box(10, 10, 120, 32), { textColor: '#999999' }, '请输入');
      enrichInteractivity(wrap(input));
      expect(input.props.interactive).toEqual({ placeholder: true });
    });

    it('does not flag an input with dark (#000000) text as placeholder', () => {
      const input = styledLeaf('inp', 'input', box(10, 10, 120, 32), { textColor: '#000000' }, '请输入');
      enrichInteractivity(wrap(input));
      expect(input.props.interactive).toBeUndefined();
    });

    it('parses the #rgb shorthand (#999 == #999999) as placeholder gray', () => {
      const input = styledLeaf('inp', 'input', box(10, 10, 120, 32), { textColor: '#999' }, '搜索');
      enrichInteractivity(wrap(input));
      expect(input.props.interactive).toEqual({ placeholder: true });
    });

    it('does not flag placeholder for non-input types even with gray text', () => {
      const btn = styledLeaf('btn', 'button', box(10, 10, 120, 32), { textColor: '#999999' }, '保存');
      enrichInteractivity(wrap(btn));
      expect(btn.props.interactive).toBeUndefined();
    });

    it('flags a textarea and a select with light-gray text as placeholder', () => {
      const ta = styledLeaf('ta', 'textarea', box(10, 10, 240, 90), { textColor: '#b3b3b3' }, '多行输入');
      const sel = styledLeaf('sel', 'select', box(10, 110, 120, 32), { textColor: '#aaaaaa' }, '请选择');
      enrichInteractivity(
        ast(container('root', 'page', box(0, 0, 260, 200), [ta, sel])),
      );
      expect(ta.props.interactive).toEqual({ placeholder: true });
      expect(sel.props.interactive).toEqual({ placeholder: true });
    });
  });

  describe('disabled (button/iconButton desaturated mid-gray bg)', () => {
    it('flags a button with gray (#bfbfbf) background as disabled', () => {
      const btn = styledLeaf('btn', 'button', box(10, 10, 120, 32), { backgroundColor: '#bfbfbf' }, '保存');
      enrichInteractivity(wrap(btn));
      expect(btn.props.interactive).toEqual({ disabled: true });
    });

    it('does not flag a button with saturated (#1677ff) background as disabled', () => {
      const btn = styledLeaf('btn', 'button', box(10, 10, 120, 32), { backgroundColor: '#1677ff' }, '保存');
      enrichInteractivity(wrap(btn));
      expect(btn.props.interactive).toBeUndefined();
    });

    it('does not flag a pure-white button (luminance out of band) as disabled', () => {
      const btn = styledLeaf('btn', 'button', box(10, 10, 120, 32), { backgroundColor: '#ffffff' }, '保存');
      enrichInteractivity(wrap(btn));
      expect(btn.props.interactive).toBeUndefined();
    });

    it('flags an iconButton with mid-gray (#aaaaaa) background as disabled', () => {
      const btn = styledLeaf('btn', 'iconButton', box(10, 10, 32, 32), { backgroundColor: '#aaaaaa' });
      enrichInteractivity(wrap(btn));
      expect(btn.props.interactive).toEqual({ disabled: true });
    });
  });

  describe('link (text/title/subtitle blue-dominant text)', () => {
    it('flags a text node with blue (#1677ff) text as link', () => {
      const txt = styledLeaf('t', 'text', box(10, 10, 120, 20), { textColor: '#1677ff' }, '点击这里');
      enrichInteractivity(wrap(txt));
      expect(txt.props.interactive).toEqual({ link: true });
    });

    it('does not flag a text node with black text as link', () => {
      const txt = styledLeaf('t', 'text', box(10, 10, 120, 20), { textColor: '#000000' }, '点击这里');
      enrichInteractivity(wrap(txt));
      expect(txt.props.interactive).toBeUndefined();
    });

    it('flags a title node with blue (#1a73e8) text as link', () => {
      const title = styledLeaf('t', 'title', box(10, 10, 200, 32), { textColor: '#1a73e8' }, '文档标题');
      enrichInteractivity(wrap(title));
      expect(title.props.interactive).toEqual({ link: true });
    });
  });

  describe('no style / no signal', () => {
    it('does not set interactive when style is absent', () => {
      const input = leaf('inp', 'input', box(10, 10, 120, 32), '请输入');
      const btn = leaf('btn', 'button', box(10, 50, 120, 32), '保存');
      const txt = leaf('t', 'text', box(10, 90, 120, 20), '链接');
      enrichInteractivity(
        ast(container('root', 'page', box(0, 0, 200, 200), [input, btn, txt])),
      );
      expect(input.props.interactive).toBeUndefined();
      expect(btn.props.interactive).toBeUndefined();
      expect(txt.props.interactive).toBeUndefined();
    });

    it('does not set interactive when style lacks the relevant color field', () => {
      const input = styledLeaf('inp', 'input', box(10, 10, 120, 32), { backgroundColor: '#ffffff' }, '请输入');
      enrichInteractivity(wrap(input));
      expect(input.props.interactive).toBeUndefined();
    });
  });

  describe('state independence', () => {
    it('a button is checked for disabled only (link applies to text/title/subtitle)', () => {
      const btn = styledLeaf(
        'btn',
        'button',
        box(10, 10, 120, 32),
        { backgroundColor: '#bfbfbf', textColor: '#1677ff' },
        '保存',
      );
      enrichInteractivity(wrap(btn));
      expect(btn.props.interactive).toEqual({ disabled: true });
    });

    it('an input with gray text and white bg yields placeholder only', () => {
      const input = styledLeaf(
        'inp',
        'input',
        box(10, 10, 120, 32),
        { backgroundColor: '#ffffff', textColor: '#999999' },
        '请输入',
      );
      enrichInteractivity(wrap(input));
      expect(input.props.interactive).toEqual({ placeholder: true });
    });
  });
});
