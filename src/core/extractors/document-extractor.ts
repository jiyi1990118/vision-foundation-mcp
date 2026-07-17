/**
 * Document / Invoice Extractor - structured field extraction for documents,
 * invoices, receipts, and bills.
 *
 * Strategy (robust, OCR + layout zones + regex, NOT VLM-trusted):
 * 1. Partition the page into vertical zones (header / body / footer) by OCR
 *    text density and y-position.
 * 2. Run regex field extraction per zone for common document fields:
 *    - Invoice: 发票号, 日期, 金额, 税额, 销售方, 购买方, 明细行
 *    - Receipt: 金额, 日期, 商户
 *    - Generic doc: 标题, 日期, 编号
 * 3. Extract line items (tabular rows in the body zone).
 * 4. Compose a structured summary.
 *
 * Why not VLM: documents cause VLM to misread numbers (amounts/dates);
 * OCR + regex reads the actual rendered values reliably.
 */
import type { OcrItem, Box } from '../key-content-extractor.js';
import { extractOcrItems } from '../key-content-extractor.js';

export type DocumentType = 'invoice' | 'receipt' | 'bill' | 'letter' | 'report' | 'generic';

export interface DocumentField {
  label: string;
  value: string;
}

export interface DocumentLineItem {
  description: string;
  quantity?: string;
  unitPrice?: string;
  amount?: string;
}

export interface DocumentExtraction {
  documentType: DocumentType;
  title?: string;
  fields: DocumentField[];
  lineItems: DocumentLineItem[];
  zones: { header: OcrItem[]; body: OcrItem[]; footer: OcrItem[] };
  summary: string;
}

export interface DocumentExtractionInput {
  category?: string | undefined;
  intent?: string | undefined;
  ocrData?: unknown;
  ocrItems?: OcrItem[] | undefined;
}

/**
 * Extract structured document data from OCR.
 */
export function extractDocument(input: DocumentExtractionInput): DocumentExtraction {
  const items = input.ocrItems ?? extractOcrItems(input.ocrData, 'full');
  const documentType = detectDocumentType(input.category, input.intent ?? '', items);

  const boxed = items.filter((i): i is OcrItem & { box: Box } => i.box !== undefined);
  const zones = partitionZones(boxed.length > 0 ? boxed : items);

  const title = extractDocTitle(zones.header.length > 0 ? zones.header : items);
  const fields = extractFields(items, documentType);
  const lineItems = extractLineItems(zones.body.length > 0 ? zones.body : boxed);

  const summary = composeDocumentSummary(documentType, title, fields, lineItems);

  return { documentType, ...(title ? { title } : {}), fields, lineItems, zones, summary };
}

/**
 * Detect document type from category + intent + OCR keywords.
 */
export function detectDocumentType(
  category: string | undefined,
  intent: string,
  items: OcrItem[],
): DocumentType {
  const text = `${intent} ${items.map((i) => i.text).join(' ')}`.toLowerCase();

  if (/发票|invoice|增值税|tax|税额|税号/.test(text)) return 'invoice';
  if (/收据|receipt|小票|消费|支付凭证/.test(text)) return 'receipt';
  if (/账单|bill|对账|明细单|结算单/.test(text)) return 'bill';
  if (category === 'document' && /信函|letter|证明|证书/.test(text)) return 'letter';
  if (category === 'document' && /报告|report|总结/.test(text)) return 'report';
  return 'generic';
}

/**
 * Partition OCR items into header / body / footer zones by y-position.
 * - Header: top ~15%
 * - Footer: bottom ~15%
 * - Body: middle ~70%
 */
export function partitionZones(items: OcrItem[]): {
  header: OcrItem[];
  body: OcrItem[];
  footer: OcrItem[];
} {
  const boxed = items.filter((i): i is OcrItem & { box: Box } => i.box !== undefined);
  if (boxed.length === 0) {
    // No boxes: put everything in body.
    return { header: [], body: items, footer: [] };
  }

  const ys = boxed.map((i) => i.box.y1);
  const minY = Math.min(...ys);
  const maxY = Math.max(...boxed.map((i) => i.box.y2));
  const height = maxY - minY;
  if (height <= 0) return { header: [], body: items, footer: [] };

  const headerCutoff = minY + height * 0.15;
  const footerCutoff = maxY - height * 0.15;

  const header: OcrItem[] = [];
  const body: OcrItem[] = [];
  const footer: OcrItem[] = [];

  for (const item of items) {
    if (!item.box) {
      body.push(item);
      continue;
    }
    const cy = (item.box.y1 + item.box.y2) / 2;
    if (cy < headerCutoff) header.push(item);
    else if (cy > footerCutoff) footer.push(item);
    else body.push(item);
  }

  return { header, body, footer };
}

/**
 * Extract the document title: top-most text line in the header zone.
 */
export function extractDocTitle(headerItems: OcrItem[]): string | undefined {
  const boxed = headerItems.filter((i): i is OcrItem & { box: Box } => i.box !== undefined);
  if (boxed.length === 0) return headerItems[0]?.text.trim();
  boxed.sort((a, b) => a.box.y1 - b.box.y1);
  return boxed[0]?.text.trim();
}

/**
 * Extract structured fields via regex per document type.
 */
export function extractFields(items: OcrItem[], documentType: DocumentType): DocumentField[] {
  const fullText = items.map((i) => i.text).join('\n');
  const fields: DocumentField[] = [];
  const seen = new Set<string>();

  const addField = (label: string, value: string) => {
    const key = `${label}:${value}`;
    if (value && !seen.has(key)) {
      seen.add(key);
      fields.push({ label, value });
    }
  };

  // Common fields across document types.
  extractByPattern(fullText, /(?:日期|开票日期|date)[：:\s]*([0-9]{4}[-/年][0-9]{1,2}[-/月][0-9]{1,2}日?])/i, '日期', addField);
  extractByPattern(fullText, /(?:编号|单号|号码|no\.?)[：:\s]*([A-Z0-9\-]{4,})/i, '编号', addField);

  // Invoice-specific
  if (documentType === 'invoice') {
    extractByPattern(fullText, /(?:发票号|发票代码|invoice no)[：:\s]*([0-9]{8,20})/i, '发票号', addField);
    extractByPattern(fullText, /(?:税额|税金|tax)[：:\s]*([¥￥$]?\s*[\d,]+\.?\d*)/i, '税额', addField);
    extractByPattern(fullText, /(?:价税合计|合计金额|总计|total)[：:\s]*([¥￥$]?\s*[\d,]+\.?\d*)/i, '价税合计', addField);
    extractByPattern(fullText, /(?:销售方|开票方|seller)[：:\s]*(.+?)(?:\n|$)/i, '销售方', addField);
    extractByPattern(fullText, /(?:购买方|受票方|buyer)[：:\s]*(.+?)(?:\n|$)/i, '购买方', addField);
    extractByPattern(fullText, /(?:税号|纳税人识别号|tax id)[：:\s]*([A-Z0-9]{6,20})/i, '税号', addField);
  }

  // Receipt / bill
  if (documentType === 'receipt' || documentType === 'bill') {
    extractByPattern(fullText, /(?:金额|实付|应付|total|amount)[：:\s]*([¥￥$]?\s*[\d,]+\.?\d*)/i, '金额', addField);
    extractByPattern(fullText, /(?:商户|收款方|merchant|store)[：:\s]*(.+?)(?:\n|$)/i, '商户', addField);
  }

  return fields;
}

/**
 * Extract line items from the body zone: rows with description + optional
 * quantity / unit price / amount.  Uses spatial grouping by y-band.
 */
export function extractLineItems(bodyItems: OcrItem[]): DocumentLineItem[] {
  const boxed = bodyItems.filter((i): i is OcrItem & { box: Box } => i.box !== undefined);
  if (boxed.length === 0) return [];

  // Group into rows by y-band.
  const sorted = [...boxed].sort((a, b) => a.box.y1 - b.box.y1 || a.box.x1 - b.box.x1);
  const rows: OcrItem[][] = [];
  let currentRow: OcrItem[] = [];

  for (const item of sorted) {
    if (currentRow.length === 0) {
      currentRow.push(item);
      continue;
    }
    const lastInRow = currentRow[currentRow.length - 1]!;
    const lastBox = lastInRow.box;
    if (!lastBox) {
      currentRow.push(item);
      continue;
    }
    const prevY = lastBox.y1;
    const tol = Math.max(8, (item.box.y2 - item.box.y1) * 0.6);
    if (Math.abs(item.box.y1 - prevY) <= tol) {
      currentRow.push(item);
    } else {
      rows.push(currentRow);
      currentRow = [item];
    }
  }
  if (currentRow.length > 0) rows.push(currentRow);

  const items: DocumentLineItem[] = [];
  for (const row of rows) {
    const texts = row.map((i) => i.text.trim()).filter(Boolean);
    if (texts.length === 0) continue;

    // Heuristic: first non-numeric text = description; numbers = qty/price/amount.
    let description = '';
    let quantity: string | undefined;
    let unitPrice: string | undefined;
    let amount: string | undefined;
    const numbers: string[] = [];

    for (const t of texts) {
      if (/^[¥￥$]?\s*[\d,]+\.?\d*$/.test(t)) {
        numbers.push(t.replace(/[¥￥$\s]/g, ''));
      } else if (!description) {
        description = t;
      } else {
        description += ` ${t}`;
      }
    }

    if (numbers.length >= 1) quantity = numbers[0];
    if (numbers.length >= 2) unitPrice = numbers[1];
    if (numbers.length >= 3) amount = numbers[2];
    else if (numbers.length === 2) amount = numbers[1];

    if (description) {
      items.push({
        description,
        ...(quantity ? { quantity } : {}),
        ...(unitPrice ? { unitPrice } : {}),
        ...(amount ? { amount } : {}),
      });
    }
  }

  return items;
}

function composeDocumentSummary(
  documentType: DocumentType,
  title: string | undefined,
  fields: DocumentField[],
  lineItems: DocumentLineItem[],
): string {
  const typeLabel: Record<DocumentType, string> = {
    invoice: '发票', receipt: '收据', bill: '账单', letter: '信函', report: '报告', generic: '文档',
  };
  const parts: string[] = [];
  parts.push(`【${typeLabel[documentType]}】`);
  if (title) parts.push(`标题：${title}；`);

  if (fields.length > 0) {
    const fieldText = fields.map((f) => `${f.label}=${f.value}`).join('，');
    parts.push(`字段：${fieldText}；`);
  }
  if (lineItems.length > 0) {
    parts.push(`明细共 ${lineItems.length} 行；`);
  }

  return parts.join('');
}

function extractByPattern(
  text: string,
  pattern: RegExp,
  label: string,
  addField: (label: string, value: string) => void,
): void {
  const match = text.match(pattern);
  if (match && match[1]) {
    addField(label, match[1].trim());
  }
}
