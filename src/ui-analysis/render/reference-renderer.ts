import type { ASTNode, NodeStyle } from '../ir/types.js';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readStyle(node: ASTNode): NodeStyle | null {
  const s = node.props.style;
  if (s === undefined || typeof s !== 'object' || s === null) return null;
  return s as NodeStyle;
}

function renderNode(node: ASTNode): string {
  const { bbox } = node;
  const style = readStyle(node);
  const fill = style?.backgroundColor ?? '#f0f0f0';
  const rx = style?.borderRadius ?? 0;
  let parts = `  <rect x="${bbox.x}" y="${bbox.y}" width="${bbox.w}" height="${bbox.h}" fill="${fill}" rx="${rx}" stroke="#999" stroke-width="0.5"/>\n`;
  if (node.text !== undefined && node.text.length > 0) {
    const textColor = style?.textColor ?? '#333';
    const fontSize = style?.fontSize ?? 14;
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    parts += `  <text x="${cx}" y="${cy}" font-size="${fontSize}" fill="${textColor}" text-anchor="middle" dominant-baseline="middle">${escapeXml(node.text)}</text>\n`;
  }
  for (const child of node.children) {
    parts += renderNode(child);
  }
  return parts;
}

export function renderAstToSvg(root: ASTNode): string {
  const { bbox } = root;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${bbox.w}" height="${bbox.h}" viewBox="0 0 ${bbox.w} ${bbox.h}">\n`;
  svg += renderNode(root);
  svg += '</svg>';
  return svg;
}
