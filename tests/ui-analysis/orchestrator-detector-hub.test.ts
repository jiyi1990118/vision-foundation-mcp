import { describe, it, expect } from 'vitest';
import { runUiAnalysis } from '../../src/ui-analysis/orchestrator.js';
import type { UiLayoutExtraction } from '../../src/core/extractors/ui-layout-extractor.js';

function makeLayout(): UiLayoutExtraction {
  return {
    structure: {
      regions: [{
        id: 'r1', type: 'content',
        bbox: { x: 0, y: 0, w: 100, h: 100 },
        relativeArea: 1,
      }],
    },
    components: [{ type: 'button', bbox: { x: 10, y: 10, w: 80, h: 30 }, score: 0.9 }],
    texts: [{ text: 'Submit', box: { x1: 10, y1: 10, x2: 90, y2: 40 } }],
    mediaAreas: [],
    spacing: { averageGap: 10, scale: 'comfortable', verticalGaps: [], horizontalGaps: [] },
    layoutType: 'stack',
  } as unknown as UiLayoutExtraction;
}

describe('orchestrator detector hub', () => {
  it('works with reconstruction_mode=fast (no detector hub)', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      options: {
        buildTree: true,
        reconstructionMode: 'fast',
      },
    });
    expect(result.uiReconstruction).toBeDefined();
    expect(result.uiReconstruction!.tree.props.render).toBeDefined();
  });

  it('works with reconstruction_mode=balanced (detector hub enabled, no models)', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      options: {
        buildTree: true,
        reconstructionMode: 'balanced',
      },
    });
    expect(result.uiReconstruction).toBeDefined();
    expect(result.uiReconstruction!.tree.props.render).toBeDefined();
  });

  it('works with reconstruction_mode=high_fidelity (detector hub + omniparser check)', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeLayout(),
      options: {
        buildTree: true,
        reconstructionMode: 'high_fidelity',
      },
    });
    expect(result.uiReconstruction).toBeDefined();
    // OmniParser is not installed, should degrade gracefully
    expect(result.uiReconstruction!.tree.props.render).toBeDefined();
  });
});
