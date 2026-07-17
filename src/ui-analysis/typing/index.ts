/**
 * Barrel export for the UI analysis type-enrichment layer (Stream S23,
 * G-A1+G-A2). A pure post-pass that promotes generic component types on a
 * built SemanticAST to surface the ~18 ComponentType values the
 * ast-builder never emits (list / listItem / divider / textarea / tag /
 * toolbar / iconButton / title / subtitle ...).
 *
 * @see ./type-enricher.js  (enrichNodeTypes)
 * @see ../ir/types.js      (ComponentType union)
 */
export { enrichNodeTypes } from './type-enricher.js';
