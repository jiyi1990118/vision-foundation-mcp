import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { runUiAnalysis } from '../../src/ui-analysis/orchestrator.js';
import type { UiLayoutExtraction } from '../../src/core/extractors/ui-layout-extractor.js';
import type { ImageInput } from '../../src/types/domain.js';
import type { ASTNode } from '../../src/ui-analysis/ir/types.js';

/**
 * 200x100 banner: solid blue background with a white text band in the
 * vertical center (y 40-50). The border ring (top/bottom/left/right strips
 * sampled by the banner layerizer) stays pure blue so the background is
 * detected as separable -> hybrid mode.
 */
async function makeBannerImage(): Promise<ImageInput> {
  const width = 200, height = 100;
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (y >= 40 && y < 50 && x >= 20 && x < 180) {
        raw[idx] = 255; raw[idx + 1] = 255; raw[idx + 2] = 255; raw[idx + 3] = 255; // text
      } else {
        raw[idx] = 22; raw[idx + 1] = 119; raw[idx + 2] = 255; raw[idx + 3] = 255; // blue bg
      }
    }
  }
  const buf = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length };
}

/**
 * Layout that produces a banner through the full pipeline:
 *   - region type 'main' -> AST node type 'section'
 *   - title text at the top (y=5) so promoteTopTitle (TITLE_TOP_RATIO=0.15)
 *     promotes the OCR text node to a 'title' child of the section
 *   - button child so applyCompositeGrammar tags the section semanticRole=banner
 *
 * The OCR text bbox has IoU < 0.5 with the region, so the ast-builder attaches
 * it as a child 'text' node (rather than binding to the region's own text).
 */
function makeBannerLayout(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'banner',
      layoutType: 'stack',
      regions: [{
        id: 'banner-region',
        type: 'main',
        bbox: { x: 0, y: 0, w: 200, h: 100 },
        relativeArea: 1,
        children: [],
      }],
    },
    components: [
      { type: 'button', bbox: { x: 60, y: 60, w: 80, h: 25 }, text: '', state: 'default', variant: 'primary' },
    ],
    texts: [
      { text: 'Banner Title', bbox: { x: 60, y: 5, w: 80, h: 12 }, estimatedLevel: 'title' },
    ],
    spacing: { averageGap: 10, scale: 'comfortable', verticalGaps: [], horizontalGaps: [] },
    mediaAreas: [],
    summary: 'solid-background banner with title and button',
  };
}

function findBanner(node: ASTNode): ASTNode | null {
  if (node.props.semanticRole === 'banner') return node;
  for (const c of node.children) {
    const found = findBanner(c);
    if (found) return found;
  }
  return null;
}

function collectRenderModes(node: ASTNode, modes: string[] = []): string[] {
  const render = node.props.render;
  if (render !== null && typeof render === 'object' && 'mode' in render) {
    modes.push((render as { mode: string }).mode);
  }
  for (const c of node.children) collectRenderModes(c, modes);
  return modes;
}

describe('orchestrator banner e2e', () => {
  it('assigns hybrid mode to a solid-background banner through full pipeline', async () => {
    const image = await makeBannerImage();
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeBannerLayout(),
      image,
      options: {
        buildTree: true,
        detectLayout: true,
        detectComponent: true,
        detectText: true,
        detectIcon: false,
        detectTheme: false,
      },
    });
    expect(result.ui).toBeDefined();
    const banner = findBanner(result.ui!.root);
    expect(banner).not.toBeNull();
    expect(banner!.props.render).toBeDefined();
    // With a solid separable background, the banner should be hybrid (not asset).
    expect(banner!.props.render.mode).toBe('hybrid');
  });

  it('all nodes have render modes assigned', async () => {
    const image = await makeBannerImage();
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeBannerLayout(),
      image,
      options: { buildTree: true },
    });
    expect(result.uiReconstruction).toBeDefined();
    expect(result.uiReconstruction!.tree.props.render).toBeDefined();
    const modes = collectRenderModes(result.ui!.root);
    expect(modes.length).toBeGreaterThan(0);
    for (const m of modes) {
      expect(['native', 'hybrid', 'asset', 'semantic-only']).toContain(m);
    }
  });
});
