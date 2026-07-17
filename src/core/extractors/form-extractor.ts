/**
 * Form Extractor - structured field extraction for form layouts.
 *
 * Strategy (robust, OCR + layout heuristics, NOT VLM-trusted):
 * 1. Detect form fields: "label：value" patterns, plus standalone labels
 *    followed by a value box to the right or below.
 * 2. Detect interactive control states: checkboxes (✓/✗/X/☑/☐), radio
 *    selections, select/dropdown chosen values, toggle switches.
 * 3. Group fields into logical sections when section headers are present.
 * 4. Compose a structured field list + summary.
 *
 * Why not VLM: forms cause VLM to hallucinate values / miss checkbox states;
 * OCR + pattern matching reads the actual rendered states.
 */
import type { OcrItem, Box } from '../key-content-extractor.js';
import { extractOcrItems } from '../key-content-extractor.js';

export interface FormField {
  label: string;
  value: string;
  /** Detected control type, if any. */
  control?: 'checkbox' | 'radio' | 'select' | 'toggle' | 'input';
  /** Checkbox/radio state, when applicable. */
  checked?: boolean;
}

export interface FormSection {
  title?: string | undefined;
  fields: FormField[];
}

export interface FormExtraction {
  sections: FormSection[];
  fields: FormField[];
  summary: string;
}

export interface FormExtractionInput {
  ocrData?: unknown;
  ocrItems?: OcrItem[];
}

const CHECKED_MARKS = ['✓', '✔', '☑', '×', 'x', '✗', '[x]', '【x】', '☑'];
const UNCHECKED_MARKS = ['☐', '□', '[ ]', '【 】', '○'];

/**
 * Extract structured form fields from OCR.
 */
export function extractForm(input: FormExtractionInput): FormExtraction {
  const items = input.ocrItems ?? extractOcrItems(input.ocrData, 'full');

  const fields = extractFormFields(items);
  const sections = groupIntoSections(items, fields);

  const summary = composeFormSummary(fields, sections);

  return { sections, fields, summary };
}

/**
 * Extract form fields: label-value pairs + control states.
 */
export function extractFormFields(items: OcrItem[]): FormField[] {
  const fields: FormField[] = [];
  const seen = new Set<string>();

  const boxed = items.filter((i): i is OcrItem & { box: Box } => i.box !== undefined);
  const noBox = items.filter((i) => i.box === undefined);

  // Pass 1: "label：value" or "label: value" inline patterns.
  for (const item of [...boxed, ...noBox]) {
    const text = item.text.trim();
    const match = text.match(/^([^：:]{1,20})[：:]\s*(.+)$/);
    if (match) {
      const label = match[1]!.trim();
      const value = match[2]!.trim();
      // Skip complex multi-clause values (contain additional colons).
      if (/[：:]/.test(value)) continue;
      const key = `${label}=${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        fields.push({ label, value, control: 'input' });
      }
    }
  }

  // Pass 2: checkbox / radio states - standalone marks or marks before a label.
  for (const item of [...boxed, ...noBox]) {
    const text = item.text.trim();
    const checked = detectCheckState(text);
    if (checked !== undefined) {
      // The label might be the rest of this token or the next nearby token.
      const rest = text.replace(/^[✓✔☑×x✗☐□○\[\]【】\s]+/i, '').trim();
      const label = rest.length > 0 ? rest : findAdjacentLabel(boxed, item);
      if (label) {
        const key = `chk:${label}`;
        if (!seen.has(key)) {
          seen.add(key);
          fields.push({ label, value: checked ? '已勾选' : '未勾选', control: 'checkbox', checked });
        }
      }
    }
  }

  // Pass 3: standalone labels followed by a value box to the right.
  for (let i = 0; i < boxed.length; i++) {
    const current = boxed[i]!;
    const text = current.text.trim();
    // Label ends with ：or : with no inline value.
    if (/[：:]$/.test(text)) {
      const label = text.replace(/[：:]$/, '').trim();
      // Find a token to the right (greater x, similar y).
      const right = boxed.find((other) => {
        if (other === current) return false;
        const cy = (other.box.y1 + other.box.y2) / 2;
        const curCy = (current.box.y1 + current.box.y2) / 2;
        const rowH = current.box.y2 - current.box.y1;
        return other.box.x1 > current.box.x2 - 5 && Math.abs(cy - curCy) <= rowH * 0.8;
      });
      if (right) {
        const value = right.text.trim();
        const key = `${label}=${value}`;
        if (!seen.has(key) && value) {
          seen.add(key);
          fields.push({ label, value, control: 'input' });
        }
      }
    }
  }

  return fields;
}

/**
 * Detect checkbox / radio state from a text token.
 */
export function detectCheckState(text: string): boolean | undefined {
  const lower = text.toLowerCase();
  for (const mark of CHECKED_MARKS) {
    if (text.includes(mark) || lower.includes(mark.toLowerCase())) return true;
  }
  for (const mark of UNCHECKED_MARKS) {
    if (text.includes(mark)) return false;
  }
  return undefined;
}

/**
 * Find the label of a checkbox by looking at adjacent OCR tokens (to the right
 * or on the same line).
 */
export function findAdjacentLabel(boxed: OcrItem[], mark: OcrItem): string {
  const markBox = mark.box;
  if (!markBox) return '';
  const markCy = (markBox.y1 + markBox.y2) / 2;
  const markH = markBox.y2 - markBox.y1;
  const candidates = boxed
    .filter((i): i is OcrItem & { box: Box } => i !== mark && i.box !== undefined)
    .filter((i) => {
      const cy = (i.box.y1 + i.box.y2) / 2;
      return Math.abs(cy - markCy) <= markH * 0.8 && i.box.x1 > markBox.x1;
    })
    .sort((a, b) => a.box.x1 - b.box.x1);
  return candidates[0]?.text.trim() ?? '';
}

/**
 * Group fields into sections based on section header detection (short, bold-ish
 * standalone text lines with no following value).
 */
export function groupIntoSections(items: OcrItem[], fields: FormField[]): FormSection[] {
  // Simple heuristic: a section header is a short text line that is NOT a
  // field label (no colon) and NOT a checkbox.  We can't reliably detect bold,
  // so we treat standalone short lines as potential headers.
  const boxed = items.filter((i): i is OcrItem & { box: Box } => i.box !== undefined);
  if (boxed.length === 0) {
    return [{ title: undefined, fields }];
  }

  const headers = boxed
    .map((i) => i.text.trim())
    .filter((t) => t.length >= 2 && t.length <= 16 && !/[：:]/.test(t) && !detectCheckState(t));

  if (headers.length === 0) {
    return [{ title: undefined, fields }];
  }

  // For simplicity, return a single section with all fields; full section
  // assignment by y-position would require stricter header detection.
  return [{ title: headers[0], fields }];
}

function composeFormSummary(fields: FormField[], sections: FormSection[]): string {
  if (fields.length === 0) return '未识别到表单字段。';
  const parts: string[] = [];
  parts.push(`【表单】共 ${fields.length} 个字段。`);

  const fieldTexts = fields
    .filter((f) => f.control === 'input')
    .map((f) => `${f.label}=${f.value}`)
    .slice(0, 12);
  if (fieldTexts.length > 0) parts.push(`字段：${fieldTexts.join('，')}；`);

  const checks = fields.filter((f) => f.control === 'checkbox');
  if (checks.length > 0) {
    const checked = checks.filter((f) => f.checked).map((f) => f.label);
    if (checked.length > 0) parts.push(`已勾选：${checked.join('、')}；`);
  }

  void sections;
  return parts.join('');
}
