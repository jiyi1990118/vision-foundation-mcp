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
});
