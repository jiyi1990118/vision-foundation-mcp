import sharp from 'sharp';
import type { ImageInput } from '../../types/domain.js';
import type { OcrItem } from '../../core/key-content-extractor.js';
import {
  extractUiLayout,
  type UiLayoutExtraction,
} from '../../core/extractors/ui-layout-extractor.js';
import { detectMediaAreasForAnalysis } from '../image-content/media-area-detector.js';

const LEGACY_WORK_WIDTH = 400;

function scaleOcrItems(items: OcrItem[] | undefined, scaleX: number, scaleY: number): OcrItem[] | undefined {
  if (items === undefined) return undefined;
  return items.map((item) => item.box
    ? {
        ...item,
        box: {
          x1: item.box.x1 * scaleX,
          y1: item.box.y1 * scaleY,
          x2: item.box.x2 * scaleX,
          y2: item.box.y2 * scaleY,
        },
      }
    : item);
}

function spacingScale(gaps: number[], scale: number): number[] {
  return gaps.map((gap) => gap * scale);
}

function classifySpacing(averageGap: number): UiLayoutExtraction['spacing']['scale'] {
  return averageGap < 5 ? 'compact' : averageGap < 15 ? 'comfortable' : 'spacious';
}

function buildSummary(extraction: UiLayoutExtraction): string {
  const parts: string[] = [];
  const regionTypes = [...new Set(extraction.structure.regions.map((region) => region.type))];
  parts.push(`${extraction.structure.regions.length} 个视觉区域（${regionTypes.join('/')}）`);
  parts.push(`${extraction.components.length} 个组件`);
  if (extraction.mediaAreas.length > 0) {
    parts.push(`${extraction.mediaAreas.length} 个图标/图片区域`);
  }
  parts.push(`间距风格：${extraction.spacing.scale}`);
  const titleCount = extraction.texts.filter((text) => text.estimatedLevel === 'title').length;
  if (titleCount > 0) parts.push(`标题 ${titleCount} 个`);
  return parts.join('，');
}

/**
 * Run the legacy 400px CV extractor without mixing its thumbnail coordinate
 * system with original-image OCR coordinates. The legacy implementation stays
 * untouched; this adapter scales OCR in and restores text/spacing facts out.
 */
export async function extractUiLayoutForAnalysis(
  image: ImageInput,
  ocrItems?: OcrItem[],
  designPalette?: { hex: string; role: string }[],
  options: { detectMedia?: boolean } = {},
): Promise<UiLayoutExtraction> {
  const metadata = await sharp(image.buffer).metadata();
  const originalWidth = metadata.width ?? 1;
  const originalHeight = metadata.height ?? 1;
  const workWidth = LEGACY_WORK_WIDTH;
  const workHeight = Math.max(1, Math.round(originalHeight * workWidth / originalWidth));
  const toWorkX = workWidth / originalWidth;
  const toWorkY = workHeight / originalHeight;
  const toOriginalX = originalWidth / workWidth;
  const toOriginalY = originalHeight / workHeight;

  const extraction = await extractUiLayout(
    image,
    scaleOcrItems(ocrItems, toWorkX, toWorkY),
    designPalette,
  );

  extraction.texts = extraction.texts.map((text) => ({
    ...text,
    bbox: {
      x: text.bbox.x * toOriginalX,
      y: text.bbox.y * toOriginalY,
      w: text.bbox.w * toOriginalX,
      h: text.bbox.h * toOriginalY,
    },
  }));
  const verticalGaps = spacingScale(extraction.spacing.verticalGaps, toOriginalY);
  const horizontalGaps = spacingScale(extraction.spacing.horizontalGaps, toOriginalX);
  const allGaps = [...verticalGaps, ...horizontalGaps];
  const averageGap = allGaps.length > 0
    ? allGaps.reduce((sum, gap) => sum + gap, 0) / allGaps.length
    : 0;
  extraction.spacing = {
    ...extraction.spacing,
    verticalGaps,
    horizontalGaps,
    averageGap,
    scale: classifySpacing(averageGap),
  };
  extraction.mediaAreas = options.detectMedia === false
    ? []
    : await detectMediaAreasForAnalysis(image, ocrItems);
  extraction.summary = buildSummary(extraction);
  return extraction;
}
