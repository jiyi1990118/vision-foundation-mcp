import { describe, expect, it } from 'vitest';
import { classifyMediaAreas } from '../../src/ui-analysis/image-content/media-area-classifier.js';
import type { MediaArea } from '../../src/core/extractors/ui-layout-extractor.js';

describe('classifyMediaAreas', () => {
  const page = { x: 0, y: 0, w: 1000, h: 800 };

  it('promotes explicit branding text to logo', () => {
    const areas: MediaArea[] = [
      { type: 'icon', bbox: { x: 20, y: 20, w: 120, h: 60 }, nearbyText: 'Acme Logo' },
    ];
    expect(classifyMediaAreas(areas, page)[0]!.type).toBe('logo');
  });

  it('promotes a large legacy icon candidate to image', () => {
    const areas: MediaArea[] = [
      { type: 'icon', bbox: { x: 100, y: 100, w: 400, h: 250 }, nearbyText: undefined },
    ];
    expect(classifyMediaAreas(areas, page)[0]!.type).toBe('image');
  });

  it('keeps ordinary icons and already-specific types unchanged', () => {
    const areas: MediaArea[] = [
      { type: 'icon', bbox: { x: 20, y: 20, w: 40, h: 40 }, nearbyText: '搜索' },
      { type: 'image', bbox: { x: 100, y: 100, w: 80, h: 60 }, nearbyText: undefined },
      { type: 'logo', bbox: { x: 200, y: 20, w: 80, h: 40 }, nearbyText: undefined },
    ];
    expect(classifyMediaAreas(areas, page).map((area) => area.type)).toEqual(['icon', 'image', 'logo']);
  });

  it('does not mutate the input array or entries', () => {
    const area: MediaArea = {
      type: 'icon',
      bbox: { x: 100, y: 100, w: 400, h: 250 },
      nearbyText: undefined,
    };
    const result = classifyMediaAreas([area], page);
    expect(area.type).toBe('icon');
    expect(result[0]).not.toBe(area);
  });
});
