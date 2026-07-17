/**
 * Code Extractor - clean code text extraction from code/terminal screenshots.
 *
 * Strategy (robust, OCR + spatial reconstruction, NOT VLM-trusted):
 * 1. Group OCR items into code lines by y-band (monospace rows are tight).
 * 2. Sort each line's tokens by x-position to reconstruct line order.
 * 3. Estimate indentation from the leading x-offset of each line (monospace
 *    columns -> indent level).
 * 4. Detect language hints from keywords (function/def/import/const/...).
 * 5. Strip OCR noise (line numbers if present, status-bar fragments).
 *
 * Why not VLM: code screenshots cause VLM to paraphrase / drop indentation;
 * OCR + spatial reconstruction preserves the actual tokens and layout.
 */
import type { OcrItem, Box } from '../key-content-extractor.js';
import { extractOcrItems } from '../key-content-extractor.js';

export type CodeLanguage = 'javascript' | 'typescript' | 'python' | 'java' | 'go' | 'rust' | 'shell' | 'cpp' | 'sql' | 'unknown';

export interface CodeExtraction {
  language: CodeLanguage;
  lines: string[];
  lineCount: number;
  /** Detected leading-line numbers (if the screenshot shows a gutter). */
  hasLineNumbers: boolean;
  summary: string;
}

export interface CodeExtractionInput {
  ocrData?: unknown;
  ocrItems?: OcrItem[];
  intent?: string;
}

/**
 * Extract code text from OCR of a code/terminal screenshot.
 */
export function extractCode(input: CodeExtractionInput): CodeExtraction {
  const items = input.ocrItems ?? extractOcrItems(input.ocrData, 'full');
  const lines = reconstructLines(items);
  const hasLineNumbers = detectLineNumbers(lines);
  const cleanLines = hasLineNumbers ? stripLineNumbers(lines) : lines;
  const language = detectLanguage(cleanLines, input.intent ?? '');

  const summary = composeCodeSummary(language, cleanLines);

  return {
    language,
    lines: cleanLines,
    lineCount: cleanLines.length,
    hasLineNumbers,
    summary,
  };
}

/**
 * Reconstruct code lines: group OCR tokens by y-band, sort by x, join.
 * Estimates indentation from the minimum x-offset across all lines.
 */
export function reconstructLines(items: OcrItem[]): string[] {
  const boxed = items.filter((i): i is OcrItem & { box: Box } => i.box !== undefined);
  if (boxed.length === 0) {
    // No boxes - fall back to raw text, one per line.
    return items.map((i) => i.text);
  }

  const sorted = [...boxed].sort((a, b) => a.box.y1 - b.box.y1 || a.box.x1 - b.box.x1);
  const rows: OcrItem[][] = [];
  let currentRow: OcrItem[] = [];

  for (const item of sorted) {
    if (currentRow.length === 0) {
      currentRow.push(item);
      continue;
    }
    const lastItem = currentRow[currentRow.length - 1]!;
    const lastBox = lastItem.box;
    if (!lastBox || !item.box) {
      currentRow.push(item);
      continue;
    }
    const lastY = (lastBox.y1 + lastBox.y2) / 2;
    const thisY = (item.box.y1 + item.box.y2) / 2;
    const rowHeight = Math.max(lastBox.y2 - lastBox.y1, item.box.y2 - item.box.y1);
    const tol = Math.max(4, rowHeight * 0.5);
    if (Math.abs(lastY - thisY) <= tol) {
      currentRow.push(item);
    } else {
      rows.push(currentRow);
      currentRow = [item];
    }
  }
  if (currentRow.length > 0) rows.push(currentRow);

  // Only rows where tokens have boxes are usable for spatial reconstruction.
  const rowsWithBoxes = rows.map((row) => row.filter((i): i is OcrItem & { box: Box } => i.box !== undefined)).filter((r) => r.length > 0);
  if (rowsWithBoxes.length === 0) {
    // Fallback: join all text tokens in order.
    return rows.flat().map((i) => i.text);
  }

  // For each row, sort tokens by x and join with single spaces.  Then estimate
  // indentation: the first token's x1 relative to the global min x1 maps to
  // indent levels (assume ~4-space columns for monospace).
  const minX1 = Math.min(...rowsWithBoxes.flat().map((i) => i.box.x1));
  const approxCharWidth = estimateCharWidth(rowsWithBoxes);

  const lines = rowsWithBoxes.map((row) => {
    const rowSorted = [...row].sort((a, b) => a.box.x1 - b.box.x1);
    const firstX = rowSorted[0]!.box.x1;
    const indentSpaces = Math.max(0, Math.round((firstX - minX1) / Math.max(2, approxCharWidth)));
    const text = rowSorted.map((i) => i.text).join(' ').replace(/\s+/g, ' ').trim();
    return `${' '.repeat(indentSpaces)}${text}`;
  });

  return lines;
}

/**
 * Detect whether the screenshot shows a line-number gutter.
 */
export function detectLineNumbers(lines: string[]): boolean {
  // If most lines start with a number followed by whitespace, it's a gutter.
  if (lines.length < 3) return false;
  const numbered = lines.filter((l) => /^\s*\d{1,4}\s+\S/.test(l));
  return numbered.length >= lines.length * 0.6;
}

/**
 * Strip leading line numbers from each line.
 */
export function stripLineNumbers(lines: string[]): string[] {
  return lines.map((l) => l.replace(/^\s*\d{1,4}\s+/, ''));
}

/**
 * Detect the programming language from token keywords.
 */
export function detectLanguage(lines: string[], intent: string): CodeLanguage {
  const text = `${intent} ${lines.join(' ')}`.toLowerCase();

  if (/\bdef\s+\w+\s*\(|import\s+\w+\s+as\b|\bprint\s*\(|\bself\b|\belif\b/.test(text)) return 'python';
  if (/\bfunc\s+\w+|go\s+func\b|\bpackage\s+main\b/.test(text)) return 'go';
  if (/\bfn\s+\w+|\bimpl\b|\bmut\b|\blet\s+mut\b/.test(text)) return 'rust';
  if (/\bpublic\s+(?:static\s+)?(?:class|void)\b|\bSystem\.out\b|\bimport\s+java\b/.test(text)) return 'java';
  if (/\bSELECT\b.*\bFROM\b/i.test(text) || /\bINSERT\s+INTO\b/i.test(text)) return 'sql';
  if (/\bconst\s+\w+\s*=|\brequire\s*\(|module\.exports|console\.log/.test(text)) return 'javascript';
  if (/\binterface\s+\w+|\btype\s+\w+\s*=|:\s*(string|number|boolean)\b/.test(text)) return 'typescript';
  if (/#include|std::|int\s+main\s*\(/.test(text)) return 'cpp';
  if (/^\s*#!\/|bash\s+-c|export\s+PATH/.test(text)) return 'shell';
  return 'unknown';
}

function composeCodeSummary(language: CodeLanguage, lines: string[]): string {
  const langLabel: Record<CodeLanguage, string> = {
    javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', java: 'Java',
    go: 'Go', rust: 'Rust', shell: 'Shell', cpp: 'C++', sql: 'SQL', unknown: '未知语言',
  };
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  return `【代码截图】语言：${langLabel[language]}，共 ${nonEmpty.length} 行非空代码。`;
}

function estimateCharWidth(rows: OcrItem[][]): number {
  // Average token width / char count as a proxy for monospace char width.
  const tokens = rows.flat().filter((t): t is OcrItem & { box: Box } => t.box !== undefined);
  if (tokens.length === 0) return 8;
  const widths = tokens.map((t) => (t.box.x2 - t.box.x1) / Math.max(1, t.text.length));
  widths.sort((a, b) => a - b);
  return widths[Math.floor(widths.length / 2)] ?? 8;
}
