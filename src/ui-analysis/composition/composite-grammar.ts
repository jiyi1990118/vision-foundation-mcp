import type { ASTNode, BBox } from '../ir/types.js';

function horizontallyAdjacent(a: BBox, b: BBox, maxGap: number): boolean {
  const aRight = a.x + a.w;
  const bLeft = b.x;
  const gap = Math.abs(bLeft - aRight);
  if (gap > maxGap) return false;
  const overlapTop = Math.max(a.y, b.y);
  const overlapBottom = Math.min(a.y + a.h, b.y + b.h);
  return overlapBottom > overlapTop;
}

export function applyCompositeGrammar(root: ASTNode): void {
  const walk = (node: ASTNode): void => {
    for (const child of node.children) walk(child);

    if (node.type === 'button') {
      const hasIcon = node.children.some((c) => c.type === 'icon');
      if (hasIcon) node.type = 'iconButton';
    }

    if (node.type === 'section' || node.type === 'container') {
      const hasTitle = node.children.some((c) => c.type === 'title' || c.type === 'subtitle');
      const hasButton = node.children.some((c) => c.type === 'button' || c.type === 'iconButton');
      if (hasTitle && hasButton) {
        node.props.semanticRole = 'banner';
      }
    }

    const control = node.children.find((c) => c.type === 'checkbox' || c.type === 'radio' || c.type === 'switch');
    if (control !== undefined) {
      const label = node.children.find((c) => (
        c.type === 'text' && horizontallyAdjacent(control.bbox, c.bbox, 30)
      ));
      if (label !== undefined) {
        node.props.semanticRole = 'controlItem';
        control.props.labelNodeId = label.id;
      }
    }

    const input = node.children.find((c) => c.type === 'input' || c.type === 'textarea' || c.type === 'select');
    if (input !== undefined) {
      const label = node.children.find((c) => (
        c.type === 'text' && c.props.semanticRole === 'label'
      ));
      if (label !== undefined) {
        node.props.semanticRole = 'formField';
      }
    }
  };
  walk(root);
}
