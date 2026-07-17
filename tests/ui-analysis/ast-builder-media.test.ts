import { describe, expect, it } from 'vitest';
import { buildSemanticAst } from '../../src/ui-analysis/ast/ast-builder.js';
import type { LayoutIR } from '../../src/ui-analysis/ir/types.js';
import type { MediaArea } from '../../src/core/extractors/ui-layout-extractor.js';

function makeLayoutWithMedia(): { layout: LayoutIR; mediaAreas: MediaArea[] } {
  const layout: LayoutIR = {
    regions: [
      { id: 'r0', type: 'main', bbox: { x: 0, y: 0, w: 400, h: 400 }, relativeArea: 1, children: [] },
      { id: 'r1', type: 'card', bbox: { x: 10, y: 10, w: 200, h: 300 }, relativeArea: 0.375, children: [] },
    ],
    layoutType: 'stack',
    spacing: { averageGap: 8, scale: 'comfortable', verticalGaps: [5], horizontalGaps: [10] },
  };
  const mediaAreas: MediaArea[] = [
    { bbox: { x: 20, y: 20, w: 16, h: 16 }, type: 'icon', nearbyText: undefined },
    { bbox: { x: 20, y: 100, w: 100, h: 80 }, type: 'image', nearbyText: undefined },
  ];
  return { layout, mediaAreas };
}

describe('ast-builder mediaAreas', () => {
  it('attaches icon and image media nodes as leaves under their tightest enclosing region', () => {
    const { layout, mediaAreas } = makeLayoutWithMedia();
    const ast = buildSemanticAst(layout, undefined, undefined, mediaAreas);

    expect(ast.root.type).toBe('page');
    const main = ast.root.children[0]!;
    expect(main.type).toBe('section');

    const card = main.children.find((c) => c.type === 'card');
    expect(card).toBeDefined();

    const iconNode = card!.children.find((c) => c.type === 'icon');
    expect(iconNode).toBeDefined();
    expect(iconNode!.bbox).toEqual({ x: 20, y: 20, w: 16, h: 16 });
    expect(iconNode!.props.mediaType).toBe('icon');
    expect(iconNode!.children).toHaveLength(0);

    const imageNode = card!.children.find((c) => c.type === 'image');
    expect(imageNode).toBeDefined();
    expect(imageNode!.bbox).toEqual({ x: 20, y: 100, w: 100, h: 80 });
    expect(imageNode!.props.mediaType).toBe('image');
    expect(imageNode!.children).toHaveLength(0);

    expect(card!.children.map((c) => c.type).sort()).toEqual(['icon', 'image']);
  });

  it('maps logo -> avatar and binds nearbyText onto the media node as node.text', () => {
    const layout: LayoutIR = {
      regions: [
        { id: 'r0', type: 'main', bbox: { x: 0, y: 0, w: 400, h: 400 }, relativeArea: 1, children: [] },
      ],
      layoutType: 'stack',
      spacing: { averageGap: 8, scale: 'comfortable', verticalGaps: [5], horizontalGaps: [10] },
    };
    const mediaAreas: MediaArea[] = [
      { bbox: { x: 20, y: 20, w: 16, h: 16 }, type: 'logo', nearbyText: 'Company Logo' },
    ];

    const ast = buildSemanticAst(layout, undefined, undefined, mediaAreas);
    const main = ast.root.children[0]!;
    expect(main.type).toBe('section');

    const avatarNode = main.children.find((c) => c.type === 'avatar');
    expect(avatarNode).toBeDefined();
    expect(avatarNode!.text).toBe('Company Logo');
    expect(avatarNode!.props.mediaType).toBe('logo');
  });
});
