import { describe, expect, it } from 'vitest';
import { injectNodeStyles } from '../../src/ui-analysis/style/index.js';
import type { SemanticAST, NodeStyle } from '../../src/ui-analysis/ir/types.js';

function makeAst(): SemanticAST {
  return {
    root: {
      id: 'page:0,0,400,400',
      type: 'page',
      bbox: { x: 0, y: 0, w: 400, h: 400 },
      props: {},
      children: [
        {
          id: 'region:0,0,400,200',
          type: 'card',
          bbox: { x: 0, y: 0, w: 400, h: 200 },
          props: {},
          children: [
            {
              id: 'text:10,10,100,24',
              type: 'text',
              bbox: { x: 10, y: 10, w: 100, h: 24 },
              props: {},
              text: 'Hello',
              children: [],
            },
          ],
        },
      ],
    },
    version: '1.0.0',
  };
}

describe('injectNodeStyles', () => {
  it('attaches sampled style onto matching node props.style', () => {
    const ast = makeAst();
    const styles = new Map<string, NodeStyle>();
    styles.set('region:0,0,400,200', {
      backgroundColor: '#ffffff',
      borderColor: '#e0e0e0',
    });
    styles.set('text:10,10,100,24', {
      backgroundColor: '#ffffff',
      textColor: '#333333',
      fontSize: 24,
      fontWeight: 700,
    });

    injectNodeStyles(ast, styles);

    const region = ast.root.children[0]!;
    expect(region.props.style).toBeDefined();
    const regionStyle = region.props.style as NodeStyle;
    expect(regionStyle.backgroundColor).toBe('#ffffff');
    expect(regionStyle.borderColor).toBe('#e0e0e0');

    const text = region.children[0]!;
    expect(text.props.style).toBeDefined();
    const textStyle = text.props.style as NodeStyle;
    expect(textStyle.textColor).toBe('#333333');
    expect(textStyle.fontSize).toBe(24);
    expect(textStyle.fontWeight).toBe(700);
  });

  it('leaves nodes without a sampled style untouched', () => {
    const ast = makeAst();
    const styles = new Map<string, NodeStyle>();
    styles.set('text:10,10,100,24', { textColor: '#000000', fontSize: 12 });

    injectNodeStyles(ast, styles);

    const region = ast.root.children[0]!;
    expect(region.props.style).toBeUndefined();
    const text = region.children[0]!;
    expect(text.props.style).toBeDefined();
    expect((text.props.style as NodeStyle).fontSize).toBe(12);
  });
});
