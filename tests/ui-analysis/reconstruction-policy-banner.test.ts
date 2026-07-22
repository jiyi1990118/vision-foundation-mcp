import { describe, it, expect } from 'vitest';
import type { ASTNode, DecodedImage } from '../../src/ui-analysis/ir/types.js';
import { assignRenderModes } from '../../src/ui-analysis/policy/reconstruction-policy.js';
import { layerizeBanner } from '../../src/ui-analysis/composition/banner-layerizer.js';

function makeImage(width: number, height: number, fillFn: (x: number, y: number) => [number, number, number]): DecodedImage {
  const stride = 4;
  const data = Buffer.alloc(width * height * stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fillFn(x, y);
      const idx = (y * width + x) * stride;
      data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
    }
  }
  return { data, width, height, stride };
}

function makeBannerRoot(bannerBbox: { x: number; y: number; w: number; h: number }): ASTNode {
  return {
    id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: {},
    children: [
      {
        id: 'banner', type: 'section', bbox: bannerBbox, props: { semanticRole: 'banner' },
        children: [
          { id: 'title', type: 'title', bbox: { x: 10, y: 10, w: 100, h: 30 }, props: {}, text: '标题', children: [] },
          { id: 'btn', type: 'button', bbox: { x: 10, y: 50, w: 80, h: 30 }, props: {}, text: '按钮', children: [] },
        ],
      },
    ],
  };
}

describe('ReconstructionPolicy banner hybrid mode', () => {
  it('assigns hybrid to a solid-background banner when image provided', () => {
    const img = makeImage(200, 100, (x, y) => {
      if (y >= 40 && y < 50 && x >= 20 && x < 180) return [255, 255, 255];
      return [22, 119, 255];
    });
    const root = makeBannerRoot({ x: 0, y: 0, w: 200, h: 100 });
    assignRenderModes(root, { bannerFallback: true, image: img, layerizeFn: layerizeBanner });
    const banner = root.children[0]!;
    expect(banner.props.render.mode).toBe('hybrid');
    // Children should be native (not semantic-only) in hybrid mode
    expect(banner.children[0]!.props.render.mode).toBe('native');
  });

  it('assigns asset to a complex-image banner when image provided', () => {
    const img = makeImage(200, 100, (x, y) => {
      return [(x * 7 + y * 13) % 256, (x * 3 + y * 17 + 50) % 256, (x * 11 + y * 5 + 100) % 256];
    });
    const root = makeBannerRoot({ x: 0, y: 0, w: 200, h: 100 });
    assignRenderModes(root, { bannerFallback: true, image: img, layerizeFn: layerizeBanner });
    const banner = root.children[0]!;
    expect(banner.props.render.mode).toBe('asset');
    expect(banner.props.render.assetId).toBeDefined();
    // Children should be semantic-only in asset mode
    expect(banner.children[0]!.props.render.mode).toBe('semantic-only');
  });

  it('assigns asset to banner when no image provided (fallback)', () => {
    const root = makeBannerRoot({ x: 0, y: 0, w: 200, h: 100 });
    assignRenderModes(root, { bannerFallback: true });
    const banner = root.children[0]!;
    expect(banner.props.render.mode).toBe('asset');
  });
});
