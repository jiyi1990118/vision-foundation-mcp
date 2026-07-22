import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CodegenExporter, toCodegenIr } from '../../src/ui-analysis/exporter/codegen-exporter.js';
import {
  FigmaExporter,
  toFigmaDocument,
} from '../../src/ui-analysis/exporter/figma-exporter.js';
import type { FigmaNode } from '../../src/ui-analysis/exporter/figma-exporter.js';
import { MarkdownExporter, toMarkdown } from '../../src/ui-analysis/exporter/markdown-exporter.js';
import { injectNodeStyles } from '../../src/ui-analysis/style/style-extractor.js';
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
    expect(ir.root.bbox).toEqual(ast.root.bbox);
    expect(ir.root.children[0]!.text).toBe('Hello World');
    expect(Array.isArray(ir.constraints)).toBe(true);
    expect(ir.slots).toEqual([]);
    expect(ir.repeats).toEqual([]);
    expect(ir.root.children).toHaveLength(2);
  });

  it('derives slots from repeated sibling groups', () => {
    const ast: SemanticAST = {
      root: {
        id: 'page',
        type: 'page',
        bbox: { x: 0, y: 0, w: 400, h: 600 },
        props: {},
        children: [
          {
            id: 'list',
            type: 'container',
            bbox: { x: 0, y: 0, w: 300, h: 120 },
            props: {},
            children: [
              { id: 'i1', type: 'listItem', bbox: { x: 0, y: 0, w: 80, h: 40 }, props: {}, children: [] },
              { id: 'i2', type: 'listItem', bbox: { x: 0, y: 40, w: 80, h: 40 }, props: {}, children: [] },
              { id: 'i3', type: 'listItem', bbox: { x: 0, y: 80, w: 80, h: 40 }, props: {}, children: [] },
            ],
          },
        ],
      },
      version: '1.0.0',
    };
    const ir = toCodegenIr(ast);
    expect(ir.repeats).toEqual([{ targetId: 'list', count: 3, templateId: 'i1', templateType: 'listItem' }]);
    expect(ir.slots).toEqual([{ id: 'i1', name: 'listItemTemplate' }]);
  });

  it('keeps the CodegenIR schema in sync with repeat template fields', () => {
    const schema = JSON.parse(readFileSync(
      new URL('../../src/ui-analysis/ir/schema/codegen_ir.schema.json', import.meta.url),
      'utf8',
    )) as {
      properties: { repeats: { items: { properties: Record<string, unknown> } } };
    };
    expect(Object.keys(schema.properties.repeats.items.properties)).toEqual(
      expect.arrayContaining(['targetId', 'count', 'templateId', 'templateType']),
    );
  });

  it('keeps the CodegenIR schema in sync with factual node geometry and text', () => {
    const schema = JSON.parse(readFileSync(
      new URL('../../src/ui-analysis/ir/schema/codegen_ir.schema.json', import.meta.url),
      'utf8',
    )) as {
      $defs: { codegenNode: { required: string[]; properties: Record<string, unknown> } };
    };
    expect(schema.$defs.codegenNode.required).toContain('bbox');
    expect(Object.keys(schema.$defs.codegenNode.properties)).toEqual(
      expect.arrayContaining(['bbox', 'text']),
    );
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

  it('maps sampled nested node styles into Figma fills, radius, and typography', () => {
    const ast = makeAst();
    delete ast.root.props.color;
    delete ast.root.children[0]!.props.fontSize;
    delete ast.root.children[0]!.props.fontWeight;
    injectNodeStyles(ast, new Map([
      ['root', { backgroundColor: '#1677ff', borderRadius: 12 }],
      ['title1', { textColor: '#ffffff', fontSize: 28, fontWeight: 700 }],
    ]));

    const doc = toFigmaDocument(ast);
    expect(doc.document.fills[0]?.color.b).toBeGreaterThan(0.9);
    expect(doc.document.cornerRadius).toBe(12);
    const title = findNode(doc.document, 'title1');
    expect(title?.fills[0]?.color.r).toBe(1);
    expect(title?.style?.fontSize).toBe(28);
    expect(title?.style?.fontWeight).toBe(700);
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
