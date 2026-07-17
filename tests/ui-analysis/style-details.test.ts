import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { extractNodeStyles } from '../../src/ui-analysis/style/style-extractor.js';
import type { SemanticAST, BBox } from '../../src/ui-analysis/ir/types.js';

async function makeCompositeImage(
  width: number,
  height: number,
  svgBody: string,
): Promise<Buffer> {
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${svgBody}</svg>`;
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
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

function makeAstWithCard(bbox: BBox, imageW: number, imageH: number): SemanticAST {
  const id = `card:${bbox.x},${bbox.y},${bbox.w},${bbox.h}`;
  return {
    root: {
      id: `page:0,0,${imageW},${imageH}`,
      type: 'page',
      bbox: { x: 0, y: 0, w: imageW, h: imageH },
      props: {},
      children: [
        {
          id,
          type: 'card',
          bbox,
          props: {},
          children: [],
        },
      ],
    },
    version: '1.0.0',
  };
}

describe('extractNodeStyles - borderRadius (S18)', () => {
  it('detects a non-zero borderRadius for a rounded rectangle (rx=8)', async () => {
    const buf = await makeCompositeImage(
      200,
      200,
      '<rect x="40" y="40" width="120" height="80" rx="8" ry="8" fill="#3b82f6"/>',
    );
    const ast = makeAstWithCard({ x: 40, y: 40, w: 120, h: 80 }, 200, 200);

    const styles = await extractNodeStyles(makeImageInput(buf), ast);

    const cardId = 'card:40,40,120,80';
    expect(styles.has(cardId)).toBe(true);
    const style = styles.get(cardId)!;
    expect(style.borderRadius).toBeDefined();
    expect(style.borderRadius!).toBeGreaterThanOrEqual(4);
    expect(style.borderRadius!).toBeLessThanOrEqual(12);
    expect(style.boxShadow).toBeUndefined();
  });

  it('omits borderRadius (or zero) for a sharp rectangle with no rounding', async () => {
    const buf = await makeCompositeImage(
      200,
      200,
      '<rect x="40" y="40" width="120" height="80" fill="#3b82f6"/>',
    );
    const ast = makeAstWithCard({ x: 40, y: 40, w: 120, h: 80 }, 200, 200);

    const styles = await extractNodeStyles(makeImageInput(buf), ast);

    const cardId = 'card:40,40,120,80';
    expect(styles.has(cardId)).toBe(true);
    const style = styles.get(cardId)!;
    expect(style.borderRadius === undefined || style.borderRadius === 0).toBe(true);
    expect(style.boxShadow).toBeUndefined();
  });

  it('detects borderRadius for a white card with a border on a white page (fill === pageBg)', async () => {
    // Regression: previously the scan compared corner pixels to `fill`; when
    // the card fill equals the page background (very common: white card on
    // white page, distinguished only by a border), the corner page-bg pixels
    // matched fill and the scan broke at 0 -> borderRadius omitted. The fix
    // scans for pageBg pixels (the rounded cutout) stopping at the border.
    const buf = await makeCompositeImage(
      300,
      200,
      '<rect x="40" y="40" width="180" height="100" rx="12" ry="12" fill="#ffffff" stroke="#d9d9d9"/>',
    );
    const ast = makeAstWithCard({ x: 40, y: 40, w: 180, h: 100 }, 300, 200);

    const styles = await extractNodeStyles(makeImageInput(buf), ast);

    const cardId = 'card:40,40,180,100';
    expect(styles.has(cardId)).toBe(true);
    const style = styles.get(cardId)!;
    expect(style.borderRadius).toBeDefined();
    expect(style.borderRadius!).toBeGreaterThanOrEqual(4);
  });
});

describe('extractNodeStyles - boxShadow (S18)', () => {
  it('detects a shadow for a card with an offset dark band outside its bbox', async () => {
    const svgBody =
      '<rect x="46" y="46" width="120" height="80" fill="#000000" fill-opacity="0.35"/>' +
      '<rect x="40" y="40" width="120" height="80" rx="8" ry="8" fill="#3b82f6"/>';
    const buf = await makeCompositeImage(300, 200, svgBody);
    const ast = makeAstWithCard({ x: 40, y: 40, w: 120, h: 80 }, 300, 200);

    const styles = await extractNodeStyles(makeImageInput(buf), ast);

    const cardId = 'card:40,40,120,80';
    expect(styles.has(cardId)).toBe(true);
    const style = styles.get(cardId)!;
    expect(style.boxShadow).toBeDefined();
    expect(typeof style.boxShadow).toBe('string');
    expect(style.boxShadow!).toMatch(/^0 2px 8px rgba\(/);
    expect(style.borderRadius).toBeDefined();
    expect(style.borderRadius!).toBeGreaterThanOrEqual(4);
  });
});
