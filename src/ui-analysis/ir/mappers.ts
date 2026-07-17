/**
 * Thin adapter functions mapping the existing extractor outputs into the
 * layered IR defined in ./types.ts. Pure functions, no side effects, no
 * inference beyond what the source already carries.
 *
 * @see src/core/extractors/ui-layout-extractor.ts
 * @see src/core/extractors/design-extractor.ts
 */
import type { UiLayoutExtraction } from '../../core/extractors/ui-layout-extractor.js';
import type { DesignExtraction } from '../../core/extractors/design-extractor.js';
import type { VisionIR, LayoutIR, LayoutTheme } from './types.js';

/**
 * Map a UiLayoutExtraction into a VisionIR (raw detection facts).
 *
 * - ext.components  -> detections   (score defaults to 1, no source value)
 * - ext.texts       -> ocr          (confidence defaults to 1, no source value)
 * - masks / colorSamples have no source in UiLayoutExtraction and are omitted
 *   (populated by other adapters, e.g. annotation/design extractors).
 */
export function toVisionIRFromLayout(ext: UiLayoutExtraction): VisionIR {
  const detections = ext.components.map((c) => ({
    type: c.type,
    bbox: c.bbox,
    score: 1,
  }));

  const ocr = ext.texts.map((t) => ({
    text: t.text,
    bbox: t.bbox,
    confidence: 1,
  }));

  return {
    detections,
    ocr,
  };
}

/**
 * Map a UiLayoutExtraction (and optional DesignExtraction) into a LayoutIR.
 *
 * regions / layoutType / spacing map directly (structurally identical to the
 * existing types). theme is only attached when a DesignExtraction is supplied.
 */
export function toLayoutIR(ext: UiLayoutExtraction, design?: DesignExtraction): LayoutIR {
  const layout: LayoutIR = {
    regions: ext.structure.regions,
    layoutType: ext.structure.layoutType,
    spacing: ext.spacing,
  };

  if (design) {
    const theme: LayoutTheme = {
      palette: design.palette.map((p) => ({
        hex: p.hex,
        rgb: p.rgb,
        role: p.role,
        frequency: p.frequency,
      })),
      background: design.background,
      primary: design.primary,
      textColor: design.textColor,
      isDarkMode: design.isDarkMode,
      contrastRatio: design.contrastRatio,
    };
    layout.theme = theme;
  }

  return layout;
}
