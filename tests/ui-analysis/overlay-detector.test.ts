import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { detectOverlays, applyOverlays } from '../../src/ui-analysis/overlay/index.js';
import { buildSemanticAst } from '../../src/ui-analysis/ast/ast-builder.js';
import type { SemanticAST, ASTNode, BBox } from '../../src/ui-analysis/ir/types.js';
import type { LayoutIR } from '../../src/ui-analysis/ir/types.js';
import type { ImageInput } from '../../src/types/domain.js';

async function svgToImage(svg: string): Promise<ImageInput> {
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length };
}

function box(x: number, y: number, w: number, h: number): BBox {
  return { x, y, w, h };
}

function leaf(id: string, type: ASTNode['type'], bbox: BBox): ASTNode {
  return { id, type, bbox, props: {}, children: [] };
}

function astWithPage(pageBbox: BBox, children: ASTNode[]): SemanticAST {
  return {
    root: { id: 'page', type: 'page', bbox: pageBbox, props: {}, children },
    version: '1.0.0',
  };
}

const W = 300;
const H = 400;

describe('overlay-detector / detectOverlays', () => {
  it('detects a dialog (dim mask + centered bright card) with zIndex and mask', async () => {
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
      <rect x="0" y="0" width="${W}" height="${H}" fill="#333333"/>
      <rect x="100" y="150" width="100" height="100" fill="#ffffff" stroke="#d9d9d9"/>
    </svg>`;
    const image = await svgToImage(svg);
    const ast = astWithPage(box(0, 0, W, H), [leaf('card', 'card', box(100, 150, 100, 100))]);

    const overlays = await detectOverlays(image, ast);

    expect(overlays.length).toBe(1);
    const o = overlays[0]!;
    expect(o.overlayType).toBe('dialog');
    expect(o.zIndex).toBe(1000);
    expect(o.mask).toBeDefined();
    expect(o.mask!.w).toBeGreaterThan(0);
    expect(o.mask!.h).toBeGreaterThan(0);

    applyOverlays(ast, overlays);
    const card = ast.root.children[0]!;
    expect(card.type).toBe('dialog');
    expect(card.props.overlay).toBe(true);
    expect(card.props.zIndex).toBe(1000);
    expect(card.props.mask).toBeDefined();
  });

  it('detects an overlapping drawer (left edge, tall, narrow) without reporting a dialog', async () => {
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
      <rect x="0" y="0" width="100" height="${H}" fill="#cccccc"/>
    </svg>`;
    const image = await svgToImage(svg);
    const ast = astWithPage(box(0, 0, W, H), [
      leaf('content', 'section', box(0, 0, W, H)),
      leaf('panel', 'card', box(0, 0, 100, H)),
    ]);

    const overlays = await detectOverlays(image, ast, undefined, [
      { id: 'content-region', type: 'main', bbox: box(0, 0, W, H), relativeArea: 1, children: [] },
      { id: 'panel-region', type: 'card', bbox: box(0, 0, 100, H), relativeArea: 1 / 3, children: [] },
    ]);

    const o = overlays.find((overlay) => overlay.nodeId === 'panel')!;
    expect(o.overlayType).toBe('drawer');
    expect(o.zIndex).toBe(1000);
    expect(o.mask).toBeUndefined();

    applyOverlays(ast, overlays);
    expect(ast.root.children[1]!.type).toBe('drawer');
    expect(ast.root.children[1]!.props.overlay).toBe(true);
  });

  it('detects an overlapping bottomSheet (bottom edge, wide, short)', async () => {
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
      <rect x="0" y="300" width="${W}" height="100" fill="#cccccc"/>
    </svg>`;
    const image = await svgToImage(svg);
    const ast = astWithPage(box(0, 0, W, H), [
      leaf('content', 'section', box(0, 0, W, H)),
      leaf('sheet', 'card', box(0, 300, W, 100)),
    ]);

    const overlays = await detectOverlays(image, ast, undefined, [
      { id: 'content-region', type: 'main', bbox: box(0, 0, W, H), relativeArea: 1, children: [] },
      { id: 'sheet-region', type: 'card', bbox: box(0, 300, W, 100), relativeArea: 0.25, children: [] },
    ]);

    const sheet = overlays.find((overlay) => overlay.nodeId === 'sheet')!;
    expect(sheet.overlayType).toBe('bottomSheet');
    expect(sheet.zIndex).toBe(1000);
    expect(sheet.mask).toBeUndefined();

    applyOverlays(ast, overlays);
    expect(ast.root.children[1]!.type).toBe('bottomSheet');
  });

  it('does not report a dialog for a plain centered card with no dim mask', async () => {
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
      <rect x="100" y="150" width="100" height="100" fill="#ffffff" stroke="#d9d9d9"/>
    </svg>`;
    const image = await svgToImage(svg);
    const ast = astWithPage(box(0, 0, W, H), [leaf('card', 'card', box(100, 150, 100, 100))]);

    const overlays = await detectOverlays(image, ast);

    expect(overlays.length).toBe(0);

    applyOverlays(ast, overlays);
    expect(ast.root.children[0]!.type).toBe('card');
    expect(ast.root.children[0]!.props.overlay).toBeUndefined();
  });

  it('runs geometry-only drawer detection when it overlaps underlying content', async () => {
    const ast = astWithPage(box(0, 0, W, H), [
      leaf('content', 'section', box(0, 0, W, H)),
      leaf('panel', 'container', box(0, 0, 100, H)),
    ]);

    const overlays = await detectOverlays(undefined, ast, undefined, [
      { id: 'content-region', type: 'main', bbox: box(0, 0, W, H), relativeArea: 1, children: [] },
      { id: 'panel-region', type: 'content', bbox: box(0, 0, 100, H), relativeArea: 1 / 3, children: [] },
    ]);

    expect(overlays.find((overlay) => overlay.nodeId === 'panel')?.overlayType).toBe('drawer');

    applyOverlays(ast, overlays);
    expect(ast.root.children[1]!.type).toBe('drawer');
    expect(ast.root.children[1]!.props.zIndex).toBe(1000);
  });

  it('is invariant when a geometry-only page is translated away from the origin', async () => {
    const ast = astWithPage(box(100, 50, W, H), [
      leaf('content', 'section', box(100, 50, W, H)),
      leaf('panel', 'container', box(100, 50, 100, H)),
    ]);
    const overlays = await detectOverlays(undefined, ast, undefined, [
      { id: 'content-region', type: 'main', bbox: box(100, 50, W, H), relativeArea: 1, children: [] },
      { id: 'panel-region', type: 'content', bbox: box(100, 50, 100, H), relativeArea: 1 / 3, children: [] },
    ]);
    expect(overlays).toContainEqual({ nodeId: 'panel', overlayType: 'drawer', zIndex: 1000 });
  });

  it('does not classify adjacent static columns as drawers', async () => {
    const ast = astWithPage(box(0, 0, W, H), [
      leaf('sidebar', 'container', box(0, 0, 100, H)),
      leaf('main', 'section', box(100, 0, 200, H)),
    ]);
    ast.root.props.layoutType = 'sidebar';

    expect(await detectOverlays(undefined, ast)).toEqual([]);
  });

  it('does not count an AST ancestor as an independent underlying layer', async () => {
    const parent = leaf('parent', 'section', box(0, 0, W, H));
    parent.children.push(leaf('nested-panel', 'container', box(0, 0, 100, H)));
    const ast = astWithPage(box(0, 0, W, H), [parent]);

    expect(await detectOverlays(undefined, ast)).toEqual([]);
  });

  it('detects an extracted sidebar overlay from flat-region overlap evidence', async () => {
    const layout: LayoutIR = {
      layoutType: 'stack',
      spacing: { averageGap: 0, scale: 'compact', verticalGaps: [], horizontalGaps: [] },
      regions: [
        { id: 'main', type: 'main', bbox: box(0, 0, W, H), relativeArea: 1, children: [] },
        { id: 'drawer', type: 'sidebar', bbox: box(0, 0, 100, H), relativeArea: 1 / 3, children: [] },
      ],
    };
    const ast = buildSemanticAst(layout, undefined, undefined, undefined, box(0, 0, W, H));
    const drawer = [...(function* walk(node: ASTNode): IterableIterator<ASTNode> {
      yield node;
      for (const child of node.children) yield* walk(child);
    })(ast.root)].find((node) => node.props.regionId === 'drawer');
    expect(drawer?.type).toBe('sidebar');

    const overlays = await detectOverlays(undefined, ast, undefined, layout.regions);
    expect(overlays).toContainEqual({ nodeId: drawer!.id, overlayType: 'drawer', zIndex: 1000 });
  });
});
