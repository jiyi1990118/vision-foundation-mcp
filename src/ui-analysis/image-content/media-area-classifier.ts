import type { MediaArea } from '../../core/extractors/ui-layout-extractor.js';
import type { BBox } from '../ir/types.js';

const IMAGE_MIN_PAGE_AREA = 0.02;
const IMAGE_MIN_SIDE = 96;
const LOGO_TEXT = /logo|品牌|标志|商标/i;

/**
 * Recover media classes that the legacy 20px-block detector cannot emit after
 * merging. This pass is intentionally conservative: explicit branding wins;
 * only clearly large candidates become images; everything else stays an icon.
 */
export function classifyMediaAreas(areas: MediaArea[], page: BBox): MediaArea[] {
  const pageArea = Math.max(1, page.w * page.h);
  return areas.map((area) => {
    if (area.type !== 'icon') return { ...area, bbox: { ...area.bbox } };
    const nearbyText = area.nearbyText?.trim() ?? '';
    if (LOGO_TEXT.test(nearbyText)) {
      return { ...area, bbox: { ...area.bbox }, type: 'logo' };
    }
    const relativeArea = area.bbox.w * area.bbox.h / pageArea;
    if (
      relativeArea >= IMAGE_MIN_PAGE_AREA
      && area.bbox.w >= IMAGE_MIN_SIDE
      && area.bbox.h >= IMAGE_MIN_SIDE
    ) {
      return { ...area, bbox: { ...area.bbox }, type: 'image' };
    }
    return { ...area, bbox: { ...area.bbox } };
  });
}
