/**
 * Detector adapter wrapping the legacy `extractUiLayout` extractor.
 *
 * Runs `extractUiLayout` then maps the result to `VisionDetection[]` via the
 * IR mapper. Composes (does not inherit) the existing extractor.
 *
 * @see src/core/extractors/ui-layout-extractor.ts
 * @see src/ui-analysis/ir/mappers.ts
 */
import type { ImageInput } from '../../types/domain.js';
import { extractUiLayout } from '../../core/extractors/ui-layout-extractor.js';
import { toVisionIRFromLayout } from '../ir/mappers.js';
import type { VisionDetection } from '../ir/types.js';
import type { Detector } from './types.js';

/**
 * Detector backed by `extractUiLayout` + the IR mapper.
 *
 * The legacy extractor performs its own pixel analysis (sharp), so detection
 * is driven by the image rather than by external model weights.
 */
export class UiLayoutDetector implements Detector {
  readonly name = 'ui-layout-detector';
  readonly version = '1.0.0';

  async initialize(): Promise<void> {
    // extractUiLayout is stateless (sharp-based); nothing to load.
  }

  async detect(image: ImageInput): Promise<VisionDetection[]> {
    const extraction = await extractUiLayout(image, undefined, undefined);
    const ir = toVisionIRFromLayout(extraction);
    return ir.detections;
  }
}
