import { describe, expect, it } from 'vitest';
import { analyzeUiPipeline } from '../../src/ui-analysis/pipeline.js';
import type { UiLayoutExtraction, MediaArea } from '../../src/core/extractors/ui-layout-extractor.js';

function makeUiLayout(mediaAreas: MediaArea[]): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'general-ui',
      layoutType: 'stack',
      regions: [
        { id: 'r0', type: 'header', bbox: { x: 0, y: 0, w: 400, h: 60 }, relativeArea: 0.15, children: [] },
      ],
    },
    components: [],
    texts: [],
    spacing: { averageGap: 8, scale: 'comfortable', verticalGaps: [], horizontalGaps: [] },
    mediaAreas,
    summary: '1 region',
  };
}

describe('analyzeUiPipeline imageContents', () => {
  it('extracts imageContents from mediaAreas and crops equal bbox', () => {
    const mediaAreas: MediaArea[] = [
      { type: 'icon', bbox: { x: 120, y: 80, w: 24, h: 24 }, nearbyText: '搜索' },
      { type: 'image', bbox: { x: 10, y: 10, w: 200, h: 150 }, nearbyText: undefined },
    ];
    const result = analyzeUiPipeline({ uiLayoutExtraction: makeUiLayout(mediaAreas) });

    expect(result.imageContents).toBeDefined();
    expect(result.imageContents!).toHaveLength(2);
    expect(result.imageContents![0]!.crop).toEqual({ x: 120, y: 80, w: 24, h: 24 });
    expect(result.imageContents![1]!.crop).toEqual({ x: 10, y: 10, w: 200, h: 150 });
  });

  it('returns empty imageContents when no mediaAreas pass the threshold', () => {
    const result = analyzeUiPipeline({
      uiLayoutExtraction: makeUiLayout([{ type: 'icon', bbox: { x: 0, y: 0, w: 2, h: 2 }, nearbyText: 'tiny' }]),
    });

    expect(result.imageContents).toBeDefined();
    expect(result.imageContents!).toHaveLength(0);
  });
});
