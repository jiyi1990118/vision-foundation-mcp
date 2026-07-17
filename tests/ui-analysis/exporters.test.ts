import { describe, expect, it } from 'vitest';
import { CodegenExporter, toCodegenIr } from '../../src/ui-analysis/exporter/codegen-exporter.js';
import {
  FigmaExporter,
  toFigmaDocument,
} from '../../src/ui-analysis/exporter/figma-exporter.js';
import type { FigmaNode } from '../../src/ui-analysis/exporter/figma-exporter.js';
import { MarkdownExporter, toMarkdown } from '../../src/ui-analysis/exporter/markdown-exporter.js';
import type { SemanticAST } from '../../src/ui-analysis/ir/types.js';

function makeAst(): SemanticAST {
  return {
    root: {
      id: 'root',
      type: 'page',
      bbox: { x: 0, y: 0, w: 400, h: 600 },
      props: { color: '#FF0000' },
      children: [
        {
          id: 'title1',
          type: 'title',
          bbox: { x: 10, y: 10, w: 200, h: 30 },
          props: { fontSize: 24, fontWeight: 700 },
          text: 'Hello World',
          children: [],
        },
        {
          id: 'btn1',
          type: 'button',
          bbox: { x: 10, y: 50, w: 100, h: 40 },
          props: {},
          text: 'Submit',
          children: [],
        },
      ],
    },
    version: '1.0.0',
  };
}

function findNode(node: FigmaNode, id: string): FigmaNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

describe('exporters', () => {
  it('CodegenExporter maps AST to CodegenIR with array constraints', () => {
    const ast = makeAst();
    const exporter = new CodegenExporter();
    expect(exporter.format).toBe('codegen-ir');
    const ir = toCodegenIr(ast);
    expect(exporter.export(ast)).toEqual(ir);
    expect(ir.root.type).toBe('page');
    expect(Array.isArray(ir.constraints)).toBe(true);
    expect(ir.slots).toEqual([]);
    expect(ir.repeats).toEqual([]);
    expect(ir.root.children).toHaveLength(2);
  });

  it('FigmaExporter maps root to FRAME and text nodes to TEXT with 0-1 colors', () => {
    const ast = makeAst();
    const exporter = new FigmaExporter();
    expect(exporter.format).toBe('figma-json');
    const doc = toFigmaDocument(ast);
    expect(exporter.export(ast)).toEqual(doc);

    expect(doc.document.type).toBe('FRAME');
    const fill = doc.document.fills[0]!;
    expect(fill.type).toBe('SOLID');
    for (const ch of [fill.color.r, fill.color.g, fill.color.b, fill.color.a]) {
      expect(ch).toBeGreaterThanOrEqual(0);
      expect(ch).toBeLessThanOrEqual(1);
    }
    expect(fill.color.r).toBeGreaterThan(0.99);
    expect(fill.color.g).toBeLessThanOrEqual(0.01);

    const title = findNode(doc.document, 'title1');
    expect(title?.type).toBe('TEXT');
    expect(title?.characters).toBe('Hello World');

    const btn = findNode(doc.document, 'btn1');
    expect(btn?.type).toBe('TEXT');
    expect(btn?.characters).toBe('Submit');
  });

  it('MarkdownExporter emits human-readable tree containing root type', () => {
    const ast = makeAst();
    const exporter = new MarkdownExporter();
    expect(exporter.format).toBe('markdown');
    const md = toMarkdown(ast);
    expect(exporter.export(ast)).toBe(md);
    expect(md).toContain('page');
    expect(md).toContain('Hello World');
    expect(md).toContain('#');
  });
});
