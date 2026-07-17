/**
 * Image-content extractor (Stream S13).
 *
 * Turns icon/image/logo `MediaArea` detections into "recoverable" image
 * content info for downstream agents: an original-image crop rectangle
 * (ready for the agent to cut the region out) plus an accessibility/alt
 * text derived from nearby OCR text or a sensible default per type.
 *
 * Pure, deterministic, no IO, no VLM call. The VLM description path is a
 * later wave; this module only produces the algorithmic crop + alt fallback.
 *
 * @see ../../core/extractors/ui-layout-extractor.js  (MediaArea source of truth, already in original-image coords)
 * @see ../ir/types.js                                (BBox)
 */
import type { MediaArea } from '../../core/extractors/ui-layout-extractor.js';
import type { BBox } from '../ir/types.js';

export interface ImageContentInfo {
  index: number;
  type: 'icon' | 'image' | 'logo';
  bbox: BBox;
  nearbyText?: string;
  crop: { x: number; y: number; w: number; h: number };
  altText: string;
  description?: string;
  dataUrl?: string;
}

const MIN_BBOX_AREA = 16;

const DEFAULT_ALT_TEXT: Record<MediaArea['type'], string> = {
  icon: '图标',
  image: '图片',
  logo: 'Logo',
};

function clampCrop(bbox: BBox): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, bbox.x);
  const y = Math.max(0, bbox.y);
  const w = Math.max(1, bbox.w);
  const h = Math.max(1, bbox.h);
  return { x, y, w, h };
}

export function extractImageContents(mediaAreas: MediaArea[]): ImageContentInfo[] {
  const results: ImageContentInfo[] = [];
  let index = 0;
  for (const area of mediaAreas) {
    const { bbox, type, nearbyText } = area;
    if (bbox.w * bbox.h < MIN_BBOX_AREA) continue;

    const crop = clampCrop(bbox);
    const trimmed = nearbyText?.trim();
    const hasText = trimmed !== undefined && trimmed.length > 0;
    const altText = hasText ? (trimmed as string) : DEFAULT_ALT_TEXT[type];

    const info: ImageContentInfo = {
      index,
      type,
      bbox: { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h },
      crop,
      altText,
    };
    if (hasText) info.nearbyText = trimmed as string;
    results.push(info);
    index++;
  }
  return results;
}
