import { describe, expect, it } from 'vitest';
import { enrichNodeTypes } from '../../src/ui-analysis/typing/index.js';
import type { ASTNode, SemanticAST, BBox, VisionOcrItem } from '../../src/ui-analysis/ir/types.js';

function ast(root: ASTNode): SemanticAST {
  return { root, version: '1.0.0' };
}

function box(x: number, y: number, w: number, h: number): BBox {
  return { x, y, w, h };
}

function leaf(id: string, type: ASTNode['type'], bbox: BBox, text?: string): ASTNode {
  const n: ASTNode = { id, type, bbox, props: {}, children: [] };
  if (text !== undefined) n.text = text;
  return n;
}

function container(id: string, type: ASTNode['type'], bbox: BBox, children: ASTNode[]): ASTNode {
  return { id, type, bbox, props: {}, children };
}

function ocrItem(text: string, bbox: BBox): VisionOcrItem {
  return { text, bbox, confidence: 1 };
}

describe('type-enricher / extra rules (Stream S26)', () => {
  describe('row / column / grid layout containers', () => {
    it('promotes a horizontal container to row', () => {
      const page = ast(
        container('page', 'page', box(0, 0, 300, 100), [
          container('wrap', 'container', box(0, 0, 300, 100), [
            leaf('a', 'container', box(0, 0, 90, 90)),
            leaf('b', 'container', box(100, 0, 90, 90)),
            leaf('c', 'container', box(200, 0, 90, 90)),
          ]),
        ]),
      );
      enrichNodeTypes(page);
      expect(page.root.children[0]!.type).toBe('row');
    });

    it('promotes a vertical container to column', () => {
      const page = ast(
        container('page', 'page', box(0, 0, 100, 300), [
          container('wrap', 'container', box(0, 0, 100, 300), [
            leaf('a', 'container', box(0, 0, 90, 90)),
            leaf('b', 'container', box(0, 100, 90, 90)),
            leaf('c', 'container', box(0, 200, 90, 90)),
          ]),
        ]),
      );
      enrichNodeTypes(page);
      expect(page.root.children[0]!.type).toBe('column');
    });

    it('promotes a neither-aligned container to grid', () => {
      const page = ast(
        container('page', 'page', box(0, 0, 200, 200), [
          container('wrap', 'container', box(0, 0, 200, 200), [
            leaf('a', 'container', box(0, 0, 60, 60)),
            leaf('b', 'container', box(100, 0, 60, 60)),
            leaf('c', 'container', box(0, 100, 60, 60)),
            leaf('d', 'container', box(100, 100, 60, 60)),
          ]),
        ]),
      );
      enrichNodeTypes(page);
      expect(page.root.children[0]!.type).toBe('grid');
    });

    it('does not relabel a list container to row/column (semantic priority)', () => {
      const page = ast(
        container('page', 'page', box(0, 0, 300, 220), [
          container('lst', 'list', box(0, 0, 300, 220), [
            leaf('i1', 'listItem', box(0, 0, 100, 60)),
            leaf('i2', 'listItem', box(0, 70, 100, 60)),
            leaf('i3', 'listItem', box(0, 140, 100, 60)),
          ]),
        ]),
      );
      enrichNodeTypes(page);
      expect(page.root.children[0]!.type).toBe('list');
      expect(page.root.children[0]!.children.map((c) => c.type)).toEqual([
        'listItem',
        'listItem',
        'listItem',
      ]);
    });
  });

  describe('badge (numeric / tiny tag variant)', () => {
    it('promotes a numeric tag to badge and keeps a plain label tag', () => {
      const numeric = ast(
        container('page', 'page', box(0, 0, 200, 100), [
          leaf('t', 'tag', box(0, 0, 24, 20), '3'),
        ]),
      );
      enrichNodeTypes(numeric);
      expect(numeric.root.children[0]!.type).toBe('badge');

      const plus = ast(
        container('page', 'page', box(0, 0, 200, 100), [
          leaf('t', 'tag', box(0, 0, 28, 20), '99+'),
        ]),
      );
      enrichNodeTypes(plus);
      expect(plus.root.children[0]!.type).toBe('badge');

      const label = ast(
        container('page', 'page', box(0, 0, 200, 100), [
          leaf('t', 'tag', box(0, 0, 60, 24), '标签'),
        ]),
      );
      enrichNodeTypes(label);
      expect(label.root.children[0]!.type).toBe('tag');
    });

    it('promotes a tiny non-numeric tag to badge by bbox', () => {
      const tiny = ast(
        container('page', 'page', box(0, 0, 200, 100), [
          leaf('t', 'tag', box(0, 0, 20, 16), '新'),
        ]),
      );
      enrichNodeTypes(tiny);
      expect(tiny.root.children[0]!.type).toBe('badge');
    });

    it('promotes a small numeric text node to badge', () => {
      const page = ast(
        container('root', 'page', box(0, 0, 375, 812), [
          leaf('t', 'text', box(50, 50, 24, 20), '12'),
        ]),
      );
      enrichNodeTypes(page);
      expect(page.root.children[0]!.type).toBe('badge');
    });

    it('promotes a small keyword text node to badge', () => {
      const page = ast(
        container('root', 'page', box(0, 0, 375, 812), [
          leaf('t', 'text', box(50, 50, 40, 20), 'HOT'),
        ]),
      );
      enrichNodeTypes(page);
      expect(page.root.children[0]!.type).toBe('badge');
    });

    it('promotes a Chinese keyword subtitle to badge', () => {
      const page = ast(
        container('root', 'page', box(0, 0, 375, 812), [
          leaf('t', 'subtitle', box(50, 50, 60, 24), '限时特惠'),
        ]),
      );
      enrichNodeTypes(page);
      expect(page.root.children[0]!.type).toBe('badge');
    });

    it('does not promote a large text node to badge', () => {
      const page = ast(
        container('root', 'page', box(0, 0, 375, 812), [
          leaf('t', 'text', box(50, 400, 200, 40), '12'),
        ]),
      );
      enrichNodeTypes(page);
      expect(page.root.children[0]!.type).toBe('text');
    });

    it('does not promote a long text node to badge', () => {
      const page = ast(
        container('root', 'page', box(0, 0, 375, 812), [
          leaf('t', 'text', box(50, 400, 40, 20), '这是一个很长的文本'),
        ]),
      );
      enrichNodeTypes(page);
      expect(page.root.children[0]!.type).toBe('text');
    });
  });

  describe('select (dropdown input)', () => {
    it('promotes an input near OCR "请选择" to select when ocr is passed', () => {
      const input = leaf('inp', 'input', box(10, 10, 120, 30));
      const page = ast(container('root', 'page', box(0, 0, 200, 100), [input]));
      const ocr: VisionOcrItem[] = [ocrItem('请选择', box(10, 10, 120, 30))];
      enrichNodeTypes(page, ocr);
      expect(input.type).toBe('select');
    });

    it('leaves an input unchanged when nearby OCR has no select keyword', () => {
      const input = leaf('inp', 'input', box(10, 10, 120, 30));
      const page = ast(container('root', 'page', box(0, 0, 200, 100), [input]));
      const ocr: VisionOcrItem[] = [ocrItem('保存', box(10, 10, 120, 30))];
      enrichNodeTypes(page, ocr);
      expect(input.type).toBe('input');
    });

    it('promotes an input to select when a small icon sits on its right', () => {
      const input = leaf('inp', 'input', box(0, 0, 120, 40));
      const arrow = leaf('arrow', 'icon', box(130, 8, 24, 24));
      const page = ast(
        container('root', 'page', box(0, 0, 300, 100), [
          container('form', 'container', box(0, 0, 200, 40), [input, arrow]),
        ]),
      );
      enrichNodeTypes(page);
      expect(input.type).toBe('select');
    });
  });

  describe('radio / checkbox (form controls)', () => {
    it('promotes a small input near OCR "单选" to radio', () => {
      const input = leaf('inp', 'input', box(10, 10, 20, 20));
      const page = ast(container('root', 'page', box(0, 0, 200, 100), [input]));
      const ocr: VisionOcrItem[] = [ocrItem('性别（单选）', box(10, 0, 100, 12))];
      enrichNodeTypes(page, ocr);
      expect(input.type).toBe('radio');
    });

    it('promotes a small input near OCR "多选" to checkbox', () => {
      const input = leaf('inp', 'input', box(10, 10, 20, 20));
      const page = ast(container('root', 'page', box(0, 0, 200, 100), [input]));
      const ocr: VisionOcrItem[] = [ocrItem('兴趣（多选）', box(10, 0, 100, 12))];
      enrichNodeTypes(page, ocr);
      expect(input.type).toBe('checkbox');
    });

    it('leaves a text-field-sized input unchanged even with a radio keyword', () => {
      const input = leaf('inp', 'input', box(10, 10, 120, 32));
      const page = ast(container('root', 'page', box(0, 0, 200, 100), [input]));
      const ocr: VisionOcrItem[] = [ocrItem('单选', box(10, 10, 120, 32))];
      enrichNodeTypes(page, ocr);
      expect(input.type).toBe('input');
    });

    it('leaves a small input unchanged when OCR has no form-control keyword', () => {
      const input = leaf('inp', 'input', box(10, 10, 20, 20));
      const page = ast(container('root', 'page', box(0, 0, 200, 100), [input]));
      const ocr: VisionOcrItem[] = [ocrItem('保存', box(10, 10, 20, 20))];
      enrichNodeTypes(page, ocr);
      expect(input.type).toBe('input');
    });
  });

  describe('badge splitter (label + trailing number)', () => {
    it('splits "私信 12" into label "私信" + badge "12"', () => {
      const page = ast(
        container('root', 'page', box(0, 0, 375, 812), [
          leaf('t', 'text', box(50, 400, 80, 24), '私信 12'),
        ]),
      );
      enrichNodeTypes(page);
      const node = page.root.children[0]!;
      expect(node.text).toBe('私信');
      expect(node.children.length).toBe(1);
      const badge = node.children[0]!;
      expect(badge.id).toBe('t__badge');
      expect(badge.type).toBe('badge');
      expect(badge.text).toBe('12');
      expect(badge.bbox).toEqual({ x: 90, y: 400, w: 40, h: 24 });
      expect(node.bbox).toEqual({ x: 50, y: 400, w: 40, h: 24 });
    });

    it('splits "群聊8" into label "群聊" + badge "8"', () => {
      const page = ast(
        container('root', 'page', box(0, 0, 375, 812), [
          leaf('t', 'text', box(50, 400, 90, 24), '群聊8'),
        ]),
      );
      enrichNodeTypes(page);
      const node = page.root.children[0]!;
      expect(node.text).toBe('群聊');
      expect(node.children.length).toBe(1);
      const badge = node.children[0]!;
      expect(badge.type).toBe('badge');
      expect(badge.text).toBe('8');
    });

    it('splits a subtitle node into label + badge', () => {
      const page = ast(
        container('root', 'page', box(0, 0, 375, 812), [
          leaf('t', 'subtitle', box(50, 400, 90, 24), '通知25'),
        ]),
      );
      enrichNodeTypes(page);
      const node = page.root.children[0]!;
      expect(node.text).toBe('通知');
      const badge = node.children[0]!;
      expect(badge.type).toBe('badge');
      expect(badge.text).toBe('25');
    });

    it('does not split "100%" (not a trailing-number badge pattern)', () => {
      const page = ast(
        container('root', 'page', box(0, 0, 375, 812), [
          leaf('t', 'text', box(50, 400, 80, 24), '100%'),
        ]),
      );
      enrichNodeTypes(page);
      const node = page.root.children[0]!;
      expect(node.text).toBe('100%');
      expect(node.children.length).toBe(0);
    });

    it('does not split "9:41" (clock time, label has no CJK / 2 latin letters)', () => {
      const page = ast(
        container('root', 'page', box(0, 0, 375, 812), [
          leaf('t', 'text', box(50, 400, 80, 24), '9:41'),
        ]),
      );
      enrichNodeTypes(page);
      const node = page.root.children[0]!;
      expect(node.text).toBe('9:41');
      expect(node.children.length).toBe(0);
    });

    it('does not split a bare number "12"', () => {
      const page = ast(
        container('root', 'page', box(0, 0, 375, 812), [
          leaf('t', 'text', box(50, 400, 80, 24), '12'),
        ]),
      );
      enrichNodeTypes(page);
      const node = page.root.children[0]!;
      expect(node.text).toBe('12');
      expect(node.children.length).toBe(0);
    });

    it('does not split a node that already has children', () => {
      const parent = container('t', 'text', box(50, 400, 80, 24), [
        leaf('c', 'text', box(55, 404, 20, 16), 'x'),
      ]);
      parent.text = '私信 12';
      const page = ast(container('root', 'page', box(0, 0, 375, 812), [parent]));
      enrichNodeTypes(page);
      expect(parent.text).toBe('私信 12');
      expect(parent.children.length).toBe(1);
      expect(parent.children[0]!.id).toBe('c');
    });
  });
});
