import { describe, it, expect } from 'vitest';
import type { ASTNode } from '../../src/ui-analysis/ir/types.js';
import { applyCompositeGrammar } from '../../src/ui-analysis/composition/composite-grammar.js';

describe('Composite grammar', () => {
  it('marks a section containing title+subtitle+button as role=banner', () => {
    const section: ASTNode = {
      id: 'sec',
      type: 'section',
      bbox: { x: 0, y: 0, w: 375, h: 120 },
      props: {},
      children: [
        { id: 't', type: 'title', bbox: { x: 10, y: 10, w: 200, h: 30 }, props: {}, text: '夏日会员节', children: [] },
        { id: 's', type: 'subtitle', bbox: { x: 10, y: 45, w: 200, h: 20 }, props: {}, text: '立减 50 元', children: [] },
        { id: 'b', type: 'button', bbox: { x: 10, y: 75, w: 100, h: 36 }, props: {}, text: '立即领取', children: [] },
      ],
    };
    const root: ASTNode = {
      id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: {}, children: [section],
    };
    applyCompositeGrammar(root);
    expect(section.props.semanticRole).toBe('banner');
  });

  it('marks a button containing an icon as IconButton', () => {
    const button: ASTNode = {
      id: 'btn', type: 'button', bbox: { x: 0, y: 0, w: 40, h: 40 }, props: {}, children: [
        { id: 'ic', type: 'icon', bbox: { x: 10, y: 10, w: 20, h: 20 }, props: {}, children: [] },
      ],
    };
    const root: ASTNode = {
      id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: {}, children: [button],
    };
    applyCompositeGrammar(root);
    expect(button.type).toBe('iconButton');
  });

  it('marks a text label adjacent to a checkbox as controlItem', () => {
    const checkbox: ASTNode = {
      id: 'cb', type: 'checkbox', bbox: { x: 10, y: 10, w: 20, h: 20 }, props: {}, children: [],
    };
    const label: ASTNode = {
      id: 'lbl', type: 'text', bbox: { x: 35, y: 10, w: 100, h: 20 }, props: {}, text: '同意条款', children: [],
    };
    const container: ASTNode = {
      id: 'row', type: 'container', bbox: { x: 0, y: 0, w: 200, h: 40 }, props: {}, children: [checkbox, label],
    };
    const root: ASTNode = {
      id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: {}, children: [container],
    };
    applyCompositeGrammar(root);
    expect(container.props.semanticRole).toBe('controlItem');
    expect(checkbox.props.labelNodeId).toBe('lbl');
  });
});
