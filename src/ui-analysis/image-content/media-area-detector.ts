import sharp from 'sharp';
import type { ImageInput } from '../../types/domain.js';
import type { MediaArea } from '../../core/extractors/ui-layout-extractor.js';
import type { OcrItem } from '../../core/key-content-extractor.js';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface OcrFact {
  text: string;
  bbox: Rect;
  confidence: number;
}

interface Candidate {
  bbox: Rect;
  nearbyText?: string;
  score: number;
}

interface CandidateSeed {
  bbox: Rect;
  nearbyText?: string;
  anchored?: boolean;
  textured?: boolean;
}

const WORK_WIDTH = 400;
const BLOCK_SIZE = 20;
const TEXTURE_BLOCK_SIZE = 10;
const EDGE_THRESHOLD = 30;
const MIN_EDGE_DENSITY = 0.12;
const MIN_TEXTURE_EDGE_DENSITY = 0.24;
const MIN_TEXTURE_DEVIATION = 24;
const OCR_VETO_CONFIDENCE = 0.9;
const OCR_VETO_COVERAGE = 0.2;
const WIDE_OCR_VETO_COVERAGE = 0.1;
const TEXTURE_OCR_VETO_CONFIDENCE = 0.65;
const TEXTURE_OCR_VETO_COVERAGE = 0.55;
const OCR_EDGE_MARGIN = 2;
const MAX_ASPECT_RATIO = 4;
const LABEL_GAP_HEIGHTS = 1.2;

function area(rect: Rect): number {
  return Math.max(0, rect.w) * Math.max(0, rect.h);
}

function intersectionArea(a: Rect, b: Rect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

function expand(rect: Rect, margin: number): Rect {
  return {
    x: rect.x - margin,
    y: rect.y - margin,
    w: rect.w + margin * 2,
    h: rect.h + margin * 2,
  };
}

function verticalOverlapRatio(a: Rect, b: Rect): number {
  const overlap = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const height = Math.min(a.h, b.h);
  return height > 0 ? overlap / height : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 20;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function toOcrFacts(
  items: OcrItem[] | undefined,
  scaleX: number,
  scaleY: number,
): OcrFact[] {
  const facts: OcrFact[] = [];
  for (const item of items ?? []) {
    const box = item.box;
    if (!box || ![box.x1, box.y1, box.x2, box.y2].every(Number.isFinite)) continue;
    const w = (box.x2 - box.x1) * scaleX;
    const h = (box.y2 - box.y1) * scaleY;
    const confidence = item.confidence ?? 1;
    if (w <= 0 || h <= 0 || !Number.isFinite(confidence)) continue;
    facts.push({
      text: item.text.trim(),
      bbox: { x: box.x1 * scaleX, y: box.y1 * scaleY, w, h },
      confidence,
    });
  }
  return facts;
}

function detectEdges(data: Buffer, width: number, height: number): Uint8Array {
  const edges = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      const gx =
        -(data[index - width - 1] ?? 0) + (data[index - width + 1] ?? 0)
        - 2 * (data[index - 1] ?? 0) + 2 * (data[index + 1] ?? 0)
        - (data[index + width - 1] ?? 0) + (data[index + width + 1] ?? 0);
      const gy =
        -(data[index - width - 1] ?? 0) - 2 * (data[index - width] ?? 0) - (data[index - width + 1] ?? 0)
        + (data[index + width - 1] ?? 0) + 2 * (data[index + width] ?? 0) + (data[index + width + 1] ?? 0);
      if (Math.sqrt(gx * gx + gy * gy) > EDGE_THRESHOLD) edges[index] = 1;
    }
  }
  return edges;
}

function textCoverage(candidate: Rect, facts: OcrFact[], minConfidence: number): number {
  const coveredArea = facts.reduce((total, fact) => {
    if (fact.confidence < minConfidence || fact.text.length === 0) return total;
    return total + intersectionArea(candidate, expand(fact.bbox, OCR_EDGE_MARGIN));
  }, 0);
  return coveredArea / area(candidate);
}

function isTextCovered(candidate: Rect, facts: OcrFact[]): boolean {
  const wide = candidate.w / candidate.h >= 1.7;
  const threshold = wide ? WIDE_OCR_VETO_COVERAGE : OCR_VETO_COVERAGE;
  return textCoverage(candidate, facts, OCR_VETO_CONFIDENCE) >= threshold;
}

function statusBarBottom(facts: OcrFact[], pageHeight: number): number {
  const times = facts.filter((fact) => (
    /^\d{1,2}:\d{2}$/.test(fact.text) && fact.bbox.y < pageHeight * 0.08
  ));
  if (times.length === 0) return 0;
  return Math.max(...times.map((fact) => fact.bbox.y + fact.bbox.h)) + pageHeight * 0.015;
}

function collectActiveCells(
  edges: Uint8Array,
  width: number,
  height: number,
  facts: OcrFact[],
  statusBottom: number,
): { active: Set<string>; columns: number; rows: number } {
  const columns = Math.ceil(width / BLOCK_SIZE);
  const rows = Math.ceil(height / BLOCK_SIZE);
  const active = new Set<string>();
  for (let row = 0; row < rows; row++) {
    const y0 = row * BLOCK_SIZE;
    const y1 = Math.min(height, y0 + BLOCK_SIZE);
    for (let column = 0; column < columns; column++) {
      const x0 = column * BLOCK_SIZE;
      const x1 = Math.min(width, x0 + BLOCK_SIZE);
      const candidate = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      if (candidate.y + candidate.h <= statusBottom) continue;
      let edgeCount = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) edgeCount += edges[y * width + x] ?? 0;
      }
      if (edgeCount / area(candidate) < MIN_EDGE_DENSITY) continue;
      if (isTextCovered(candidate, facts)) continue;
      active.add(`${column},${row}`);
    }
  }
  return { active, columns, rows };
}

function connectedCandidates(
  active: Set<string>,
  columns: number,
  rows: number,
  width: number,
  height: number,
  cellSize = BLOCK_SIZE,
): Rect[] {
  const pending = new Set(active);
  const candidates: Rect[] = [];
  for (const start of active) {
    if (!pending.delete(start)) continue;
    const queue = [start];
    let minColumn = Infinity;
    let minRow = Infinity;
    let maxColumn = -Infinity;
    let maxRow = -Infinity;
    while (queue.length > 0) {
      const current = queue.pop()!;
      const [column, row] = current.split(',').map(Number) as [number, number];
      minColumn = Math.min(minColumn, column);
      minRow = Math.min(minRow, row);
      maxColumn = Math.max(maxColumn, column);
      maxRow = Math.max(maxRow, row);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nextColumn = column + dx;
          const nextRow = row + dy;
          if (nextColumn < 0 || nextColumn >= columns || nextRow < 0 || nextRow >= rows) continue;
          const key = `${nextColumn},${nextRow}`;
          if (pending.delete(key)) queue.push(key);
        }
      }
    }
    const x = minColumn * cellSize;
    const y = minRow * cellSize;
    const x1 = Math.min(width, (maxColumn + 1) * cellSize);
    const y1 = Math.min(height, (maxRow + 1) * cellSize);
    candidates.push({ x, y, w: x1 - x, h: y1 - y });
  }
  return candidates;
}

function collectTextureCandidates(
  data: Buffer,
  edges: Uint8Array,
  width: number,
  height: number,
  statusBottom: number,
): CandidateSeed[] {
  const columns = Math.ceil(width / TEXTURE_BLOCK_SIZE);
  const rows = Math.ceil(height / TEXTURE_BLOCK_SIZE);
  const active = new Set<string>();
  for (let row = 0; row < rows; row++) {
    const y0 = row * TEXTURE_BLOCK_SIZE;
    const y1 = Math.min(height, y0 + TEXTURE_BLOCK_SIZE);
    if (y1 <= statusBottom) continue;
    for (let column = 0; column < columns; column++) {
      const x0 = column * TEXTURE_BLOCK_SIZE;
      const x1 = Math.min(width, x0 + TEXTURE_BLOCK_SIZE);
      let edgeCount = 0;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let valueSum = 0;
      let valueSquareSum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const value = data[y * width + x] ?? 0;
          valueSum += value;
          valueSquareSum += value * value;
          if ((edges[y * width + x] ?? 0) === 0) continue;
          edgeCount++;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      const cellArea = Math.max(1, (x1 - x0) * (y1 - y0));
      const mean = valueSum / cellArea;
      const deviation = Math.sqrt(Math.max(0, valueSquareSum / cellArea - mean * mean));
      const xSpan = edgeCount > 0 ? (maxX - minX + 1) / Math.max(1, x1 - x0) : 0;
      const ySpan = edgeCount > 0 ? (maxY - minY + 1) / Math.max(1, y1 - y0) : 0;
      if (
        edgeCount / cellArea >= MIN_TEXTURE_EDGE_DENSITY
        && deviation >= MIN_TEXTURE_DEVIATION
        && xSpan >= 0.5
        && ySpan >= 0.5
      ) {
        active.add(`${column},${row}`);
      }
    }
  }
  return connectedCandidates(active, columns, rows, width, height, TEXTURE_BLOCK_SIZE)
    .filter((bbox) => (
      bbox.w >= TEXTURE_BLOCK_SIZE * 2
      && bbox.h >= TEXTURE_BLOCK_SIZE * 2
      && Math.max(bbox.w, bbox.h) <= BLOCK_SIZE * 5
    ))
    .map((bbox) => ({ bbox, textured: true }));
}

function horizontalGap(a: Rect, b: Rect): number {
  const aRight = a.x + a.w;
  const bRight = b.x + b.w;
  if (aRight <= b.x) return b.x - aRight;
  if (bRight <= a.x) return a.x - bRight;
  return Infinity;
}

function collectOcrAnchoredCandidates(
  active: Set<string>,
  facts: OcrFact[],
  columns: number,
  rows: number,
  width: number,
  height: number,
): CandidateSeed[] {
  const medianHeight = median(facts
    .filter((fact) => fact.confidence >= 0.85 && fact.text.length >= 2)
    .map((fact) => fact.bbox.h));
  const maxGap = Math.max(BLOCK_SIZE, medianHeight * LABEL_GAP_HEIGHTS);
  const candidates: CandidateSeed[] = [];
  for (const fact of facts) {
    if (fact.text.length === 0) continue;
    const factCenterY = fact.bbox.y + fact.bbox.h / 2;
    const cells = new Set<string>();
    for (const key of active) {
      const [column, row] = key.split(',').map(Number) as [number, number];
      const cell = {
        x: column * BLOCK_SIZE,
        y: row * BLOCK_SIZE,
        w: Math.min(BLOCK_SIZE, width - column * BLOCK_SIZE),
        h: Math.min(BLOCK_SIZE, height - row * BLOCK_SIZE),
      };
      const verticalDistance = Math.abs(cell.y + cell.h / 2 - factCenterY);
      if (
        horizontalGap(cell, fact.bbox) <= maxGap
        && verticalDistance <= Math.max(BLOCK_SIZE, fact.bbox.h)
      ) {
        cells.add(key);
      }
    }
    for (const bbox of connectedCandidates(cells, columns, rows, width, height)) {
      if (Math.max(bbox.w, bbox.h) > BLOCK_SIZE * 3) continue;
      const anchorSide = bbox.x + bbox.w <= fact.bbox.x ? 'left' : 'right';
      if (anchorSide !== 'left') continue;
      candidates.push({
        bbox,
        nearbyText: fact.text,
        anchored: true,
      });
    }
  }
  return candidates.filter((candidate) => {
    const centerX = candidate.bbox.x + candidate.bbox.w / 2;
    const peers = candidates.filter((other) => (
      Math.abs(other.bbox.x + other.bbox.w / 2 - centerX) <= BLOCK_SIZE
    ));
    const rows = new Set(peers.map((peer) => Math.round((peer.bbox.y + peer.bbox.h / 2) / BLOCK_SIZE)));
    const labels = new Set(peers.map((peer) => peer.nearbyText));
    return rows.size >= 3 && labels.size >= 2;
  });
}

function intersectionOverUnion(a: Rect, b: Rect): number {
  const intersection = intersectionArea(a, b);
  const union = area(a) + area(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

function isSameScaleContained(a: Rect, b: Rect): boolean {
  const smallerArea = Math.min(area(a), area(b));
  const largerArea = Math.max(area(a), area(b));
  return smallerArea > 0
    && smallerArea / largerArea >= 0.2
    && intersectionArea(a, b) / smallerArea >= 0.8;
}

function dedupeSeeds(seeds: CandidateSeed[]): CandidateSeed[] {
  const sorted = [...seeds].sort((a, b) => (
    Number(b.anchored === true) - Number(a.anchored === true)
    || area(a.bbox) - area(b.bbox)
  ));
  const kept: CandidateSeed[] = [];
  for (const seed of sorted) {
    if (kept.some((candidate) => (
      intersectionOverUnion(seed.bbox, candidate.bbox) >= 0.8
      || isSameScaleContained(seed.bbox, candidate.bbox)
    ))) continue;
    kept.push(seed);
  }
  return kept;
}

function nearestLabel(candidate: Rect, facts: OcrFact[], medianHeight: number): OcrFact | undefined {
  const aligned = facts
    .filter((fact) => fact.text.length > 0 && verticalOverlapRatio(candidate, fact.bbox) >= 0.5)
    .map((fact) => {
      const candidateRight = candidate.x + candidate.w;
      const factRight = fact.bbox.x + fact.bbox.w;
      const gap = fact.bbox.x >= candidateRight
        ? fact.bbox.x - candidateRight
        : candidate.x >= factRight ? candidate.x - factRight : Infinity;
      return { fact, gap };
    })
    .filter(({ gap }) => gap <= medianHeight * LABEL_GAP_HEIGHTS)
    .sort((a, b) => a.gap - b.gap || b.fact.confidence - a.fact.confidence);
  return aligned[0]?.fact;
}

function filterAndRankCandidates(seeds: CandidateSeed[], facts: OcrFact[], width: number, height: number): Candidate[] {
  const medianHeight = median(facts
    .filter((fact) => fact.confidence >= 0.85 && fact.text.length >= 2)
    .map((fact) => fact.bbox.h));
  const candidates: Candidate[] = [];
  for (const seed of seeds) {
    const { bbox } = seed;
    const aspect = Math.max(bbox.w / bbox.h, bbox.h / bbox.w);
    const relativeArea = area(bbox) / Math.max(1, width * height);
    const largeTwoDimensional = bbox.h > bbox.w
      && Math.min(bbox.w, bbox.h) >= BLOCK_SIZE * 4
      && relativeArea >= 0.02;
    const coveredByText = seed.textured
      ? textCoverage(bbox, facts, TEXTURE_OCR_VETO_CONFIDENCE) >= TEXTURE_OCR_VETO_COVERAGE
      : isTextCovered(bbox, facts);
    if (!largeTwoDimensional && coveredByText) continue;
    if (aspect >= MAX_ASPECT_RATIO && !largeTwoDimensional) continue;
    const nearbyText = largeTwoDimensional
      ? undefined
      : seed.nearbyText ?? nearestLabel(bbox, facts, medianHeight)?.text;
    const compact = Math.max(bbox.w, bbox.h) <= Math.max(BLOCK_SIZE * 3, medianHeight * 2.4);
    if (!compact && !seed.textured && relativeArea < 0.02) continue;
    candidates.push({
      bbox,
      ...(nearbyText ? { nearbyText } : {}),
      score: (seed.anchored ? 6 : 0)
        + (seed.textured ? 5 : 0)
        + (compact ? 2 : 0)
        + (largeTwoDimensional ? 10 : 0)
        + Math.min(1, relativeArea * 10),
    });
  }
  return candidates.sort((a, b) => (
    b.score - a.score
    || a.bbox.y - b.bbox.y
    || a.bbox.x - b.bbox.x
  ));
}

/**
 * OCR-aware media detector for the UI-analysis boundary. Unlike the legacy
 * detector it scans all 20px work-grid cells, filters text/background strips,
 * and returns ranked candidates so the caller can cap after pixel filtering.
 */
export async function detectMediaAreasForAnalysis(
  image: ImageInput,
  ocrItems?: OcrItem[],
): Promise<MediaArea[]> {
  const metadata = await sharp(image.buffer).metadata();
  const originalWidth = metadata.width ?? 1;
  const originalHeight = metadata.height ?? 1;
  const { data, info } = await sharp(image.buffer)
    .resize(WORK_WIDTH, null, { fit: 'inside' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const scaleToWorkX = info.width / originalWidth;
  const scaleToWorkY = info.height / originalHeight;
  const facts = toOcrFacts(ocrItems, scaleToWorkX, scaleToWorkY);
  const edges = detectEdges(data, info.width, info.height);
  const cells = collectActiveCells(
    edges,
    info.width,
    info.height,
    facts,
    statusBarBottom(facts, info.height),
  );
  const globalSeeds = connectedCandidates(
    cells.active,
    cells.columns,
    cells.rows,
    info.width,
    info.height,
  ).map((bbox): CandidateSeed => ({ bbox }));
  const anchoredSeeds = collectOcrAnchoredCandidates(
    cells.active,
    facts,
    cells.columns,
    cells.rows,
    info.width,
    info.height,
  );
  const textureSeeds = collectTextureCandidates(
    data,
    edges,
    info.width,
    info.height,
    statusBarBottom(facts, info.height),
  );
  const candidates = filterAndRankCandidates(
    dedupeSeeds([...anchoredSeeds, ...textureSeeds, ...globalSeeds]),
    facts,
    info.width,
    info.height,
  );
  const toOriginalX = originalWidth / info.width;
  const toOriginalY = originalHeight / info.height;
  return candidates.map((candidate) => ({
    type: 'icon',
    bbox: {
      x: candidate.bbox.x * toOriginalX,
      y: candidate.bbox.y * toOriginalY,
      w: candidate.bbox.w * toOriginalX,
      h: candidate.bbox.h * toOriginalY,
    },
    nearbyText: candidate.nearbyText,
  }));
}
