import { describe, it, expect } from 'vitest';
import type { ASTNode } from '../../src/ui-analysis/ir/types.js';
import { assignRenderModes } from '../../src/ui-analysis/policy/reconstruction-policy.js';

describe('ReconstructionPolicy', () => {
  it('assigns native to a simple text node with style', () => {
    const node: ASTNode = {
      id: 't1', type: 'text', bbox: { x: 0, y: 0, w: 100, h: 20 }, props: { style: { backgroundColor: '#fff' } }, text: 'Hello', children: [],
    };
    const root: ASTNode = { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: {}, children: [node] };
    assignRenderModes(root);
    expect(node.props.render).toEqual({ mode: 'native' });
  });

  it('assigns asset to a banner with no separable background', () => {
    const banner: ASTNode = {
      id: 'b1', type: 'section', bbox: { x: 0, y: 0, w: 375, h: 120 },
      props: { semanticRole: 'banner' },
      children: [
        { id: 't', type: 'title', bbox: { x: 10, y: 10, w: 100, h: 30 }, props: {}, text: '标题', children: [] },
      ],
    };
    const root: ASTNode = { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: {}, children: [banner] };
    assignRenderModes(root, { bannerFallback: true });
    expect(banner.props.render.mode).toBe('asset');
    expect(banner.props.render.assetId).toBeDefined();
    // Children of an asset banner become semantic-only
    expect(banner.children[0]!.props.render.mode).toBe('semantic-only');
  });

  it('assigns native to a checkbox with detected state', () => {
    const cb: ASTNode = {
      id: 'cb', type: 'checkbox', bbox: { x: 0, y: 0, w: 20, h: 20 },
      props: { control: { family: 'checkbox', state: 'checked' } },
      children: [],
    };
    const root: ASTNode = { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: {}, children: [cb] };
    assignRenderModes(root);
    expect(cb.props.render.mode).toBe('native');
  });
});
