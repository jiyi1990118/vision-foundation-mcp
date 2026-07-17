/**
 * Barrel export for the UI analysis semantic layer (Stream S9).
 *
 * The semantic layer is the algorithmic "understanding" that makes the LLM
 * optional: page-type classification, component variant/state inference, and
 * human-readable summary generation - all pure deterministic functions over
 * the SemanticAST + LayoutIR + OCR.
 *
 * @see ./page-type-engine.ts  (inferPageType / PageType)
 * @see ./variant-engine.ts    (inferVariants / VariantInfo / hexDistance)
 * @see ./summary-engine.ts    (buildSemanticSummary)
 */
export { inferPageType } from './page-type-engine.js';
export type { PageType, PageTypeResult, PageTypeInput } from './page-type-engine.js';

export {
  inferVariants,
  hexToRgb,
  hexDistance,
} from './variant-engine.js';
export type { Variant, VariantState, VariantInfo } from './variant-engine.js';

export { buildSemanticSummary } from './summary-engine.js';
export type { SummaryInput } from './summary-engine.js';
