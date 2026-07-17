/**
 * Barrel export for the UI analysis style layer (Stream S11).
 *
 * The style layer samples raw image pixels within each AST node's bbox to
 * produce a per-component {@link NodeStyle} (background / border / text
 * color / font size / font weight), giving downstream agents the visual
 * fidelity needed to reconstruct the UI. Pure pixel sampling, no model.
 *
 * @see ./style-extractor.ts  (extractNodeStyles)
 * @see ../ir/types.ts        (NodeStyle contract)
 */
export { extractNodeStyles, injectNodeStyles } from './style-extractor.js';
export type { NodeStyle } from '../ir/types.js';
