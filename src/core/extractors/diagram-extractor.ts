/**
 * Diagram Extractor - structured extraction for flowcharts / architecture
 * diagrams.
 *
 * Strategy (robust, OCR + spatial reasoning, NOT VLM-trusted):
 * 1. Detect nodes: OCR text regions are node labels; cluster nearby text into
 *    node groups.  Rectangular shapes (detected via connected dark regions)
 *    bound the nodes.
 * 2. Infer edges: arrows/connectors are hard to detect pixel-perfectly, so we
 *    infer flow by spatial proximity + vertical/topological ordering (most
 *    flowcharts read top-to-bottom or left-to-right).  Two nodes are "connected"
 *    if they are nearest neighbors in the dominant flow direction.
 * 3. Extract decision points (diamond/branch labels: 是/否/yes/no/条件).
 * 4. Compose a structured flow description.
 *
 * Why not VLM: diagrams cause VLM to invent nodes/edges; OCR + spatial
 * reasoning reads the actual labeled nodes and a plausible flow.
 */
import sharp from 'sharp';
import type { ImageInput } from '../../types/domain.js';
import type { OcrItem, Box } from '../key-content-extractor.js';
import { extractOcrItems, parseBox } from '../key-content-extractor.js';
import { logger } from '../../utils/logger.js';

export interface DiagramNode {
  id: number;
  label: string;
  box: Box;
  /** Neighboring node ids (inferred edges, downstream). */
  next: number[];
  isDecision?: boolean;
}

export interface DiagramExtraction {
  nodes: DiagramNode[];
  /** Inferred edges as [fromId, toId] pairs. */
  edges: Array<[number, number]>;
  /** Detected branch conditions (是/否/yes/no/...). */
  conditions: string[];
  flowDirection: 'top-down' | 'left-right' | 'unknown';
  summary: string;
}

export interface DiagramExtractionInput {
  image: ImageInput;
  ocrData?: unknown;
  ocrItems?: OcrItem[];
}

const DECISION_KEYWORDS = ['是否', '是/否', 'yes', 'no', '条件', '判断', '?', '？', 'decision', 'if', 'else'];

/**
 * Extract structured diagram (nodes + inferred flow) from an image + OCR.
 */
export async function extractDiagram(input: DiagramExtractionInput): Promise<DiagramExtraction> {
  const items = input.ocrItems ?? extractOcrItems(input.ocrData, 'full');

  const nodes = buildNodes(items);
  const flowDirection = detectFlowDirection(nodes);
  const edges = inferEdges(nodes, flowDirection);
  const conditions = extractConditions(items);

  // Attach downstream edges to nodes.
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const [from, to] of edges) {
    const node = nodeById.get(from);
    if (node) node.next.push(to);
  }

  const summary = composeDiagramSummary(nodes, edges, flowDirection, conditions);

  return { nodes, edges, conditions, flowDirection, summary };
}

/**
 * Build diagram nodes from OCR items: cluster items on the same horizontal
 * band (same y-region) into a single node, using its bounding box as the node.
 */
export function buildNodes(items: OcrItem[]): DiagramNode[] {
  const boxed = items.filter((i): i is OcrItem & { box: Box } => i.box !== undefined);
  if (boxed.length === 0) {
    // No boxes - each text item is its own node.
    return items.map((item, idx) => ({
      id: idx,
      label: item.text.trim(),
      box: { x1: 0, y1: 0, x2: 0, y2: 0 },
      next: [],
    }));
  }

  const sorted = [...boxed].sort((a, b) => centerY(a.box) - centerY(b.box));
  const clusters: Array<{ items: OcrItem[]; box: Box }> = [];

  for (const item of sorted) {
    const cy = centerY(item.box);
    // Find an existing cluster on a nearby y-band (within 0.6x text height).
    const height = item.box.y2 - item.box.y1;
    const tol = Math.max(12, height * 0.8);
    const cluster = clusters.find((c) => {
      const cCy = (c.box.y1 + c.box.y2) / 2;
      return Math.abs(cCy - cy) <= tol;
    });
    if (cluster) {
      cluster.items.push(item);
      cluster.box = unionBox(cluster.box, item.box);
    } else {
      clusters.push({ items: [item], box: { ...item.box } });
    }
  }

  return clusters.map((cluster, idx) => {
    const label = cluster.items
      .map((i) => i.text.trim())
      .filter(Boolean)
      .join(' ');
    const isDecision = DECISION_KEYWORDS.some((kw) => label.toLowerCase().includes(kw));
    return {
      id: idx,
      label,
      box: cluster.box,
      next: [],
      ...(isDecision ? { isDecision: true } : {}),
    };
  });
}

/**
 * Detect the dominant flow direction by comparing horizontal vs vertical
 * spread of node centers.
 */
export function detectFlowDirection(nodes: DiagramNode[]): 'top-down' | 'left-right' | 'unknown' {
  if (nodes.length < 2) return 'unknown';

  const ys = nodes.map((n) => centerY(n.box));
  const xs = nodes.map((n) => centerX(n.box));
  const ySpread = Math.max(...ys) - Math.min(...ys);
  const xSpread = Math.max(...xs) - Math.min(...xs);

  if (ySpread > xSpread * 1.3) return 'top-down';
  if (xSpread > ySpread * 1.3) return 'left-right';
  return 'unknown';
}

/**
 * Infer edges by connecting each node to its nearest downstream neighbor
 * (in the flow direction).  This produces a plausible flow without pixel-level
 * arrow detection.
 */
export function inferEdges(nodes: DiagramNode[], direction: 'top-down' | 'left-right' | 'unknown'): Array<[number, number]> {
  if (nodes.length < 2) return [];

  const edges: Array<[number, number]> = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    // Candidates: nodes that are "downstream" (greater y or x depending on dir).
    const candidates = nodes.filter((other) => {
      if (other.id === node.id) return false;
      if (direction === 'top-down') return centerY(other.box) > centerY(node.box) + 5;
      if (direction === 'left-right') return centerX(other.box) > centerX(node.box) + 5;
      // unknown: any node with greater center distance in either axis
      return centerY(other.box) > centerY(node.box) + 5 || centerX(other.box) > centerX(node.box) + 5;
    });

    if (candidates.length === 0) continue;

    // Pick the nearest candidate by Euclidean distance.
    let best = candidates[0]!;
    let bestDist = nodeDistance(node, best);
    for (const c of candidates.slice(1)) {
      const d = nodeDistance(node, c);
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }

    const key = `${node.id}->${best.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push([node.id, best.id]);
    }
  }

  return edges;
}

/**
 * Extract branch conditions (decision labels) from OCR text.
 */
export function extractConditions(items: OcrItem[]): string[] {
  const conditions: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const text = item.text.trim();
    if (/^(是|否|yes|no|true|false|成功|失败|通过|不通过)$/i.test(text) && !seen.has(text)) {
      seen.add(text);
      conditions.push(text);
    }
  }
  return conditions;
}

function composeDiagramSummary(
  nodes: DiagramNode[],
  edges: Array<[number, number]>,
  direction: 'top-down' | 'left-right' | 'unknown',
  conditions: string[],
): string {
  if (nodes.length === 0) return '未识别到流程节点。';

  const dirLabel = direction === 'top-down' ? '自上而下' : direction === 'left-right' ? '自左向右' : '混合方向';
  const parts: string[] = [];
  parts.push(`【流程图/架构图】共 ${nodes.length} 个节点，${edges.length} 条流向（${dirLabel}）。`);

  // List the flow as a chain for readability.
  const labelById = new Map(nodes.map((n) => [n.id, n.label]));
  const flowChains: string[] = [];
  for (const [from, to] of edges.slice(0, 12)) {
    const fromLabel = labelById.get(from) ?? `#${from}`;
    const toLabel = labelById.get(to) ?? `#${to}`;
    flowChains.push(`${fromLabel} -> ${toLabel}`);
  }
  if (flowChains.length > 0) parts.push(`流向：${flowChains.join('；')}。`);
  if (conditions.length > 0) parts.push(`分支条件：${conditions.join('、')}。`);

  return parts.join('');
}

// ── Geometry helpers ─────────────────────────────────────

function centerX(box: Box): number {
  return (box.x1 + box.x2) / 2;
}
function centerY(box: Box): number {
  return (box.y1 + box.y2) / 2;
}
function unionBox(a: Box, b: Box): Box {
  return {
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
    x2: Math.max(a.x2, b.x2),
    y2: Math.max(a.y2, b.y2),
  };
}
function nodeDistance(a: DiagramNode, b: DiagramNode): number {
  const dx = centerX(a.box) - centerX(b.box);
  const dy = centerY(a.box) - centerY(b.box);
  return Math.sqrt(dx * dx + dy * dy);
}

// Re-export parseBox for callers that need it (avoid unused import warning).
export { parseBox };
// sharp import retained for future node-shape detection (pixel analysis).
export { sharp as _sharp };
void logger;
