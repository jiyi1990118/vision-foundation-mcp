import sharp from 'sharp';
import type { ImageInput } from '../types/domain.js';
import type { VisionProvider } from '../providers/types.js';
import type { TargetQuery } from './skill-pipeline.js';
import type { ImageAnnotations } from './annotation-detector.js';

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface OcrItem {
  text: string;
  box?: Box;
  confidence?: number;
  source?: 'full' | 'local';
}

export interface KeyContentExtraction {
  query?: TargetQuery | undefined;
  matchedRegion: {
    type: 'redBox' | 'highlightBox' | 'layoutRegion';
    box: string;
    confidence: number;
  };
  textLines: string[];
  table?: {
    columns: string[];
    rows: string[][];
  };
  fields?: Array<{ label: string; value: string }>;
  summary: string;
  warnings: string[];
}

export interface KeyContentInput {
  image: ImageInput;
  target?: TargetQuery | undefined;
  intent?: string | undefined;
  annotations?: ImageAnnotations | undefined;
  ocrData?: unknown;
  ocrProvider?: VisionProvider | undefined;
  signal?: AbortSignal | undefined;
}

export interface KeyContentActivationInput {
  target?: TargetQuery | undefined;
  intent?: string | undefined;
  annotations?: ImageAnnotations | undefined;
  skillNames: string[];
}

export interface ResolvedTargetRegion {
  type: 'redBox' | 'highlightBox' | 'layoutRegion';
  box: string;
  confidence: number;
}

export interface ResolveTargetRegionInput {
  target?: TargetQuery | undefined;
  intent?: string | undefined;
  annotations?: ImageAnnotations | undefined;
  ocrItems: OcrItem[];
}

export interface EnhanceRegionOcrInput {
  image: ImageInput;
  region: Box;
  provider: VisionProvider;
  scale?: number;
  signal?: AbortSignal | undefined;
}

interface LineGroup {
  y: number;
  items: Array<OcrItem & { box: Box }>;
}

export function shouldExtractKeyContent(input: KeyContentActivationInput): boolean {
  if (input.target) return true;

  const intent = input.intent ?? '';
  if (/红框|虚线框|框中|圈出|标注|高亮|关键内容|提取区域|目标区域|red box|marked|highlighted|annotat|circled|boxed|specified region|target[- ]?region|extract\w*[^\n]{0,20}region|region[^\n]{0,20}extract\w*/i.test(intent)) {
    return true;
  }

  const hasAnnotations = (input.annotations?.redBoxes.length ?? 0) > 0;
  const wantsContent = input.skillNames.includes('ocr') || input.skillNames.includes('summary');
  return hasAnnotations && wantsContent;
}

export async function extractKeyContent(input: KeyContentInput): Promise<KeyContentExtraction | undefined> {
  const fullItems = extractOcrItems(input.ocrData, 'full');
  const region = resolveTargetRegion({
    target: input.target,
    intent: input.intent,
    annotations: input.annotations,
    ocrItems: fullItems,
  });
  if (!region) return undefined;

  const parsedRegion = parseBox(region.box);
  if (!parsedRegion) return undefined;

  const warnings: string[] = [];
  let localItems: OcrItem[] = [];
  if (input.ocrProvider) {
    try {
      localItems = await enhanceRegionOcr({ image: input.image, region: parsedRegion, provider: input.ocrProvider, signal: input.signal });
    } catch {
      warnings.push('region OCR failed; using full-image OCR only');
    }
  }

  const merged = mergeOcrItems(itemsInsideRegion(fullItems, parsedRegion), itemsInsideRegion(localItems, parsedRegion));
  const extraction = buildStructuredContent(merged, region);
  return {
    ...extraction,
    query: input.target,
    warnings: uniqueStrings([...warnings, ...extraction.warnings]),
  };
}

function mergeOcrItems(fullItems: OcrItem[], localItems: OcrItem[]): OcrItem[] {
  const merged = [...fullItems];
  for (const local of localItems) {
    const localBox = local.box;
    if (!localBox) {
      merged.push(local);
      continue;
    }

    const duplicateIndex = merged.findIndex((item) => item.box && overlapRatio(item.box, localBox) >= 0.6 && item.text === local.text);
    if (duplicateIndex >= 0) {
      merged[duplicateIndex] = local;
    } else {
      merged.push(local);
    }
  }
  return merged;
}

export function buildStructuredContent(items: OcrItem[], region: ResolvedTargetRegion): KeyContentExtraction {
  const boxed = items.filter((item): item is OcrItem & { box: Box } => item.box !== undefined);
  const warnings: string[] = [];
  const lines = groupLines(boxed);
  const textLines = lines.map((line) => normalizeLineText(line.items, warnings)).filter(Boolean);
  const table = buildTable(lines, warnings);

  return {
    matchedRegion: region,
    textLines,
    ...(table ? { table } : {}),
    summary: summarizeStructuredContent(textLines, table),
    warnings: uniqueStrings(warnings),
  };
}

export function resolveTargetRegion(input: ResolveTargetRegionInput): ResolvedTargetRegion | undefined {
  const explicitColor = input.target?.color?.toLowerCase();
  if (explicitColor && explicitColor !== 'red' && explicitColor !== '红色') {
    return undefined;
  }

  const redBoxes = input.annotations?.redBoxes ?? [];
  if (redBoxes.length > 0) {
    return rankRedAnnotationBoxes(redBoxes, input.target?.position)[0];
  }

  return resolveLayoutRegion(input.ocrItems, input.target, input.intent);
}

export function rankRedAnnotationBoxes(
  redBoxes: NonNullable<ImageAnnotations['redBoxes']>,
  position: string | undefined,
): ResolvedTargetRegion[] {
  return redBoxes
    .map((box) => ({ raw: box, parsed: parseBox(box.box) }))
    .filter((item): item is { raw: typeof redBoxes[number]; parsed: Box } => item.parsed !== undefined)
    .map((item) => ({
      type: 'redBox' as const,
      box: item.raw.box,
      confidence: item.raw.confidence,
      score: item.raw.confidence + scorePosition(item.parsed, position),
    }))
    .sort((a, b) => b.score - a.score)
    .map(({ type, box, confidence }) => ({ type, box, confidence }));
}

export function resolveLayoutRegion(
  items: OcrItem[],
  target: TargetQuery | undefined,
  intent: string | undefined,
): ResolvedTargetRegion | undefined {
  const boxed = items.filter((item): item is OcrItem & { box: Box } => item.box !== undefined);
  if (boxed.length === 0) return undefined;

  const text = `${target?.position ?? ''} ${target?.description ?? ''} ${intent ?? ''}`;
  let selected = boxed;
  if (/right|右/.test(text)) {
    const midpoint = median(boxed.map((item) => centerX(item.box)));
    selected = boxed.filter((item) => centerX(item.box) >= midpoint);
  } else if (/left|左/.test(text)) {
    const midpoint = median(boxed.map((item) => centerX(item.box)));
    selected = boxed.filter((item) => centerX(item.box) <= midpoint);
  }

  if (/价格|金额|价|price|amount/i.test(text)) {
    const priceItems = selected.filter((item) => /价格|金额|价|¥|￥|\d+(?:\.\d+)?/.test(item.text));
    if (priceItems.length > 0) selected = priceItems;
  }

  if (selected.length === 0) return undefined;
  return { type: 'layoutRegion', box: formatBox(unionBoxes(selected.map((item) => item.box))), confidence: 0.55 };
}

export function extractOcrItems(data: unknown, source: OcrItem['source'] = 'full'): OcrItem[] {
  const rawItems = findOcrItemArray(data);
  if (!rawItems) return [];

  return rawItems
    .map((item): OcrItem | undefined => {
      if (typeof item === 'string') {
        const text = item.trim();
        return text.length > 0 ? { text, source } : undefined;
      }

      if (typeof item !== 'object' || item === null) return undefined;
      const text = (item as { text?: unknown }).text;
      if (typeof text !== 'string' || text.trim().length === 0) return undefined;

      const box = extractBox(item);
      if (!box) return { text: text.trim(), source };

      const confidence = Number((item as { confidence?: unknown }).confidence);
      return {
        text: text.trim(),
        box,
        ...(Number.isFinite(confidence) ? { confidence } : {}),
        source,
      };
    })
    .filter((item): item is OcrItem => item !== undefined);
}

export function itemsInsideRegion(items: OcrItem[], region: Box): OcrItem[] {
  return items.filter((item): item is OcrItem & { box: Box } => {
    if (!item.box) return false;
    return isBoxCenterInside(item.box, expandBox(region, 4)) || overlapRatio(item.box, region) >= 0.35;
  });
}

export async function enhanceRegionOcr(input: EnhanceRegionOcrInput): Promise<OcrItem[]> {
  const scale = input.scale ?? 4;
  const metadata = await sharp(input.image.buffer).metadata();
  const imageWidth = metadata.width ?? input.region.x2;
  const imageHeight = metadata.height ?? input.region.y2;
  const crop = clampBox(shrinkBox(input.region, 2), imageWidth, imageHeight);
  if (crop.x2 <= crop.x1 || crop.y2 <= crop.y1) return [];

  const cropBuffer = await sharp(input.image.buffer)
    .extract({ left: crop.x1, top: crop.y1, width: crop.x2 - crop.x1, height: crop.y2 - crop.y1 })
    .resize({ width: (crop.x2 - crop.x1) * scale, height: (crop.y2 - crop.y1) * scale, kernel: 'lanczos3' })
    .grayscale()
    .normalize()
    .png()
    .toBuffer();

  if (!input.provider.isLoaded()) {
    await input.provider.load();
  }

  const response = await input.provider.infer({
    image: { buffer: cropBuffer, mimeType: 'image/png', source: `${input.image.source}:region`, size: cropBuffer.length },
    prompt: '',
    maxTokens: 512,
    temperature: 0,
    cache: false,
    signal: input.signal,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    return [];
  }

  return extractOcrItems(parsed, 'local').map((item) => ({
    ...item,
    ...(item.box ? { box: mapLocalBoxToImage(item.box, crop, scale) } : {}),
  }));
}

function groupLines(items: Array<OcrItem & { box: Box }>): LineGroup[] {
  const sorted = [...items].sort((a, b) => centerY(a.box) - centerY(b.box) || centerX(a.box) - centerX(b.box));
  const medianHeight = median(sorted.map((item) => item.box.y2 - item.box.y1)) || 20;
  const tolerance = Math.max(10, medianHeight * 0.6);
  const lines: LineGroup[] = [];

  for (const item of sorted) {
    const y = centerY(item.box);
    const line = lines.find((candidate) => Math.abs(candidate.y - y) <= tolerance);
    if (line) {
      line.items.push(item);
      line.y = (line.y * (line.items.length - 1) + y) / line.items.length;
    } else {
      lines.push({ y, items: [item] });
    }
  }

  return lines.map((line) => ({
    y: line.y,
    items: [...line.items].sort((a, b) => centerX(a.box) - centerX(b.box)),
  }));
}

function normalizeLineText(items: Array<OcrItem & { box: Box }>, warnings: string[]): string {
  const merged: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (merged.some((text) => isNearDuplicateText(text, item.text))) continue;

    const next = items[i + 1];
    if (isNumericAmount(item.text) && next && isCurrencyCandidate(next.text) && isSameMoneyCell(item.box, next.box)) {
      if (next.text === '夫') warnings.push('局部 OCR 将金额符号候选“夫”按金额上下文归一化为“¥”');
      merged.push(`${item.text} ¥`);
      i++;
      continue;
    }
    merged.push(normalizeUnitText(item.text));
  }
  return merged.join(' ').trim();
}

function isNearDuplicateText(a: string, b: string): boolean {
  const left = normalizeComparableText(a);
  const right = normalizeComparableText(b);
  if (!left || !right) return false;
  if (left === right) return true;

  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return shorter.length >= 8 && longer.includes(shorter);
}

function normalizeComparableText(text: string): string {
  return text
    .replace(/[\s,，。.;；:："'“”‘’/\\|\-—_、]/g, '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .trim();
}

function buildTable(lines: LineGroup[], warnings: string[]): { columns: string[]; rows: string[][] } | undefined {
  if (lines.length < 2) return undefined;

  const firstHeader = lines[0]?.items ?? [];
  if (firstHeader.length < 2) return undefined;

  const columns = firstHeader.map((item) => item.text);
  const secondLine = lines[1];
  const hasWrappedUnitLine = secondLine !== undefined && isWrappedUnitLine(secondLine.items);
  const unitLine = hasWrappedUnitLine ? secondLine.items : [];
  for (let i = 0; i < columns.length; i++) {
    const header = firstHeader[i]!;
    const unit = nearestItem(unitLine, centerX(header.box));
    if (unit && /^[(（]元[)）]$/.test(unit.text)) {
      columns[i] = `${columns[i]}${normalizeUnitText(unit.text)}`;
    }
  }

  const dataLines = lines.slice(hasWrappedUnitLine ? 2 : 1);
  const columnCenters = firstHeader.map((item) => centerX(item.box));
  const rows = dataLines
    .map((line) => normalizeTableCells(line.items, columnCenters, warnings))
    .filter((row) => row.length === columns.length && row.some((cell) => cell.length > 0));

  return columns.length >= 2 && rows.length > 0 ? { columns, rows } : undefined;
}

function isWrappedUnitLine(items: Array<OcrItem & { box: Box }>): boolean {
  return items.length > 0 && items.every((item) => /^[(（]元[)）]$/.test(item.text));
}

function normalizeTableCells(items: Array<OcrItem & { box: Box }>, columnCenters: number[], warnings: string[]): string[] {
  const cellItems = columnCenters.map((): Array<OcrItem & { box: Box }> => []);

  for (const item of items) {
    cellItems[nearestIndex(columnCenters, centerX(item.box))]!.push(item);
  }

  return cellItems.map((cell) => normalizeTableCell(cell, warnings));
}

function normalizeTableCell(items: Array<OcrItem & { box: Box }>, warnings: string[]): string {
  const firstAmount = items.find((item) => isNumericAmount(item.text));
  const currency = items.find((item) => isCurrencyCandidate(item.text));
  if (firstAmount && currency) {
    if (currency.text === '夫') warnings.push('局部 OCR 将金额符号候选“夫”按金额上下文归一化为“¥”');
    return `${firstAmount.text} ¥`;
  }

  const parts: string[] = [];
  const used = new Set<number>();

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const item = items[i]!;

    let value = normalizeUnitText(item.text);
    if (isNumericAmount(item.text)) {
      const symbolIndex = items.findIndex((candidate, index) => (
        index !== i
        && !used.has(index)
        && isCurrencyCandidate(candidate.text)
        && isSameMoneyCell(item.box, candidate.box)
      ));
      if (symbolIndex >= 0) {
        if (items[symbolIndex]!.text === '夫') warnings.push('局部 OCR 将金额符号候选“夫”按金额上下文归一化为“¥”');
        value = `${value} ¥`;
        used.add(symbolIndex);
      }
    }

    used.add(i);
    if (isNumericAmount(item.text) && parts.some((part) => part === value || part.startsWith(`${value} `))) continue;
    parts.push(value);
  }

  return parts.join(' ');
}

function isNumericAmount(text: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(text);
}

function isCurrencyCandidate(text: string): boolean {
  return text === '¥' || text === '￥' || text === '夫';
}

function isSameMoneyCell(amount: Box, symbol: Box): boolean {
  const amountWidth = amount.x2 - amount.x1;
  const maxGap = Math.max(8, amountWidth * 0.7, Math.max(amount.y2 - amount.y1, symbol.y2 - symbol.y1));
  return Math.abs(centerY(amount) - centerY(symbol)) <= Math.max(amount.y2 - amount.y1, symbol.y2 - symbol.y1) * 0.7
    && symbol.x1 >= amount.x1
    && symbol.x1 - amount.x2 <= maxGap;
}

function normalizeUnitText(text: string): string {
  if (/^[(（]元[)）]$/.test(text)) return '（元）';
  return text;
}

function nearestItem<T extends { box: Box }>(items: T[], x: number): T | undefined {
  return [...items].sort((a, b) => Math.abs(centerX(a.box) - x) - Math.abs(centerX(b.box) - x))[0];
}

function nearestIndex(values: number[], value: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < values.length; i++) {
    const distance = Math.abs(values[i]! - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function summarizeStructuredContent(textLines: string[], table: { columns: string[]; rows: string[][] } | undefined): string {
  if (table) {
    return `关键区域包含表格：${table.columns.join('、')}，共 ${table.rows.length} 行。`;
  }
  return textLines.length > 0 ? `关键区域包含：${textLines.join('；')}。` : '关键区域未识别到明确文本。';
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function mapLocalBoxToImage(box: Box, crop: Box, scale: number): Box {
  return {
    x1: Math.round(crop.x1 + box.x1 / scale),
    y1: Math.round(crop.y1 + box.y1 / scale),
    x2: Math.round(crop.x1 + box.x2 / scale),
    y2: Math.round(crop.y1 + box.y2 / scale),
  };
}

function shrinkBox(box: Box, amount: number): Box {
  return { x1: box.x1 + amount, y1: box.y1 + amount, x2: box.x2 - amount, y2: box.y2 - amount };
}

function clampBox(box: Box, width: number, height: number): Box {
  return {
    x1: Math.max(0, Math.min(width, Math.round(box.x1))),
    y1: Math.max(0, Math.min(height, Math.round(box.y1))),
    x2: Math.max(0, Math.min(width, Math.round(box.x2))),
    y2: Math.max(0, Math.min(height, Math.round(box.y2))),
  };
}

export function parseBox(position: string): Box | undefined {
  const parts = position.split(',').map((value) => Number(value.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return undefined;
  const [x1, y1, x2, y2] = parts as [number, number, number, number];
  return { x1, y1, x2, y2 };
}

export function formatBox(box: Box): string {
  return `${Math.round(box.x1)},${Math.round(box.y1)},${Math.round(box.x2)},${Math.round(box.y2)}`;
}

function findOcrItemArray(data: unknown): unknown[] | undefined {
  if (Array.isArray(data)) return data;
  if (typeof data !== 'object' || data === null) return undefined;

  const record = data as Record<string, unknown>;
  if (Array.isArray(record.texts)) return record.texts;
  if (Array.isArray(record.items)) return record.items;
  return findOcrItemArray(record.ocr);
}

function extractBox(item: object): Box | undefined {
  const record = item as Record<string, unknown>;
  if (isBox(record.box)) return record.box;
  if (typeof record.position === 'string') return parseBox(record.position);
  return boxFromUnknown(record.boundingBox) ?? boxFromUnknown(record.bbox);
}

function boxFromUnknown(value: unknown): Box | undefined {
  if (isBox(value)) return value;

  if (Array.isArray(value) && value.length === 4) {
    const [x1, y1, x2, y2] = value.map(Number) as [number, number, number, number];
    if ([x1, y1, x2, y2].every(Number.isFinite)) return { x1, y1, x2, y2 };
  }

  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const x = Number(record.x);
    const y = Number(record.y);
    const width = Number(record.width);
    const height = Number(record.height);
    if ([x, y, width, height].every(Number.isFinite)) return { x1: x, y1: y, x2: x + width, y2: y + height };
  }

  return undefined;
}

function isBox(value: unknown): value is Box {
  if (typeof value !== 'object' || value === null) return false;
  const box = value as Box;
  return [box.x1, box.y1, box.x2, box.y2].every(Number.isFinite);
}

function scorePosition(box: Box, position: string | undefined): number {
  if (!position) return 0;
  let score = 0;
  if (/right|右/.test(position)) score += centerX(box) / 10_000;
  if (/left|左/.test(position)) score -= centerX(box) / 10_000;
  if (/bottom|下/.test(position)) score += centerY(box) / 10_000;
  if (/top|上/.test(position)) score -= centerY(box) / 10_000;
  return score;
}

function unionBoxes(boxes: Box[]): Box {
  return {
    x1: Math.min(...boxes.map((box) => box.x1)),
    y1: Math.min(...boxes.map((box) => box.y1)),
    x2: Math.max(...boxes.map((box) => box.x2)),
    y2: Math.max(...boxes.map((box) => box.y2)),
  };
}

function isBoxCenterInside(inner: Box, outer: Box): boolean {
  const cx = centerX(inner);
  const cy = centerY(inner);
  return cx >= outer.x1 && cx <= outer.x2 && cy >= outer.y1 && cy <= outer.y2;
}

function overlapRatio(a: Box, b: Box): number {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  if (x2 <= x1 || y2 <= y1) return 0;
  return ((x2 - x1) * (y2 - y1)) / boxArea(a);
}

function boxArea(box: Box): number {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}

function expandBox(box: Box, amount: number): Box {
  return { x1: box.x1 - amount, y1: box.y1 - amount, x2: box.x2 + amount, y2: box.y2 + amount };
}

function centerX(box: Box): number {
  return (box.x1 + box.x2) / 2;
}

function centerY(box: Box): number {
  return (box.y1 + box.y2) / 2;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
