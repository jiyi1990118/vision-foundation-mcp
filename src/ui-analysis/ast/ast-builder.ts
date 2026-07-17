/**
 * AST Builder - converts a flat LayoutIR (regions[]) into a hierarchical
 * SemanticAST tree by bbox containment. Pure, deterministic, no IO, no model.
 *
 * Regions become container ASTNodes; the tree is reconstructed purely from
 * bbox containment (the smallest enclosing region is the parent, the page
 * node is the fallback root). When OCR items are supplied, each text bbox is
 * bound to its tightest enclosing node. When detections are supplied, each
 * becomes a leaf node attached to its tightest enclosing region.
 *
 * @see src/ui-analysis/ir/types.ts  (S0 IR contract)
 * @see src/core/extractors/ui-layout-extractor.ts  (VisualRegion source)
 */
import type {
  LayoutIR,
  SemanticAST,
  ASTNode,
  ComponentType,
  BBox,
  VisionOcrItem,
  VisionDetection,
} from '../ir/types.js';
import type { MediaArea } from '../../core/extractors/ui-layout-extractor.js';

const AST_VERSION = '1.0.0';

function bboxArea(b: BBox): number {
  return b.w * b.h;
}

function bboxContains(outer: BBox, inner: BBox): boolean {
  const eps = 1e-6;
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.w <= outer.x + outer.w + eps &&
    inner.y + inner.h <= outer.y + outer.h + eps
  );
}

function containsPoint(b: BBox, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

function bboxCenter(b: BBox): { cx: number; cy: number } {
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
}

function r(n: number): number {
  return Math.round(n);
}

function unionBounds(bboxes: BBox[]): BBox {
  if (bboxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of bboxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

const REGION_TYPE_MAP: Record<string, ComponentType> = {
  header: 'header',
  footer: 'footer',
  sidebar: 'sidebar',
  card: 'card',
  nav: 'navbar',
  table: 'table',
  main: 'section',
  content: 'container',
};

function mapRegionType(type: string): ComponentType {
  return REGION_TYPE_MAP[type] ?? 'unknown';
}

const COMPONENT_TYPE_MAP: Record<string, ComponentType> = {
  button: 'button',
  input: 'input',
  dropdown: 'dropdown',
  table: 'table',
  tab: 'tab',
  card: 'card',
  checkbox: 'checkbox',
  toggle: 'switch',
  badge: 'badge',
  avatar: 'avatar',
  unknown: 'unknown',
};

function mapComponentType(type: string): ComponentType {
  return COMPONENT_TYPE_MAP[type] ?? 'unknown';
}

const MEDIA_TYPE_MAP: Record<MediaArea['type'], ComponentType> = {
  icon: 'icon',
  image: 'image',
  logo: 'avatar',
};

function mapMediaType(type: MediaArea['type']): ComponentType {
  return MEDIA_TYPE_MAP[type] ?? 'unknown';
}

function nodeId(type: ComponentType, bbox: BBox, used: Set<string>): string {
  const base = `${type}:${r(bbox.x)},${r(bbox.y)},${r(bbox.w)},${r(bbox.h)}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  let id = `${base}#${i}`;
  while (used.has(id)) {
    i++;
    id = `${base}#${i}`;
  }
  used.add(id);
  return id;
}

/**
 * Build a hierarchical SemanticAST from a flat LayoutIR.
 *
 * The page node (type 'page') is the root; its bbox is the union of all
 * region bboxes. Regions are nested by tightest bbox containment. Optional
 * `detections` attach as leaf component nodes inside their tightest region;
 * optional `ocr` items bind their text to the tightest enclosing node (first
 * sets node.text, subsequent ones become child 'text' nodes). Optional
 * `mediaAreas` (icon/image/logo) attach as typed leaf nodes ('icon'/'image'/
 * 'avatar') under their tightest enclosing region; nearbyText becomes
 * node.text.
 */
export function buildSemanticAst(
  layout: LayoutIR,
  ocr?: VisionOcrItem[],
  detections?: VisionDetection[],
  mediaAreas?: MediaArea[],
): SemanticAST {
  const usedIds = new Set<string>();
  const regions = layout.regions;

  const pageBbox = unionBounds(regions.map((reg) => reg.bbox));
  const page: ASTNode = {
    id: nodeId('page', pageBbox, usedIds),
    type: 'page',
    bbox: pageBbox,
    props: { layoutType: layout.layoutType },
    children: [],
  };

  const regionNodes: ASTNode[] = regions.map((reg) => {
    const type = mapRegionType(reg.type);
    return {
      id: nodeId(type, reg.bbox, usedIds),
      type,
      bbox: reg.bbox,
      props: { regionId: reg.id, relativeArea: reg.relativeArea, ...(reg.bgColor ? { bgColor: reg.bgColor } : {}) },
      children: [],
    };
  });

  const detectionNodes: ASTNode[] = (detections ?? []).map((d) => {
    const type = mapComponentType(d.type);
    return {
      id: nodeId(type, d.bbox, usedIds),
      type,
      bbox: d.bbox,
      props: { score: d.score, sourceType: d.type },
      children: [],
    };
  });

  const mediaNodes: ASTNode[] = (mediaAreas ?? []).map((m) => {
    const type = mapMediaType(m.type);
    const node: ASTNode = {
      id: nodeId(type, m.bbox, usedIds),
      type,
      bbox: m.bbox,
      props: { mediaType: m.type },
      children: [],
    };
    if (m.nearbyText !== undefined) {
      node.text = m.nearbyText;
    }
    return node;
  });

  const allNodes: ASTNode[] = [page, ...regionNodes, ...detectionNodes, ...mediaNodes];
  const containerCount = 1 + regionNodes.length;

  const parentIdx: number[] = new Array(allNodes.length).fill(0);
  for (let i = 1; i < allNodes.length; i++) {
    const node = allNodes[i]!;
    const nodeArea = bboxArea(node.bbox);
    let bestParent = 0;
    let bestArea = Infinity;
    for (let j = 1; j < containerCount; j++) {
      if (i === j) continue;
      const cand = allNodes[j]!;
      const candArea = bboxArea(cand.bbox);
      if (candArea <= nodeArea) continue;
      if (candArea >= bestArea) continue;
      if (!bboxContains(cand.bbox, node.bbox)) continue;
      bestArea = candArea;
      bestParent = j;
    }
    parentIdx[i] = bestParent;
  }

  for (let i = 1; i < allNodes.length; i++) {
    const p = parentIdx[i]!;
    allNodes[p]!.children.push(allNodes[i]!);
  }

  if (ocr && ocr.length > 0) {
    for (const item of ocr) {
      const { cx, cy } = bboxCenter(item.bbox);
      let target = 0;
      let targetArea = Infinity;
      for (let j = 1; j < allNodes.length; j++) {
        const cand = allNodes[j]!;
        if (!containsPoint(cand.bbox, cx, cy)) continue;
        const a = bboxArea(cand.bbox);
        if (a < targetArea) {
          targetArea = a;
          target = j;
        }
      }
      const tnode = allNodes[target]!;
      if (tnode.text === undefined) {
        tnode.text = item.text;
        tnode.props.confidence = item.confidence;
      } else {
        tnode.children.push({
          id: nodeId('text', item.bbox, usedIds),
          type: 'text',
          bbox: item.bbox,
          props: { confidence: item.confidence },
          text: item.text,
          children: [],
        });
      }
    }
  }

  return { root: page, version: AST_VERSION };
}
