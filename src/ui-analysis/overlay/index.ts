/**
 * Barrel export for the overlay detection layer (Stream S25, G-C1). A
 * best-effort post-pass that detects modal overlays (dialog / drawer /
 * bottomSheet) on a built SemanticAST and models their z-index, surfacing
 * the three ComponentType values the ast-builder never emits.
 *
 * @see ./overlay-detector.js  (detectOverlays / applyOverlays)
 * @see ../ir/types.js        (ComponentType: dialog/drawer/bottomSheet)
 */
export { detectOverlays, applyOverlays } from './overlay-detector.js';
export type { OverlayInfo } from './overlay-detector.js';
