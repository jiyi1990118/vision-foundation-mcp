/**
 * Chart Extractor - structured extraction for data charts and dashboards.
 *
 * Strategy (robust, OCR + algorithm driven, NOT VLM-trusted):
 * 1. Detect chart type (bar / line / pie / dashboard) from classify + OCR hints.
 * 2. Extract KPI / metric numbers via OCR (large standalone numbers).
 * 3. Extract axis labels / category labels via OCR (positioned near axes).
 * 4. For bar charts: estimate relative bar heights via column darkness scan
 *    (no per-pixel VLM needed - just count saturated pixels per column bin).
 * 5. Compose a structured summary from OCR + detected metrics.
 *
 * Why not VLM: chart screenshots cause VLM to invent data values; OCR reads
 * the actual rendered numbers reliably.
 */
import sharp from 'sharp';
import type { ImageInput } from '../../types/domain.js';
import type { OcrItem } from '../key-content-extractor.js';
import { extractOcrItems } from '../key-content-extractor.js';
import { logger } from '../../utils/logger.js';

export type ChartType = 'bar' | 'line' | 'pie' | 'dashboard' | 'table' | 'unknown';

export interface ChartMetric {
  label: string;
  value: string;
}

export interface ChartSeries {
  name: string;
  /** Relative magnitudes (0..1) per category, when estimable. */
  values?: number[];
}

export interface ChartExtraction {
  chartType: ChartType;
  title?: string;
  metrics: ChartMetric[];
  categories: string[];
  series: ChartSeries[];
  notes: string[];
  summary: string;
}

export interface ChartExtractionInput {
  image: ImageInput;
  category?: string;
  ocrData?: unknown;
  ocrItems?: OcrItem[];
}

/**
 * Extract structured chart data from an image + OCR.
 */
export async function extractChart(input: ChartExtractionInput): Promise<ChartExtraction> {
  const items = input.ocrItems ?? extractOcrItems(input.ocrData, 'full');
  const chartType = detectChartType(input.category, items);

  const metrics = extractMetrics(items);
  const categories = extractCategories(items, chartType);
  const title = extractTitle(items);
  const series: ChartSeries[] = [];
  const notes: string[] = [];

  // Bar charts: estimate relative bar heights via column saturation scan.
  if (chartType === 'bar') {
    const heights = await estimateBarHeights(input.image).catch((err) => {
      logger.warn('bar-height estimation failed', { error: String(err) });
      return [];
    });
    if (heights.length > 0) {
      series.push({ name: 'series', values: heights });
      notes.push(`检测到 ${heights.length} 个柱体（相对高度已估算）`);
    }
  }

  if (chartType === 'dashboard') {
    notes.push('检测到多个 KPI 卡片/指标面板');
  }

  const summary = composeChartSummary(chartType, title, metrics, categories, notes);

  return { chartType, ...(title ? { title } : {}), metrics, categories, series, notes, summary };
}

/**
 * Detect chart type from classify category + OCR keyword hints.
 */
export function detectChartType(category: string | undefined, items: OcrItem[]): ChartType {
  const text = items.map((i) => i.text).join(' ').toLowerCase();

  if (category === 'dashboard') return 'dashboard';
  if (category === 'table') return 'table';

  if (/柱状|柱形|bar chart|bar graph|\bbar\b/.test(text)) return 'bar';
  if (/折线|曲线|line chart|line graph|趋势线/.test(text)) return 'line';
  if (/饼图|扇形|pie chart|pie graph|占比|占比图/.test(text)) return 'pie';

  // Heuristic by category
  if (category === 'chart') {
    if (/%|百分比|占比/.test(text)) return 'pie';
    return 'bar';
  }

  return 'unknown';
}

/**
 * Extract KPI / metric numbers: standalone numeric tokens (with optional
 * unit / percent) that look like metric values, not coordinates.
 */
export function extractMetrics(items: OcrItem[]): ChartMetric[] {
  const metrics: ChartMetric[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const text = item.text.trim();
    // Match a label followed by a number, or a standalone large number with unit.
    // e.g. "GMV 1,234.56", "转化率 23.4%", "12,345", "¥9,876"
    const labelValueMatch = text.match(/^(.{1,12}?)\s*[:：]?\s*([¥￥$]?\s*[\d,]+\.?\d*\s*%?)$/);
    if (labelValueMatch) {
      const label = labelValueMatch[1]!.trim();
      const value = labelValueMatch[2]!.replace(/\s+/g, '').trim();
      if (label && value && !isCoordinateLike(value) && !seen.has(value)) {
        seen.add(value);
        metrics.push({ label, value });
        continue;
      }
    }
    // Standalone number with unit/percent (KPI card)
    const standalone = text.match(/^([¥￥$]?\s*[\d,]+\.?\d*\s*[%万亿kmb]?|[\d,]+\.?\d*\s*%)$/i);
    if (standalone && !isCoordinateLike(text) && !seen.has(text)) {
      seen.add(text);
      metrics.push({ label: '', value: text.trim() });
    }
  }

  return metrics;
}

/**
 * Extract category labels: short text near the bottom (x-axis) for bar/line,
 * or legend entries for pie.
 */
export function extractCategories(items: OcrItem[], chartType: ChartType): string[] {
  void chartType; // reserved for per-type category heuristics
  const boxed = items.filter((i): i is OcrItem & { box: { x1: number; y1: number; x2: number; y2: number } } => i.box !== undefined);
  if (boxed.length === 0) return [];

  const maxY = Math.max(...boxed.map((i) => i.box.y2));
  // Bottom 30% region = likely x-axis labels for bar/line.
  const axisRegion = boxed.filter((i) => i.box.y1 >= maxY * 0.7);
  const labels = (axisRegion.length > 0 ? axisRegion : boxed)
    .map((i) => i.text.trim())
    .filter((t) => t.length > 0 && t.length <= 12 && !/^\d+$/.test(t));

  // Dedupe preserving order
  return [...new Set(labels)];
}

/**
 * Extract a likely chart title: top-most short text line.
 */
export function extractTitle(items: OcrItem[]): string | undefined {
  const boxed = items.filter((i): i is OcrItem & { box: { x1: number; y1: number; x2: number; y2: number } } => i.box !== undefined);
  if (boxed.length === 0) return undefined;
  const minY = Math.min(...boxed.map((i) => i.box.y1));
  const top = boxed.filter((i) => i.box.y1 <= minY + 40);
  top.sort((a, b) => a.box.y1 - b.box.y1);
  return top[0]?.text.trim();
}

/**
 * Estimate relative bar heights by scanning vertical columns of saturated
 * (non-white, non-background) pixels.  Returns normalized heights (0..1).
 *
 * This is a lightweight algorithmic proxy - it does not read exact values
 * (that's OCR's job for axis labels), but gives relative magnitudes so the
 * caller can tell which bars are bigger.
 */
export async function estimateBarHeights(image: ImageInput, bins = 16): Promise<number[]> {
  const meta = await sharp(image.buffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width === 0 || height === 0) return [];

  // Downscale to reduce work; compute per-bin saturated-pixel count.
  const small = await sharp(image.buffer)
    .resize({ width: Math.min(width, 320), fit: 'inside' })
    .raw()
    .toBuffer();
  const smallWidth = Math.min(width, 320);
  const channels = meta.channels ?? 3;
  const smallHeight = Math.floor(small.length / (smallWidth * channels));

  // Look at the lower 60% of the image (chart body, skip title/legend).
  const bodyTop = Math.floor(smallHeight * 0.4);
  const bodyHeight = smallHeight - bodyTop;
  if (bodyHeight <= 0) return [];

  const binWidth = Math.max(1, Math.floor(smallWidth / bins));
  const heights: number[] = [];

  for (let b = 0; b < bins; b++) {
    const xStart = b * binWidth;
    const xEnd = Math.min(smallWidth, (b + 1) * binWidth);
    let saturatedPixels = 0;
    let totalPixels = 0;

    for (let y = bodyTop; y < smallHeight; y++) {
      for (let x = xStart; x < xEnd; x++) {
        const idx = (y * smallWidth + x) * channels;
        const r = small[idx] ?? 255;
        const g = small[idx + 1] ?? 255;
        const bl = small[idx + 2] ?? 255;
        // Saturated = colored (not near-white / near-black / near-gray).
        const maxC = Math.max(r, g, bl);
        const minC = Math.min(r, g, bl);
        const isColored = maxC - minC > 40;
        const isDark = maxC < 200;
        totalPixels++;
        if (isColored || isDark) saturatedPixels++;
      }
    }

    heights.push(totalPixels > 0 ? saturatedPixels / totalPixels : 0);
  }

  // Normalize to 0..1
  const maxH = Math.max(...heights, 0.0001);
  return heights.map((h) => h / maxH);
}

function composeChartSummary(
  chartType: ChartType,
  title: string | undefined,
  metrics: ChartMetric[],
  categories: string[],
  notes: string[],
): string {
  const typeLabel: Record<ChartType, string> = {
    bar: '柱状图', line: '折线图', pie: '饼图', dashboard: '数据看板', table: '数据表格', unknown: '图表',
  };
  const parts: string[] = [];
  parts.push(`【${typeLabel[chartType]}】`);
  if (title) parts.push(`标题：${title}；`);

  if (metrics.length > 0) {
    const metricText = metrics
      .map((m) => (m.label ? `${m.label}=${m.value}` : m.value))
      .join('，');
    parts.push(`指标：${metricText}；`);
  }
  if (categories.length > 0) {
    parts.push(`分类轴：${categories.slice(0, 10).join('、')}；`);
  }
  if (notes.length > 0) parts.push(notes.join('；'));

  return parts.join('');
}

function isCoordinateLike(text: string): boolean {
  // Reject pure coordinate-like strings: "10,20,100,200" (4+ comma numbers)
  const parts = text.split(/[,，]/);
  if (parts.length >= 4 && parts.every((p) => /^\d+$/.test(p.trim()))) return true;
  return false;
}
