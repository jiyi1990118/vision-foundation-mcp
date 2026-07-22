/**
 * Barrel export for the UI analysis control-appearance layer (P2 Task 2).
 *
 * A pure pixel-sampling post-pass that detects the family (checkbox / radio
 * / switch), shape, and state (checked / unchecked / indeterminate /
 * disabled) of a toggle control from a decoded image buffer + bbox, without
 * relying on OCR keywords.
 *
 * @see ./control-analyzer.js  (analyzeControlAppearance)
 */
export type { ControlAppearance } from './control-analyzer.js';
export { analyzeControlAppearance } from './control-analyzer.js';
