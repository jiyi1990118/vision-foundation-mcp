import { describe, it, expect } from 'vitest';
import { runUiAnalysis } from '../../src/ui-analysis/orchestrator.js';
import type { UiLayoutExtraction } from '../../src/core/extractors/ui-layout-extractor.js';

function makeMinimalLayout(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'card',
      layoutType: 'stack',
      regions: [
        { id: 'r0', type: 'card', bbox: { x: 0, y: 0, w: 100, h: 100 }, relativeArea: 1, children: [] },
      ],
    },
    components: [],
    texts: [],
    spacing: { averageGap: 10, scale: 'comfortable', verticalGaps: [], horizontalGaps: [] },
    mediaAreas: [],
    summary: '',
  };
}

describe('orchestrator reconstruction_mode', () => {
  it('assigns render modes to tree nodes', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeMinimalLayout(),
      options: {
        buildTree: true,
        detectLayout: false,
        detectComponent: false,
        detectText: false,
        detectIcon: false,
        detectTheme: false,
      },
    });
    expect(result.uiReconstruction).toBeDefined();
    // The root page node should have a render mode assigned
    expect(result.uiReconstruction!.tree.props.render).toBeDefined();
  });
});
