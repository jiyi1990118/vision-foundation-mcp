/**
 * LayoutEngine adapter wrapping the legacy `extractUiLayout` extractor.
 *
 * Composes (does not inherit) the existing extractor + IR mapper so the
 * legacy function stays untouched while exposing the new `LayoutEngine` trait.
 *
 * @see src/core/extractors/ui-layout-extractor.ts
 * @see src/ui-analysis/ir/mappers.ts
 */
import type { ImageInput } from '../../types/domain.js';
import type { DesignExtraction } from '../../core/extractors/design-extractor.js';
import { extractUiLayout } from '../../core/extractors/ui-layout-extractor.js';
import type { OcrItem } from '../../core/key-content-extractor.js';
import { toLayoutIR } from '../ir/mappers.js';
import type { LayoutIR, VisionDetection, VisionOcrItem } from '../ir/types.js';
import type { LayoutEngine } from './types.js';

/**
 * Convert IR OCR items (`{ x, y, w, h }`) back to the legacy `OcrItem` shape
 * (`box: { x1, y1, x2, y2 }`) expected by `extractUiLayout`.
 */
export function visionOcrItemsToOcrItems(items: VisionOcrItem[]): OcrItem[] {
  return items.map((item) => ({
    text: item.text,
    box: {
      x1: item.bbox.x,
      y1: item.bbox.y,
      x2: item.bbox.x + item.bbox.w,
      y2: item.bbox.y + item.bbox.h,
    },
    confidence: item.confidence,
  }));
}

/**
 * LayoutEngine backed by `extractUiLayout`.
 *
 * An optional `designProvider` may be injected to attach a theme to the
 * resulting LayoutIR; when absent the LayoutIR is returned without a theme.
 * The legacy `extractUiLayout` runs its own pixel analysis (sharp), so an
 * image is required for `build`.
 */
export class UiLayoutLayoutEngine implements LayoutEngine {
  readonly name = 'ui-layout-extractor';
  readonly version = '1.0.0';

  constructor(
    private readonly designProvider?: (image: ImageInput) => Promise<DesignExtraction | undefined>,
  ) {}

  async build(
    _detections: VisionDetection[],
    ocr: VisionOcrItem[],
    image?: ImageInput,
  ): Promise<LayoutIR> {
    if (!image) {
      throw new Error('UiLayoutLayoutEngine.build requires an image to run extractUiLayout');
    }
    const ocrItems = visionOcrItemsToOcrItems(ocr);
    const extraction = await extractUiLayout(image, ocrItems, undefined);
    if (this.designProvider) {
      const design = await this.designProvider(image);
      return design ? toLayoutIR(extraction, design) : toLayoutIR(extraction);
    }
    return toLayoutIR(extraction);
  }
}
