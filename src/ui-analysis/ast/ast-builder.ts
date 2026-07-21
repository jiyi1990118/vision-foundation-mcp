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
const DUPLICATE_IOU = 0.8;
const CONTROL_OCR_COVERAGE = 0.7;
const TEXT_REGION_IOU = 0.5;

function bboxArea(b: BBox): number {
  return b.w * b.h;
}

function validBBox(b: BBox): boolean {
  return [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0;
}

function bboxIntersection(a: BBox, b: BBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

function bboxIou(a: BBox, b: BBox): number {
  const intersection = bboxIntersection(a, b);
  const union = bboxArea(a) + bboxArea(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

function bboxCoverage(inner: BBox, outer: BBox): number {
  const area = bboxArea(inner);
  return area > 0 ? bboxIntersection(inner, outer) / area : 0;
}

function clipBBox(bbox: BBox, bounds: BBox): BBox | null {
  const x0 = Math.max(bbox.x, bounds.x);
  const y0 = Math.max(bbox.y, bounds.y);
  const x1 = Math.min(bbox.x + bbox.w, bounds.x + bounds.w);
  const y1 = Math.min(bbox.y + bbox.h, bounds.y + bounds.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
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
  const valid = bboxes.filter(validBBox);
  if (valid.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of valid) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function normalizedText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function dedupeDetections(detections: VisionDetection[]): VisionDetection[] {
  const result: VisionDetection[] = [];
  for (const detection of detections) {
    if (!validBBox(detection.bbox) || !Number.isFinite(detection.score)) continue;
    const index = result.findIndex((existing) => (
      existing.type === detection.type && bboxIou(existing.bbox, detection.bbox) >= DUPLICATE_IOU
    ));
    if (index < 0) {
      result.push(detection);
    } else if (detection.score > result[index]!.score) {
      result[index] = detection;
    }
  }
  return result;
}

function dedupeOcr(items: VisionOcrItem[]): VisionOcrItem[] {
  const result: VisionOcrItem[] = [];
  for (const item of items) {
    if (!validBBox(item.bbox) || !Number.isFinite(item.confidence) || normalizedText(item.text).length === 0) continue;
    const text = normalizedText(item.text);
    const index = result.findIndex((existing) => (
      normalizedText(existing.text) === text && bboxIou(existing.bbox, item.bbox) >= DUPLICATE_IOU
    ));
    if (index < 0) {
      result.push(item);
    } else if (item.confidence > result[index]!.confidence) {
      result[index] = item;
    }
  }
  return result;
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
  icon: 'icon',
  image: 'image',
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
  pageBounds?: BBox,
): SemanticAST {
  const usedIds = new Set<string>();
  const cleanDetections = dedupeDetections(detections ?? []);
  const cleanOcr = dedupeOcr(ocr ?? []);
  const cleanMedia = (mediaAreas ?? []).filter((area) => validBBox(area.bbox));
  const cleanRegions = layout.regions.filter((region) => validBBox(region.bbox));

  const explicitPage = pageBounds !== undefined && validBBox(pageBounds) ? pageBounds : undefined;
  const pageBbox = explicitPage ?? unionBounds([
    ...cleanRegions.map((region) => region.bbox),
    ...cleanDetections.map((detection) => detection.bbox),
    ...cleanOcr.map((item) => item.bbox),
    ...cleanMedia.map((area) => area.bbox),
  ]);

  const regions = cleanRegions.flatMap((region) => {
    const bbox = explicitPage ? clipBBox(region.bbox, explicitPage) : region.bbox;
    return bbox === null ? [] : [{ ...region, bbox }];
  });
  const fittedDetections = cleanDetections.flatMap((detection) => {
    const bbox = explicitPage ? clipBBox(detection.bbox, explicitPage) : detection.bbox;
    return bbox === null ? [] : [{ ...detection, bbox }];
  });
  const fittedOcr = cleanOcr.flatMap((item) => {
    const bbox = explicitPage ? clipBBox(item.bbox, explicitPage) : item.bbox;
    return bbox === null ? [] : [{ ...item, bbox }];
  });
  const fittedMedia = cleanMedia.flatMap((area) => {
    const bbox = explicitPage ? clipBBox(area.bbox, explicitPage) : area.bbox;
    return bbox === null ? [] : [{ ...area, bbox }];
  });

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

  const detectionNodes: ASTNode[] = fittedDetections.map((d) => {
    const type = mapComponentType(d.type);
    const node: ASTNode = {
      id: nodeId(type, d.bbox, usedIds),
      type,
      bbox: d.bbox,
      props: {
        score: d.score,
        sourceType: d.type,
        ...(d.state !== undefined ? { state: d.state } : {}),
        ...(d.variant !== undefined ? { variant: d.variant } : {}),
      },
      children: [],
    };
    if (d.text !== undefined && d.text.trim().length > 0) node.text = d.text;
    return node;
  });

  const mediaNodes: ASTNode[] = fittedMedia.map((m) => {
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

  // Any node can be a parent (not just regions) - this lets a button contain
  // an icon, a card contain text, etc. The tightest enclosing node wins.
  const parentIdx: number[] = new Array(allNodes.length).fill(0);
  for (let i = 1; i < allNodes.length; i++) {
    const node = allNodes[i]!;
    const nodeArea = bboxArea(node.bbox);
    let bestParent = 0;
    let bestArea = Infinity;
    for (let j = 1; j < allNodes.length; j++) {
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

  const findSmallest = (nodes: ASTNode[], predicate: (node: ASTNode) => boolean): ASTNode | undefined => {
    let best: ASTNode | undefined;
    let bestArea = Infinity;
    for (const node of nodes) {
      if (!predicate(node)) continue;
      const area = bboxArea(node.bbox);
      if (area < bestArea) {
        best = node;
        bestArea = area;
      }
    }
    return best;
  };

  for (const item of fittedOcr) {
    const control = findSmallest(detectionNodes, (node) => (
      bboxCoverage(item.bbox, node.bbox) >= CONTROL_OCR_COVERAGE
    ));
    if (control !== undefined) {
      if (control.text === undefined) {
        control.text = item.text;
        control.props.confidence = item.confidence;
        continue;
      }
      if (normalizedText(control.text) === normalizedText(item.text)) {
        control.props.confidence = item.confidence;
        continue;
      }
    }

    const tightRegion = findSmallest(regionNodes, (node) => bboxIou(node.bbox, item.bbox) >= TEXT_REGION_IOU);
    if (tightRegion !== undefined && tightRegion.text === undefined) {
      tightRegion.text = item.text;
      tightRegion.props.confidence = item.confidence;
      continue;
    }

    const { cx, cy } = bboxCenter(item.bbox);
    const parent = findSmallest(regionNodes, (node) => (
      bboxContains(node.bbox, item.bbox) || containsPoint(node.bbox, cx, cy)
    )) ?? page;
    parent.children.push({
      id: nodeId('text', item.bbox, usedIds),
      type: 'text',
      bbox: item.bbox,
      props: { confidence: item.confidence },
      text: item.text,
      children: [],
    });
  }

  return { root: page, version: AST_VERSION };
}
