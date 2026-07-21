import type { ASTNode } from '../ir/types.js';
import type { RenderInfo } from './types.js';

export interface PolicyOptions {
  /** When true, banners without separable backgrounds fall back to asset. */
  bannerFallback?: boolean;
}

function hasStyle(node: ASTNode): boolean {
  return node.props.style !== undefined && typeof node.props.style === 'object';
}

function hasControlState(node: ASTNode): boolean {
  return node.props.control !== undefined && typeof node.props.control === 'object';
}

let assetCounter = 0;

function nextAssetId(): string {
  assetCounter++;
  return `asset-${assetCounter}`;
}

/**
 * Walk the AST and assign a RenderInfo to each node's props.render.
 *
 * The walk is top-down: each node's own mode is decided from its own
 * properties (it never depends on descendants), then children are
 * recursed with the parent's mode so that children of an `asset` node
 * can be marked `semantic-only`.
 *
 * - native: structure + style + content reliable
 * - hybrid: asset background + native children
 * - asset: whole crop for visual completeness
 * - semantic-only: info only, must not be re-rendered (child of asset)
 */
export function assignRenderModes(root: ASTNode, options?: PolicyOptions): void {
  const walk = (node: ASTNode, parentMode?: string): void => {
    let render: RenderInfo;

    // Children of an asset-mode parent are semantic-only.
    if (parentMode === 'asset') {
      render = { mode: 'semantic-only' };
      node.props.render = render;
      for (const child of node.children) walk(child, render.mode);
      return;
    }

    // Banner without separable background -> asset fallback.
    if (options?.bannerFallback === true && node.props.semanticRole === 'banner') {
      const assetId = nextAssetId();
      render = { mode: 'asset', assetId, reason: 'banner-background-not-separable' };
      node.props.render = render;
      for (const child of node.children) walk(child, render.mode);
      return;
    }

    // Checkbox/radio/switch with detected state -> native.
    if (
      (node.type === 'checkbox' || node.type === 'radio' || node.type === 'switch')
      && hasControlState(node)
    ) {
      render = { mode: 'native' };
      node.props.render = render;
      for (const child of node.children) walk(child, render.mode);
      return;
    }

    // Text/title/subtitle with style -> native.
    if (
      (node.type === 'text' || node.type === 'title' || node.type === 'subtitle')
      && hasStyle(node)
    ) {
      render = { mode: 'native' };
      node.props.render = render;
      for (const child of node.children) walk(child, render.mode);
      return;
    }

    // Button/iconButton with style -> native.
    if ((node.type === 'button' || node.type === 'iconButton') && hasStyle(node)) {
      render = { mode: 'native' };
      node.props.render = render;
      for (const child of node.children) walk(child, render.mode);
      return;
    }

    // Default: native for containers and everything else.
    render = { mode: 'native' };
    node.props.render = render;
    for (const child of node.children) walk(child, render.mode);
  };
  walk(root);
}
