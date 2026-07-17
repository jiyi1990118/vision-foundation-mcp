import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { detectOverlays, applyOverlays } from '../../src/ui-analysis/overlay/index.js';
import type { SemanticAST, ASTNode, BBox } from '../../src/ui-analysis/ir/types.js';
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

  it('detects a drawer (left edge, tall, narrow) without reporting a dialog', async () => {
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
      <rect x="0" y="0" width="100" height="${H}" fill="#cccccc"/>
    </svg>`;
    const image = await svgToImage(svg);
    const ast = astWithPage(box(0, 0, W, H), [leaf('panel', 'card', box(0, 0, 100, H))]);

    const overlays = await detectOverlays(image, ast);

    expect(overlays.length).toBe(1);
    const o = overlays[0]!;
    expect(o.overlayType).toBe('drawer');
    expect(o.zIndex).toBe(1000);
    expect(o.mask).toBeUndefined();

    applyOverlays(ast, overlays);
    expect(ast.root.children[0]!.type).toBe('drawer');
    expect(ast.root.children[0]!.props.overlay).toBe(true);
  });

  it('detects a bottomSheet (bottom edge, wide, short)', async () => {
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
      <rect x="0" y="300" width="${W}" height="100" fill="#cccccc"/>
    </svg>`;
    const image = await svgToImage(svg);
    const ast = astWithPage(box(0, 0, W, H), [leaf('sheet', 'card', box(0, 300, W, 100))]);

    const overlays = await detectOverlays(image, ast);

    expect(overlays.length).toBe(1);
    expect(overlays[0]!.overlayType).toBe('bottomSheet');
    expect(overlays[0]!.zIndex).toBe(1000);
    expect(overlays[0]!.mask).toBeUndefined();

    applyOverlays(ast, overlays);
    expect(ast.root.children[0]!.type).toBe('bottomSheet');
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

  it('runs geometry-only drawer detection when no image is supplied', async () => {
    const ast = astWithPage(box(0, 0, W, H), [leaf('panel', 'container', box(0, 0, 100, H))]);

    const overlays = await detectOverlays(undefined, ast);

    expect(overlays.length).toBe(1);
    expect(overlays[0]!.overlayType).toBe('drawer');

    applyOverlays(ast, overlays);
    expect(ast.root.children[0]!.type).toBe('drawer');
    expect(ast.root.children[0]!.props.zIndex).toBe(1000);
  });
});
