/**
 * Adapter converting core `OcrItem` (box={x1,y1,x2,y2}) into the layered-IR
 * `VisionOcrItem` (bbox={x,y,w,h}), preserving the real OCR confidence so
 * downstream AST text nodes carry a trustworthy reliability signal instead
 * of the hardcoded `1` produced by `toVisionIRFromLayout` (G-D2).
 *
 * Pure, side-effect free. Items without a usable box are skipped because
 * `VisionOcrItem` requires a bbox; missing confidence defaults to `1` to
 * stay compatible with the legacy mapper behavior.
 *
 * @see src/core/key-content-extractor.ts  (OcrItem / Box source of truth)
 * @see src/ui-analysis/ir/types.ts        (VisionOcrItem / BBox contract)
 * @see src/ui-analysis/ast/ast-builder.ts (confidence -> text node props)
 */
import type { OcrItem } from '../../core/key-content-extractor.js';
import type { VisionOcrItem } from './types.js';

export function ocrItemsToVisionOcr(items: OcrItem[]): VisionOcrItem[] {
  const out: VisionOcrItem[] = [];
  for (const item of items) {
    const box = item.box;
    if (!box) continue;
    if (![box.x1, box.y1, box.x2, box.y2].every(Number.isFinite)) continue;
    const w = box.x2 - box.x1;
    const h = box.y2 - box.y1;
    if (w <= 0 || h <= 0) continue;
    const confidence = item.confidence ?? 1;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    out.push({
      text: item.text,
      bbox: { x: box.x1, y: box.y1, w, h },
      confidence,
    });
  }
  return out;
}
