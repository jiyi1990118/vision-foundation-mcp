import sharp from 'sharp';
import type { ImageInput } from '../types/domain.js';
import type { VisionProvider } from '../providers/types.js';
import type { TargetQuery } from './skill-pipeline.js';
import type { ImageAnnotations, ColoredBoxAnnotation } from './annotation-detector.js';
import { resolveColorName } from './annotation-detector.js';

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
    type: 'redBox' | 'coloredBox' | 'highlightBox' | 'layoutRegion';
    box: string;
    confidence: number;
    color?: string;
  };
  textLines: string[];
  table?: {
    columns: string[];
    rows: string[][];
  };
  fields?: Array<{ label: string; value: string }>;
  summary: string;
  warnings: string[];
  /** When multiple annotation boxes are detected, each gets its own extraction. */
  allExtractions?: Array<{
    matchedRegion: KeyContentExtraction['matchedRegion'];
    textLines: string[];
    table?: { columns: string[]; rows: string[][] };
    fields?: Array<{ label: string; value: string }>;
    summary: string;
  }>;
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
  type: 'redBox' | 'coloredBox' | 'highlightBox' | 'layoutRegion';
  box: string;
  confidence: number;
  color?: string;
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
  // Expanded keywords: Chinese + English, color-specific + generic annotation terms.
  if (/红框|蓝框|绿框|黄框|橙框|紫框|粉框|虚线框|框中|圈出|标注|高亮|关键内容|提取区域|目标区域|重点|标出|选中|标记|red box|blue box|green box|yellow box|marked|highlighted|annotat|circled|boxed|specified region|target[- ]?region|key content|extract\w*[^\n]{0,20}region|region[^\n]{0,20}extract\w*|pointed (?:out|to)|arrow/i.test(intent)) {
    return true;
  }

  const hasAnnotations = (input.annotations?.coloredBoxes?.length ?? input.annotations?.redBoxes.length ?? 0) > 0;
  const wantsContent = input.skillNames.includes('ocr') || input.skillNames.includes('summary');
  return hasAnnotations && wantsContent;
}

export async function extractKeyContent(input: KeyContentInput): Promise<KeyContentExtraction | undefined> {
  const fullItems = extractOcrItems(input.ocrData, 'full');
  const regions = resolveAllTargetRegions({
    target: input.target,
    intent: input.intent,
    annotations: input.annotations,
    ocrItems: fullItems,
  });

  // If no annotation boxes, fall back to layout-region resolution (single).
  if (regions.length === 0) {
    const region = resolveLayoutRegion(fullItems, input.target, input.intent);
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

  // Multi-box path: extract from every annotation box independently.
  const warnings: string[] = [];
  const allExtractions: KeyContentExtraction['allExtractions'] = [];

  for (const region of regions) {
    const parsedRegion = parseBox(region.box);
    if (!parsedRegion) continue;

    let localItems: OcrItem[] = [];
    if (input.ocrProvider) {
      try {
        localItems = await enhanceRegionOcr({ image: input.image, region: parsedRegion, provider: input.ocrProvider, signal: input.signal });
      } catch {
        warnings.push(`region OCR failed for ${region.color ?? ''} box; using full-image OCR only`);
      }
    }

    const merged = mergeOcrItems(itemsInsideRegion(fullItems, parsedRegion), itemsInsideRegion(localItems, parsedRegion));
    const perBox = buildStructuredContent(merged, region);
    allExtractions.push({
      matchedRegion: perBox.matchedRegion,
      textLines: perBox.textLines,
      ...(perBox.table ? { table: perBox.table } : {}),
      ...(perBox.fields && perBox.fields.length > 0 ? { fields: perBox.fields } : {}),
      summary: perBox.summary,
    });
  }

  if (allExtractions.length === 0) return undefined;

  // Primary extraction is the highest-ranked box; top-level fields mirror it
  // for backward compatibility.  allExtractions carries every box's data.
  const primary = allExtractions[0]!;
  return {
    matchedRegion: primary.matchedRegion,
    textLines: primary.textLines,
    ...(primary.table ? { table: primary.table } : {}),
    ...(primary.fields && primary.fields.length > 0 ? { fields: primary.fields } : {}),
    summary: composeMultiBoxSummary(allExtractions),
    warnings: uniqueStrings(warnings),
    query: input.target,
    allExtractions,
  };
}

/** Combine per-box summaries into a single multi-box summary string. */
function composeMultiBoxSummary(
  extractions: NonNullable<KeyContentExtraction['allExtractions']>,
): string {
  if (extractions.length === 1) return extractions[0]!.summary;

  const parts: string[] = [];
  for (const ext of extractions) {
    const colorLabel = ext.matchedRegion.color ? `${ext.matchedRegion.color}框` : '区域';
    const idx = parts.length + 1;
    parts.push(`【${colorLabel}${idx}】${ext.summary}`);
  }
  return parts.join('\n');
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

  // Only build a table if the content is genuinely tabular (column headers
  // with aligned data rows).  Form-like layouts (scattered labels, selectors,
  // checkboxes) produce garbage tables, so we detect and skip them.
  const table = isTabularContent(lines) ? buildTable(lines, warnings) : undefined;
  const fields = !table ? buildFields(lines) : undefined;

  return {
    matchedRegion: region,
    textLines,
    ...(table ? { table } : {}),
    ...(fields && fields.length > 0 ? { fields } : {}),
    summary: summarizeStructuredContent(textLines, table, fields),
    warnings: uniqueStrings(warnings),
  };
}

/**
 * Determine whether the OCR lines represent a genuine table (column headers
 * with aligned data rows) rather than a form-like layout (scattered labels,
 * selectors, checkboxes).
 *
 * Heuristics:
 * - First line must have ≥2 items (potential column headers).
 * - Header texts should be mostly unique (not "尺寸：" + "尺寸:").
 * - Data rows should fill ≥40% of columns (not mostly empty cells).
 * - At least 1 data row with content in ≥2 columns.
 */
function isTabularContent(lines: LineGroup[]): boolean {
  if (lines.length < 2) return false; // Need header + ≥1 data row

  const headerLine = lines[0];
  if (!headerLine || headerLine.items.length < 2) return false;

  // Header uniqueness: deduplicate by normalized text; if >50% are duplicates,
  // it's not a real table header.
  const headerTexts = headerLine.items.map((item) => normalizeComparableText(item.text));
  const uniqueHeaders = new Set(headerTexts.filter(Boolean));
  if (uniqueHeaders.size < headerTexts.length * 0.5) return false;

  // Check column fill ratio across data rows.
  const columnCenters = headerLine.items.map((item) => centerX(item.box));
  const dataLines = lines.slice(1);
  let rowsWithTwoColumns = 0;
  let totalFilledCells = 0;
  const totalCells = dataLines.length * columnCenters.length;

  for (const line of dataLines) {
    const filledColumns = new Set<number>();
    for (const item of line.items) {
      const colIdx = nearestIndex(columnCenters, centerX(item.box));
      filledColumns.add(colIdx);
    }
    if (filledColumns.size >= 2) rowsWithTwoColumns++;
    totalFilledCells += filledColumns.size;
  }

  // Need ≥1 row with content in ≥2 columns.
  if (rowsWithTwoColumns < 1) return false;

  // Overall fill ratio should be ≥40% (not mostly empty cells).
  if (totalCells > 0 && totalFilledCells / totalCells < 0.4) return false;

  return true;
}

/**
 * Build a list of label-value field pairs from OCR lines.  Used for form-like
 * layouts where table extraction doesn't apply.
 */
function buildFields(lines: LineGroup[]): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [];
  for (const line of lines) {
    const text = line.items.map((item) => item.text).join(' ').trim();
    if (!text) continue;
    // Detect "label：value" or "label: value" patterns.
    const match = text.match(/^([^：:]{1,20})[：:]\s*(.+)$/);
    if (match) {
      const value = match[2]!.trim();
      // Skip complex text lines where the value itself contains colons
      // (e.g. "变动配料：左：菠萝 右：黄桃") - these are not simple label-value
      // pairs but multi-clause sentences that read better as plain text.
      if (/[：:]/.test(value)) continue;
      fields.push({ label: match[1]!.trim(), value });
    }
  }
  return fields;
}

/**
 * Resolve ALL annotation boxes (ranked by score), not just the best one.
 * Used for multi-box key content extraction where every annotated region
 * should be extracted independently.
 */
export function resolveAllTargetRegions(input: ResolveTargetRegionInput): ResolvedTargetRegion[] {
  const requestedColor = resolveColorName(input.target?.color) ?? inferColorFromIntent(input.intent ?? '');
  const allBoxes = (input.annotations?.coloredBoxes ?? input.annotations?.redBoxes ?? [])
    .map((b) => ({ ...b, color: b.color ?? 'red' }));

  const candidates = requestedColor
    ? allBoxes.filter((b) => b.color === requestedColor)
    : allBoxes;

  return rankAnnotationBoxes(candidates, input.target?.position);
}

export function resolveTargetRegion(input: ResolveTargetRegionInput): ResolvedTargetRegion | undefined {
  const regions = resolveAllTargetRegions(input);
  if (regions.length > 0) return regions[0];
  return resolveLayoutRegion(input.ocrItems, input.target, input.intent);
}

/** Extract a color name from intent keywords like "红框", "蓝框", "blue box". */
function inferColorFromIntent(intent: string): string | undefined {
  const lower = intent.toLowerCase();
  // Check each color's aliases against the intent.
  const colorPatterns: Array<{ name: string; pattern: RegExp }> = [
    { name: 'red', pattern: /红框|红色框|红\s*色|red\s*box|red\s*annot/i },
    { name: 'blue', pattern: /蓝框|蓝色框|蓝\s*色|blue\s*box|blue\s*annot/i },
    { name: 'green', pattern: /绿框|绿色框|绿\s*色|green\s*box|green\s*annot/i },
    { name: 'yellow', pattern: /黄框|黄色框|黄\s*色|橙框|橙色框|yellow\s*box|orange\s*box/i },
    { name: 'magenta', pattern: /紫框|紫色框|粉框|粉色框|紫\s*色|粉\s*色|purple\s*box|pink\s*box|magenta\s*box/i },
  ];
  for (const { name, pattern } of colorPatterns) {
    if (pattern.test(lower)) return name;
  }
  return undefined;
}

export function rankAnnotationBoxes(
  boxes: ColoredBoxAnnotation[],
  position: string | undefined,
): ResolvedTargetRegion[] {
  return boxes
    .map((box) => ({ raw: box, parsed: parseBox(box.box) }))
    .filter((item): item is { raw: ColoredBoxAnnotation; parsed: Box } => item.parsed !== undefined)
    .map((item) => ({
      type: (item.raw.color === 'red' ? 'redBox' : 'coloredBox') as 'redBox' | 'coloredBox',
      box: item.raw.box,
      confidence: item.raw.confidence,
      color: item.raw.color,
      score: item.raw.confidence + scorePosition(item.parsed, position),
    }))
    .sort((a, b) => b.score - a.score)
    .map(({ type, box, confidence, color }) => ({ type, box, confidence, color }));
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

function summarizeStructuredContent(
  textLines: string[],
  table: { columns: string[]; rows: string[][] } | undefined,
  fields?: Array<{ label: string; value: string }> | undefined,
): string {
  if (table) {
    return `关键区域包含表格：${table.columns.join('、')}，共 ${table.rows.length} 行。`;
  }
  if (fields && fields.length > 0) {
    return `关键区域包含字段：${fields.map((f) => `${f.label}=${f.value}`).join('，')}。`;
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
