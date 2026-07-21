import { describe, it, expect } from 'vitest';
import type { ASTNode } from '../../src/ui-analysis/ir/types.js';
import { renderAstToSvg } from '../../src/ui-analysis/render/index.js';

describe('Reference renderer', () => {
  it('renders a simple tree as SVG', () => {
    const root: ASTNode = {
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 375, h: 200 },
      props: {},
      children: [
        {
          id: 'btn',
          type: 'button',
          bbox: { x: 10, y: 10, w: 100, h: 40 },
          props: { style: { backgroundColor: '#1677ff' } },
          text: '登录',
          children: [],
        },
      ],
    };
    const svg = renderAstToSvg(root);
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="375"');
    expect(svg).toContain('height="200"');
    expect(svg).toContain('fill="#1677ff"');
    expect(svg).toContain('登录');
  });
});
