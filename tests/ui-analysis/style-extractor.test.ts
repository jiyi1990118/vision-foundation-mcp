import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { computeSampleGrid, extractNodeStyles } from '../../src/ui-analysis/style/style-extractor.js';
import type { SemanticAST } from '../../src/ui-analysis/ir/types.js';

async function makeSolidColorImage(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 200,
      height: 200,
      channels: 3,
      background: { r, g, b },
    },
  })
    .png()
    .toBuffer();
}

async function makeTextImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 200,
      height: 200,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="200" height="200"><rect x="20" y="25" width="160" height="10" fill="#333333"/></svg>',
        ),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();
}

function makeImageInput(buffer: Buffer) {
  return {
    buffer,
    mimeType: 'image/png',
    source: 'test',
    size: buffer.byteLength,
  };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function colorDistance(a: string, b: string): number {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  const dr = ra.r - rb.r;
  const dg = ra.g - rb.g;
  const db = ra.b - rb.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

describe('extractNodeStyles', () => {
  it('bounds area sampling for square and extreme-aspect regions', () => {
    for (const [width, height] of [[1000, 1000], [10000, 1], [1, 10000], [160, 30]]) {
      const grid = computeSampleGrid(width, height);
      expect(grid.columns).toBeGreaterThan(0);
      expect(grid.rows).toBeGreaterThan(0);
      expect(grid.columns * grid.rows).toBeLessThanOrEqual(4096);
      expect(grid.columns).toBeLessThanOrEqual(width);
      expect(grid.rows).toBeLessThanOrEqual(height);
    }
  });

  it('samples the dominant background color of a solid region', async () => {
    const buf = await makeSolidColorImage(255, 0, 0);
    const ast: SemanticAST = {
      root: {
        id: 'page:0,0,200,200',
        type: 'page',
        bbox: { x: 0, y: 0, w: 200, h: 200 },
        props: {},
        children: [
          {
            id: 'region:0,0,200,200',
            type: 'container',
            bbox: { x: 0, y: 0, w: 200, h: 200 },
            props: {},
            children: [],
          },
        ],
      },
      version: '1.0.0',
    };

    const styles = await extractNodeStyles(makeImageInput(buf), ast);

    const regionId = 'region:0,0,200,200';
    expect(styles.has(regionId)).toBe(true);
    const regionStyle = styles.get(regionId)!;
    expect(regionStyle.backgroundColor).toBeDefined();
    expect(colorDistance(regionStyle.backgroundColor!, '#ff0000')).toBeLessThan(16);
  });

  it('derives textColor and fontSize for a text node over a dark band', async () => {
    const buf = await makeTextImage();
    const ast: SemanticAST = {
      root: {
        id: 'page:0,0,200,200',
        type: 'page',
        bbox: { x: 0, y: 0, w: 200, h: 200 },
        props: {},
        children: [
          {
            id: 'text:20,20,160,30',
            type: 'text',
            bbox: { x: 20, y: 20, w: 160, h: 30 },
            props: {},
            text: 'Hello',
            children: [],
          },
        ],
      },
      version: '1.0.0',
    };

    const styles = await extractNodeStyles(makeImageInput(buf), ast);

    const textId = 'text:20,20,160,30';
    expect(styles.has(textId)).toBe(true);
    const textStyle = styles.get(textId)!;
    expect(textStyle.textColor).toBeDefined();
    expect(colorDistance(textStyle.textColor!, '#333333')).toBeLessThan(40);
    expect(textStyle.fontSize).toBe(30);
    expect(textStyle.fontWeight).toBeDefined();
    expect(textStyle.backgroundColor).toBeDefined();
  });

  it('omits nodes whose bbox falls entirely outside the image', async () => {
    const buf = await makeSolidColorImage(0, 0, 255);
    const ast: SemanticAST = {
      root: {
        id: 'page:0,0,200,200',
        type: 'page',
        bbox: { x: 0, y: 0, w: 200, h: 200 },
        props: {},
        children: [
          {
            id: 'offscreen:300,300,50,50',
            type: 'container',
            bbox: { x: 300, y: 300, w: 50, h: 50 },
            props: {},
            children: [],
          },
        ],
      },
      version: '1.0.0',
    };

    const styles = await extractNodeStyles(makeImageInput(buf), ast);

    expect(styles.has('offscreen:300,300,50,50')).toBe(false);
    expect(styles.has('page:0,0,200,200')).toBe(true);
  });
});
