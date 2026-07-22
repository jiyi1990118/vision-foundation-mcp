import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { runUiAnalysis } from '../../src/ui-analysis/orchestrator.js';
import type { UiLayoutExtraction } from '../../src/core/extractors/ui-layout-extractor.js';
import type { ImageInput } from '../../src/types/domain.js';
import type { ASTNode } from '../../src/ui-analysis/ir/types.js';
import type { ControlAppearance } from '../../src/ui-analysis/control/index.js';

function makeLayoutWithControl(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'form',
      layoutType: 'stack',
      regions: [{
        id: 'r1',
        type: 'content',
        bbox: { x: 0, y: 0, w: 100, h: 100 },
        relativeArea: 1,
        children: [],
      }],
    },
    components: [{
      type: 'input',
      bbox: { x: 10, y: 10, w: 24, h: 24 },
      text: '',
      state: 'default',
      variant: 'default',
    }],
    texts: [],
    spacing: { averageGap: 10, scale: 'comfortable', verticalGaps: [], horizontalGaps: [] },
    mediaAreas: [],
    summary: '',
  };
}

/**
 * 100x100 canvas matching the region bbox. A checked checkbox is drawn around
 * the component bbox (10,10,24,24): a gray frame whose corners fill the bbox
 * (so shape detection sees a square) with a saturated blue interior (so fill
 * detection sees "checked"). The frame extends slightly beyond the bbox so
 * the analyzer's corner overread does not land on white background.
 */
async function makeControlImage(): Promise<ImageInput> {
  const width = 100, height = 100, stride = 4;
  const buf = Buffer.alloc(width * height * stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * stride;
      let r = 255, g = 255, b = 255;
      const inFill = x >= 12 && x < 32 && y >= 12 && y < 32;
      const inFrame = x >= 7 && x < 37 && y >= 7 && y < 37;
      if (inFill) {
        r = 22; g = 119; b = 255;
      } else if (inFrame) {
        r = 200; g = 200; b = 200;
      }
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = 255;
    }
  }
  const png = await sharp(buf, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { buffer: png, mimeType: 'image/png', source: 'test', size: png.length };
}

function findControl(node: ASTNode): ASTNode | null {
  if (node.type === 'checkbox' || node.type === 'radio' || node.type === 'switch') return node;
  if (node.props.control !== undefined) return node;
  for (const c of node.children) {
    const found = findControl(c);
    if (found) return found;
  }
  return null;
}

describe('orchestrator control analysis', () => {
  it('analyzes control appearance for input nodes when image is provided', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayoutWithControl(),
      image: await makeControlImage(),
      options: {
        buildTree: true,
        detectLayout: false,
        detectComponent: true,
        detectText: false,
        detectIcon: false,
        detectTheme: false,
      },
    });
    expect(result.ui).toBeDefined();
    const controlNode = findControl(result.ui!.root);
    expect(controlNode).not.toBeNull();
    // The input should be promoted to checkbox with control props.
    expect(controlNode!.type).toBe('checkbox');
    expect(controlNode!.props.control).toBeDefined();
    const control = controlNode!.props.control as ControlAppearance;
    expect(control.state).toBe('checked');
  });
});
