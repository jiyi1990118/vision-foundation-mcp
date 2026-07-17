/**
 * Barrel export for the UI analysis interactivity layer (Stream S28, G-C2).
 * A pure post-pass that infers component interaction state (placeholder /
 * disabled / link) from the already-sampled `node.props.style` and writes
 * it onto `node.props.interactive`. No image decode; reuses style + type.
 *
 * @see ./interactivity-enricher.js  (enrichInteractivity)
 * @see ../ir/types.js               (NodeStyle, ASTNode)
 */
export { enrichInteractivity } from './interactivity-enricher.js';
export type { Interactivity } from './interactivity-enricher.js';
