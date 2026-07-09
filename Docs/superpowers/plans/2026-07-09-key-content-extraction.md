# Key Content Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add robust key-content extraction for marked/described UI regions, including local OCR enhancement and structured table reconstruction for dense screenshots.

**Architecture:** Add a focused `src/core/key-content-extractor.ts` module that resolves a target region, optionally runs local upscaled OCR, merges OCR items, and structures target content. Keep `annotation-detector` responsible only for annotation discovery, and keep `composeResult` responsible only for final result assembly.

**Tech Stack:** TypeScript, Vitest, `sharp`, existing `VisionProvider` OCR interface, existing MCP `vision.analyze` pipeline.

---

## File Structure

- Create: `src/core/key-content-extractor.ts`
  - Owns target activation, region resolution, region OCR enhancement, OCR item merging, line grouping, table reconstruction, symbol normalization, and summary generation.
- Modify: `src/core/skill-pipeline.ts`
  - Removes the current local `buildTargetExtraction()` red-box-only implementation.
  - Adds `keyContentExtraction?: unknown` to `ComposeResultOptions`.
  - Attaches extraction as `result.targetExtraction`.
  - Uses extraction summary in annotation summary when available.
- Modify: `src/tools/vision-analyze.ts`
  - Imports `extractKeyContent()`.
  - Finds the OCR provider override or selected OCR provider.
  - Runs key-content extraction after annotation detection.
  - Passes extraction into `composeResult()`.
- Modify: `src/types/skills.ts`
  - Keeps the existing `options.target` shape; no additional planner contract is needed.
- Create: `tests/key-content-extractor.test.ts`
  - Unit tests for activation, target resolution, wrapped header merging, money symbol normalization, table reconstruction, and local OCR merging using fake OCR providers.
- Modify: `tests/compose-result-heuristic.test.ts`
  - Replace red-box-only `targetExtraction` expectation with precomputed key-content extraction passthrough.
- Modify: `tests/vision-analyze-routing.test.ts`
  - Add a focused assertion that target requests can pass through key-content extraction when OCR and annotations are available, using existing mocked provider patterns if feasible.
- Modify: `package.json`
  - Add `tests/key-content-extractor.test.ts` to `test:unit`.

---

### Task 1: Add Key Content Types And Activation

**Files:**
- Create: `src/core/key-content-extractor.ts`
- Test: `tests/key-content-extractor.test.ts`

- [ ] **Step 1: Write failing activation tests**

Create `tests/key-content-extractor.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { shouldExtractKeyContent } from '../src/core/key-content-extractor.js';

describe('key-content extractor activation', () => {
  it('activates when options.target is provided', () => {
    expect(shouldExtractKeyContent({
      target: { color: 'red', description: '虚线红框中的内容' },
      intent: 'auto',
      annotations: undefined,
      skillNames: ['classify', 'summary'],
    })).toBe(true);
  });

  it('activates for region extraction intent keywords', () => {
    expect(shouldExtractKeyContent({
      intent: '请提取红色虚线框中的内容',
      annotations: undefined,
      skillNames: ['ocr', 'summary'],
    })).toBe(true);
  });

  it('does not activate for classification-only requests', () => {
    expect(shouldExtractKeyContent({
      intent: 'classify this image',
      annotations: { redBoxes: [{ box: '10,10,100,100', confidence: 0.8, insideText: [], insideTextLines: [], nearbyText: [] }] },
      skillNames: ['classify'],
    })).toBe(false);
  });

  it('activates when annotations exist and OCR or summary is requested', () => {
    expect(shouldExtractKeyContent({
      intent: '分析这个需求截图',
      annotations: { redBoxes: [{ box: '10,10,100,100', confidence: 0.8, insideText: [], insideTextLines: [], nearbyText: [] }] },
      skillNames: ['ocr', 'summary'],
    })).toBe(true);
  });
});
```

- [ ] **Step 2: Run activation tests to verify failure**

Run: `npx vitest run --fileParallelism=false tests/key-content-extractor.test.ts`

Expected: FAIL because `src/core/key-content-extractor.ts` does not exist.

- [ ] **Step 3: Implement types and activation helper**

Create `src/core/key-content-extractor.ts` with:

```ts
import type sharp from 'sharp';
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
}

export interface KeyContentActivationInput {
  target?: TargetQuery | undefined;
  intent?: string | undefined;
  annotations?: ImageAnnotations | undefined;
  skillNames: string[];
}

export function shouldExtractKeyContent(input: KeyContentActivationInput): boolean {
  if (input.target) return true;

  const intent = input.intent ?? '';
  if (/红框|虚线框|框中|圈出|标注|高亮|关键内容|提取区域|右侧|左侧|上方|下方|弹窗|表格|列|行|red box|highlight|annotat|region|column|row|table|dialog|popup/i.test(intent)) {
    return true;
  }

  const hasAnnotations = (input.annotations?.redBoxes.length ?? 0) > 0;
  const wantsContent = input.skillNames.includes('ocr') || input.skillNames.includes('summary');
  return hasAnnotations && wantsContent;
}

export async function extractKeyContent(_input: KeyContentInput): Promise<KeyContentExtraction | undefined> {
  return undefined;
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

void sharp;
```

- [ ] **Step 4: Run activation tests to verify pass**

Run: `npx vitest run --fileParallelism=false tests/key-content-extractor.test.ts`

Expected: PASS for 4 activation tests.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add src/core/key-content-extractor.ts tests/key-content-extractor.test.ts
git commit -m "feat: add key content extraction activation"
```

---

### Task 2: Resolve Target Regions From Annotations And Layout

**Files:**
- Modify: `src/core/key-content-extractor.ts`
- Test: `tests/key-content-extractor.test.ts`

- [ ] **Step 1: Add failing target resolution tests**

Append to `tests/key-content-extractor.test.ts`:

```ts
import { resolveTargetRegion } from '../src/core/key-content-extractor.js';

describe('key-content target resolution', () => {
  it('prefers red annotation boxes when color is red', () => {
    const region = resolveTargetRegion({
      target: { color: 'red', position: 'right' },
      annotations: {
        redBoxes: [
          { box: '10,10,100,100', confidence: 0.7, insideText: [], insideTextLines: [], nearbyText: [] },
          { box: '400,50,700,300', confidence: 0.8, insideText: [], insideTextLines: [], nearbyText: [] },
        ],
      },
      ocrItems: [],
    });

    expect(region).toMatchObject({ type: 'redBox', box: '400,50,700,300', confidence: 0.8 });
  });

  it('returns undefined for non-red explicit color when only red boxes exist', () => {
    const region = resolveTargetRegion({
      target: { color: 'blue' },
      annotations: {
        redBoxes: [{ box: '10,10,100,100', confidence: 0.7, insideText: [], insideTextLines: [], nearbyText: [] }],
      },
      ocrItems: [],
    });

    expect(region).toBeUndefined();
  });

  it('can derive a right-side layout region from OCR items without annotations', () => {
    const region = resolveTargetRegion({
      target: { position: 'right', description: '右侧价格列' },
      ocrItems: [
        { text: '名称', box: { x1: 100, y1: 100, x2: 180, y2: 130 } },
        { text: '价格', box: { x1: 500, y1: 100, x2: 580, y2: 130 } },
        { text: '0.00', box: { x1: 500, y1: 160, x2: 580, y2: 190 } },
        { text: '0.00', box: { x1: 500, y1: 220, x2: 580, y2: 250 } },
      ],
    });

    expect(region?.type).toBe('layoutRegion');
    expect(region?.box).toBe('500,100,580,250');
  });
});
```

- [ ] **Step 2: Run target resolution tests to verify failure**

Run: `npx vitest run --fileParallelism=false tests/key-content-extractor.test.ts`

Expected: FAIL because `resolveTargetRegion` is not exported.

- [ ] **Step 3: Implement target resolution**

Add to `src/core/key-content-extractor.ts`:

```ts
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

export function resolveTargetRegion(input: ResolveTargetRegionInput): ResolvedTargetRegion | undefined {
  const explicitColor = input.target?.color?.toLowerCase();
  if (explicitColor && explicitColor !== 'red' && explicitColor !== '红色') {
    return undefined;
  }

  const redBoxes = input.annotations?.redBoxes ?? [];
  if (redBoxes.length > 0) {
    const candidates = redBoxes
      .map((box) => ({ raw: box, parsed: parseBox(box.box) }))
      .filter((item): item is { raw: typeof redBoxes[number]; parsed: Box } => item.parsed !== undefined)
      .map((item) => ({
        type: 'redBox' as const,
        box: item.raw.box,
        confidence: item.raw.confidence,
        score: item.raw.confidence + scorePosition(item.parsed, input.target?.position),
      }))
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    return best ? { type: best.type, box: best.box, confidence: best.confidence } : undefined;
  }

  return resolveLayoutRegion(input.ocrItems, input.target, input.intent);
}

function resolveLayoutRegion(items: OcrItem[], target: TargetQuery | undefined, intent: string | undefined): ResolvedTargetRegion | undefined {
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
```

- [ ] **Step 4: Run target resolution tests to verify pass**

Run: `npx vitest run --fileParallelism=false tests/key-content-extractor.test.ts`

Expected: PASS for activation and target resolution tests.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add src/core/key-content-extractor.ts tests/key-content-extractor.test.ts
git commit -m "feat: resolve key content target regions"
```

---

### Task 3: Extract OCR Items In A Region And Exclude Edge-Touching Outside Text

**Files:**
- Modify: `src/core/key-content-extractor.ts`
- Test: `tests/key-content-extractor.test.ts`

- [ ] **Step 1: Add failing OCR region extraction tests**

Append to `tests/key-content-extractor.test.ts`:

```ts
import { extractOcrItems, itemsInsideRegion } from '../src/core/key-content-extractor.js';

describe('key-content region OCR items', () => {
  it('extracts normalized OCR items from skill data', () => {
    const items = extractOcrItems({
      texts: [
        { text: '默认基础价-半份', position: '1466,529,1688,567', confidence: 0.99 },
        { text: ' ', position: '0,0,1,1' },
        '无坐标文本',
      ],
    });

    expect(items).toEqual([
      { text: '默认基础价-半份', box: { x1: 1466, y1: 529, x2: 1688, y2: 567 }, confidence: 0.99, source: 'full' },
      { text: '无坐标文本', source: 'full' },
    ]);
  });

  it('excludes outside text that only touches a target edge', () => {
    const region = { x1: 1450, y1: 500, x2: 1918, y2: 1090 };
    const items = itemsInsideRegion([
      { text: '默认附加价(元)', box: { x1: 1252, y1: 542, x2: 1457, y2: 584 } },
      { text: '默认基础价-半份', box: { x1: 1466, y1: 529, x2: 1688, y2: 567 } },
      { text: '默认附加价-半份', box: { x1: 1680, y1: 529, x2: 1903, y2: 567 } },
    ], region);

    expect(items.map((item) => item.text)).toEqual(['默认基础价-半份', '默认附加价-半份']);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run --fileParallelism=false tests/key-content-extractor.test.ts`

Expected: FAIL because `extractOcrItems` and `itemsInsideRegion` are not exported.

- [ ] **Step 3: Implement OCR extraction and strict region inclusion**

Add to `src/core/key-content-extractor.ts`:

```ts
export function extractOcrItems(data: unknown, source: 'full' | 'local' = 'full'): OcrItem[] {
  if (typeof data !== 'object' || data === null) return [];
  const texts = (data as { texts?: unknown }).texts;
  if (!Array.isArray(texts)) return [];

  return texts
    .map((item): OcrItem | undefined => {
      if (typeof item === 'string') {
        const text = item.trim();
        return text ? { text, source } : undefined;
      }
      if (typeof item !== 'object' || item === null) return undefined;
      const text = (item as { text?: unknown }).text;
      if (typeof text !== 'string' || text.trim().length === 0) return undefined;
      const position = (item as { position?: unknown }).position;
      const confidence = (item as { confidence?: unknown }).confidence;
      return {
        text: text.trim(),
        ...(typeof position === 'string' && parseBox(position) ? { box: parseBox(position) } : {}),
        ...(typeof confidence === 'number' ? { confidence } : {}),
        source,
      };
    })
    .filter((item): item is OcrItem => item !== undefined);
}

export function itemsInsideRegion(items: OcrItem[], region: Box): OcrItem[] {
  return items
    .filter((item): item is OcrItem & { box: Box } => item.box !== undefined)
    .filter((item) => isTextInsideRegion(item.box, region))
    .sort((a, b) => Math.abs(centerY(a.box) - centerY(b.box)) > 8 ? centerY(a.box) - centerY(b.box) : centerX(a.box) - centerX(b.box));
}

function isTextInsideRegion(textBox: Box, region: Box): boolean {
  if (pointInside(centerX(textBox), centerY(textBox), expandBox(region, 4))) return true;
  return overlapRatio(textBox, region) >= 0.35;
}

function pointInside(x: number, y: number, box: Box): boolean {
  return x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2;
}

function expandBox(box: Box, amount: number): Box {
  return { x1: box.x1 - amount, y1: box.y1 - amount, x2: box.x2 + amount, y2: box.y2 + amount };
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run --fileParallelism=false tests/key-content-extractor.test.ts`

Expected: PASS for activation, target resolution, and region item tests.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add src/core/key-content-extractor.ts tests/key-content-extractor.test.ts
git commit -m "feat: extract OCR items inside key regions"
```

---

### Task 4: Group Lines And Reconstruct Dense Tables

**Files:**
- Modify: `src/core/key-content-extractor.ts`
- Test: `tests/key-content-extractor.test.ts`

- [ ] **Step 1: Add failing table reconstruction tests**

Append to `tests/key-content-extractor.test.ts`:

```ts
import { buildStructuredContent } from '../src/core/key-content-extractor.js';

describe('key-content table reconstruction', () => {
  it('merges wrapped two-column headers and reconstructs rows', () => {
    const extraction = buildStructuredContent([
      { text: '默认基础价-半份', box: { x1: 1466, y1: 529, x2: 1688, y2: 567 } },
      { text: '默认附加价-半份', box: { x1: 1680, y1: 529, x2: 1903, y2: 567 } },
      { text: '(元)', box: { x1: 1543, y1: 564, x2: 1605, y2: 600 }, source: 'local' },
      { text: '(元)', box: { x1: 1763, y1: 564, x2: 1824, y2: 600 }, source: 'local' },
      { text: '0.00', box: { x1: 1483, y1: 626, x2: 1571, y2: 680 } },
      { text: '¥', box: { x1: 1578, y1: 631, x2: 1605, y2: 675 }, source: 'local' },
      { text: '0.00', box: { x1: 1697, y1: 630, x2: 1789, y2: 672 } },
      { text: '¥', box: { x1: 1798, y1: 631, x2: 1824, y2: 675 }, source: 'local' },
      { text: '0.00', box: { x1: 1483, y1: 710, x2: 1571, y2: 752 } },
      { text: '夫', box: { x1: 1578, y1: 710, x2: 1605, y2: 752 }, source: 'local' },
      { text: '0.00', box: { x1: 1697, y1: 701, x2: 1793, y2: 756 } },
      { text: '夫', box: { x1: 1798, y1: 710, x2: 1824, y2: 752 }, source: 'local' },
    ], { type: 'redBox', box: '1450,500,1918,1090', confidence: 0.75 });

    expect(extraction.table).toEqual({
      columns: ['默认基础价-半份（元）', '默认附加价-半份（元）'],
      rows: [
        ['0.00 ¥', '0.00 ¥'],
        ['0.00 ¥', '0.00 ¥'],
      ],
    });
    expect(extraction.summary).toContain('默认基础价-半份（元）');
    expect(extraction.summary).toContain('共 2 行');
    expect(extraction.warnings).toEqual(expect.arrayContaining(['局部 OCR 将金额符号候选“夫”按金额上下文归一化为“¥”']));
  });

  it('does not normalize 夫 when it is not next to a numeric amount', () => {
    const extraction = buildStructuredContent([
      { text: '负责人', box: { x1: 100, y1: 100, x2: 180, y2: 130 } },
      { text: '夫', box: { x1: 100, y1: 160, x2: 130, y2: 190 } },
    ], { type: 'layoutRegion', box: '100,100,200,200', confidence: 0.55 });

    expect(extraction.textLines).toEqual(['负责人', '夫']);
    expect(extraction.summary).toContain('负责人');
    expect(extraction.warnings).not.toEqual(expect.arrayContaining(['局部 OCR 将金额符号候选“夫”按金额上下文归一化为“¥”']));
  });
});
```

- [ ] **Step 2: Run table tests to verify failure**

Run: `npx vitest run --fileParallelism=false tests/key-content-extractor.test.ts`

Expected: FAIL because `buildStructuredContent` is not exported.

- [ ] **Step 3: Implement line grouping, table grouping, and normalization**

Add to `src/core/key-content-extractor.ts`:

```ts
interface LineGroup {
  y: number;
  items: Array<OcrItem & { box: Box }>;
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

function buildTable(lines: LineGroup[], warnings: string[]): { columns: string[]; rows: string[][] } | undefined {
  if (lines.length < 2) return undefined;

  const headerLines = lines.slice(0, 2);
  const dataLines = lines.slice(2);
  const firstHeader = headerLines[0]?.items ?? [];
  if (firstHeader.length < 2) return undefined;

  const columns = firstHeader.map((item) => item.text);
  const unitLine = headerLines[1]?.items ?? [];
  for (let i = 0; i < columns.length; i++) {
    const header = firstHeader[i]!;
    const unit = nearestItem(unitLine, centerX(header.box));
    if (unit && /^[(（]元[)）]$/.test(unit.text)) {
      columns[i] = `${columns[i]}${normalizeUnitText(unit.text)}`;
    }
  }

  const rows = dataLines
    .map((line) => normalizeMoneyCells(line.items, firstHeader.map((item) => centerX(item.box)), warnings))
    .filter((row) => row.length === columns.length && row.some((cell) => cell.length > 0));

  return columns.length >= 2 && rows.length > 0 ? { columns, rows } : undefined;
}

function normalizeMoneyCells(items: Array<OcrItem & { box: Box }>, columnCenters: number[], warnings: string[]): string[] {
  const cells = columnCenters.map(() => '');
  const used = new Set<number>();

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const item = items[i]!;
    if (!isNumericAmount(item.text)) continue;
    const symbolIndex = items.findIndex((candidate, index) => (
      index !== i
      && !used.has(index)
      && isCurrencyCandidate(candidate.text)
      && isSameMoneyCell(item.box, candidate.box)
    ));
    let value = item.text;
    if (symbolIndex >= 0) {
      if (items[symbolIndex]!.text === '夫') warnings.push('局部 OCR 将金额符号候选“夫”按金额上下文归一化为“¥”');
      value = `${value} ¥`;
      used.add(symbolIndex);
    }
    used.add(i);
    const columnIndex = nearestIndex(columnCenters, centerX(item.box));
    cells[columnIndex] = value;
  }

  return cells;
}

function isNumericAmount(text: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(text);
}

function isCurrencyCandidate(text: string): boolean {
  return text === '¥' || text === '￥' || text === '夫';
}

function isSameMoneyCell(amount: Box, symbol: Box): boolean {
  return Math.abs(centerY(amount) - centerY(symbol)) <= Math.max(amount.y2 - amount.y1, symbol.y2 - symbol.y1) * 0.7
    && symbol.x1 >= amount.x1
    && symbol.x1 - amount.x2 <= 45;
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
```

- [ ] **Step 4: Run table tests to verify pass**

Run: `npx vitest run --fileParallelism=false tests/key-content-extractor.test.ts`

Expected: PASS for all key-content extractor tests.

- [ ] **Step 5: Commit Task 4**

Run:

```bash
git add src/core/key-content-extractor.ts tests/key-content-extractor.test.ts
git commit -m "feat: structure key content tables"
```

---

### Task 5: Add Region OCR Enhancement With A Fake OCR Provider Test

**Files:**
- Modify: `src/core/key-content-extractor.ts`
- Test: `tests/key-content-extractor.test.ts`

- [ ] **Step 1: Add failing local OCR enhancement test**

Append to `tests/key-content-extractor.test.ts`:

```ts
import sharp from 'sharp';
import { enhanceRegionOcr } from '../src/core/key-content-extractor.js';
import type { VisionProvider } from '../src/providers/types.js';
import type { InferenceRequest, InferenceResponse } from '../src/types/domain.js';

class FakeOcrProvider implements VisionProvider {
  readonly name = 'fake-ocr';
  readonly runtime = 'native-ocr';
  readonly supportedRuntimes = ['native-ocr'];
  readonly supportedSkills = ['ocr'];
  readonly requirements = { minMemoryMB: 1, gpuRequired: false, modelSizeMB: 1 };
  lastImageSize = 0;

  async load(): Promise<void> {}
  async unload(): Promise<void> {}
  isLoaded(): boolean { return true; }

  async infer(req: InferenceRequest): Promise<InferenceResponse> {
    this.lastImageSize = req.image.buffer.length;
    return {
      text: JSON.stringify({
        texts: [
          { text: '(元)', position: '100,100,180,150', confidence: 0.99 },
          { text: '¥', position: '220,260,250,310', confidence: 0.9 },
        ],
        language: 'zh',
      }),
      duration: 1,
    };
  }
}

describe('key-content local OCR enhancement', () => {
  it('runs OCR on an upscaled crop and maps local positions back to original coordinates', async () => {
    const buffer = await sharp({ create: { width: 300, height: 300, channels: 3, background: 'white' } }).png().toBuffer();
    const provider = new FakeOcrProvider();
    const items = await enhanceRegionOcr({
      image: { buffer, mimeType: 'image/png', source: 'synthetic', size: buffer.length },
      region: { x1: 50, y1: 60, x2: 250, y2: 260 },
      provider,
      scale: 4,
    });

    expect(items).toEqual([
      { text: '(元)', box: { x1: 75, y1: 85, x2: 95, y2: 98 }, confidence: 0.99, source: 'local' },
      { text: '¥', box: { x1: 105, y1: 125, x2: 113, y2: 138 }, confidence: 0.9, source: 'local' },
    ]);
    expect(provider.lastImageSize).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run local OCR test to verify failure**

Run: `npx vitest run --fileParallelism=false tests/key-content-extractor.test.ts`

Expected: FAIL because `enhanceRegionOcr` is not exported.

- [ ] **Step 3: Implement local OCR enhancement**

Update `src/core/key-content-extractor.ts` imports and add implementation:

```ts
import sharp from 'sharp';
```

Replace the temporary `import type sharp from 'sharp';` and `void sharp;` from Task 1.

Add:

```ts
export interface EnhanceRegionOcrInput {
  image: ImageInput;
  region: Box;
  provider: VisionProvider;
  scale?: number;
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
    cache: false,
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
```

- [ ] **Step 4: Run local OCR tests to verify pass**

Run: `npx vitest run --fileParallelism=false tests/key-content-extractor.test.ts`

Expected: PASS for all key-content tests.

- [ ] **Step 5: Commit Task 5**

Run:

```bash
git add src/core/key-content-extractor.ts tests/key-content-extractor.test.ts
git commit -m "feat: enhance key regions with local OCR"
```

---

### Task 6: Implement End-To-End Key Content Extraction

**Files:**
- Modify: `src/core/key-content-extractor.ts`
- Test: `tests/key-content-extractor.test.ts`

- [ ] **Step 1: Add failing end-to-end extraction tests**

Append to `tests/key-content-extractor.test.ts`:

```ts
describe('extractKeyContent', () => {
  it('extracts a red-box two-column table without adjacent outside headers', async () => {
    const buffer = await sharp({ create: { width: 2200, height: 1200, channels: 3, background: 'white' } }).png().toBuffer();
    const provider = new FakeOcrProvider();
    provider.infer = async () => ({
      text: JSON.stringify({
        texts: [
          { text: '(元)', position: '412,256,660,400', confidence: 0.99 },
          { text: '(元)', position: '1292,256,1540,400', confidence: 0.99 },
          { text: '¥', position: '512,524,620,700', confidence: 0.9 },
          { text: '¥', position: '1392,524,1500,700', confidence: 0.9 },
        ],
        language: 'zh',
      }),
      duration: 1,
    });

    const extraction = await extractKeyContent({
      image: { buffer, mimeType: 'image/png', source: 'synthetic', size: buffer.length },
      target: { color: 'red', position: 'right', description: '虚线红框中的内容' },
      annotations: {
        redBoxes: [{
          box: '1450,500,1918,1090',
          confidence: 0.75,
          insideText: ['默认基础价-半份', '默认附加价-半份', '0.00'],
          insideTextLines: ['默认基础价-半份', '默认附加价-半份', '0.00', '0.00'],
          nearbyText: [],
        }],
      },
      ocrData: {
        texts: [
          { text: '默认附加价(元)', position: '1252,542,1457,584', confidence: 0.99 },
          { text: '默认基础价-半份', position: '1466,529,1688,567', confidence: 0.99 },
          { text: '默认附加价-半份', position: '1680,529,1903,567', confidence: 0.99 },
          { text: '0.00', position: '1483,626,1571,680', confidence: 0.99 },
          { text: '0.00', position: '1697,630,1789,672', confidence: 0.99 },
        ],
      },
      ocrProvider: provider,
    });

    expect(extraction?.textLines.join('\n')).not.toContain('默认附加价(元)');
    expect(extraction?.table).toEqual({
      columns: ['默认基础价-半份（元）', '默认附加价-半份（元）'],
      rows: [['0.00 ¥', '0.00 ¥']],
    });
  });
});
```

- [ ] **Step 2: Run end-to-end test to verify failure**

Run: `npx vitest run --fileParallelism=false tests/key-content-extractor.test.ts`

Expected: FAIL because `extractKeyContent()` still returns `undefined`.

- [ ] **Step 3: Implement `extractKeyContent()` orchestration**

Replace the placeholder `extractKeyContent()` in `src/core/key-content-extractor.ts` with:

```ts
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
      localItems = await enhanceRegionOcr({ image: input.image, region: parsedRegion, provider: input.ocrProvider });
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
    if (!local.box) {
      merged.push(local);
      continue;
    }
    const duplicateIndex = merged.findIndex((item) => item.box && overlapRatio(item.box, local.box) >= 0.6 && item.text === local.text);
    if (duplicateIndex >= 0) {
      merged[duplicateIndex] = local;
    } else {
      merged.push(local);
    }
  }
  return merged;
}
```

- [ ] **Step 4: Run end-to-end tests to verify pass**

Run: `npx vitest run --fileParallelism=false tests/key-content-extractor.test.ts`

Expected: PASS for all key-content tests.

- [ ] **Step 5: Commit Task 6**

Run:

```bash
git add src/core/key-content-extractor.ts tests/key-content-extractor.test.ts
git commit -m "feat: orchestrate key content extraction"
```

---

### Task 7: Wire Key Content Extraction Into Vision Analyze And Compose Result

**Files:**
- Modify: `src/core/skill-pipeline.ts`
- Modify: `src/tools/vision-analyze.ts`
- Modify: `tests/compose-result-heuristic.test.ts`

- [ ] **Step 1: Add failing compose passthrough test**

Modify the test `adds targetExtraction for custom annotation target requests` in `tests/compose-result-heuristic.test.ts` to pass precomputed extraction instead of expecting compose to build it from annotations:

```ts
  it('adds precomputed targetExtraction for custom key-content requests', () => {
    const r = composeResult(
      ocrUiResults(),
      'gguf-smolvlm2', 'llama-cpp', 1000,
      {
        keyContentExtraction: {
          query: { color: 'red', position: 'right', description: '虚线红框中的内容' },
          matchedRegion: { type: 'redBox', box: '300,200,900,600', confidence: 0.9 },
          textLines: ['尺寸名称(中文)', '0.00', '0.00'],
          summary: '关键区域包含：尺寸名称(中文)；0.00；0.00。',
          warnings: [],
        },
        annotations: {
          redBoxes: [
            {
              box: '300,200,900,600',
              confidence: 0.9,
              insideText: ['尺寸名称(中文)', '0.00'],
              insideTextLines: ['尺寸名称(中文)', '0.00', '0.00'],
              nearbyText: ['比萨配料管理'],
            },
          ],
        },
      },
    );

    expect(r.result.targetExtraction).toMatchObject({
      query: { color: 'red', position: 'right', description: '虚线红框中的内容' },
      matchedRegion: { type: 'redBox', box: '300,200,900,600' },
      textLines: ['尺寸名称(中文)', '0.00', '0.00'],
    });
    expect(r.summary).toContain('关键区域包含');
  });
```

- [ ] **Step 2: Run compose test to verify failure**

Run: `npx vitest run --fileParallelism=false tests/compose-result-heuristic.test.ts`

Expected: FAIL because `ComposeResultOptions` has no `keyContentExtraction` and summary does not use it.

- [ ] **Step 3: Update `composeResult()` to accept precomputed key content**

Modify `src/core/skill-pipeline.ts`:

```ts
export interface ComposeResultOptions {
  annotations?: unknown;
  target?: TargetQuery | undefined;
  keyContentExtraction?: unknown;
}
```

Replace:

```ts
  if (hasRedBoxes(options.annotations)) {
    summary = appendAnnotationSummary(summary, options.annotations);
  }
```

with:

```ts
  if (options.keyContentExtraction) {
    summary = appendKeyContentSummary(summary, options.keyContentExtraction);
  } else if (hasRedBoxes(options.annotations)) {
    summary = appendAnnotationSummary(summary, options.annotations);
  }
```

Replace:

```ts
  const targetExtraction = buildTargetExtraction(options.target, options.annotations);
  if (targetExtraction) {
    resultMap.targetExtraction = targetExtraction;
  }
```

with:

```ts
  if (options.keyContentExtraction) {
    resultMap.targetExtraction = options.keyContentExtraction;
  }
```

Add:

```ts
function appendKeyContentSummary(summary: string, extraction: unknown): string {
  if (typeof extraction !== 'object' || extraction === null) return summary;
  const extractionSummary = (extraction as { summary?: unknown }).summary;
  if (typeof extractionSummary !== 'string' || extractionSummary.length === 0) return summary;
  return summary ? `${summary}${extractionSummary}` : extractionSummary;
}
```

Delete the old local helpers from `src/core/skill-pipeline.ts` if they are no longer used:

```ts
function buildTargetExtraction(...)
function pickTargetRedBox(...)
function scoreTargetPosition(...)
function boxArea(...)
```

Keep `TargetQuery` exported because `vision-analyze.ts` and the new extractor use it.

- [ ] **Step 4: Wire extraction in `vision-analyze.ts`**

Modify imports in `src/tools/vision-analyze.ts`:

```ts
import { extractKeyContent, shouldExtractKeyContent } from '../core/key-content-extractor.js';
```

After annotation detection and before `composeResult()`, build key content extraction:

```ts
            const target = options?.target as TargetQuery | undefined;
            const ocrProvider = providerOverrides.ocr ?? (provider.supportedSkills.includes('ocr') ? provider : undefined);
            const keyContentExtraction = shouldExtractKeyContent({
              target,
              intent,
              annotations,
              skillNames,
            })
              ? await extractKeyContent({
                image,
                target,
                intent,
                annotations,
                ocrData: skillResults.ocr?.data,
                ocrProvider,
              })
              : undefined;

            const composeOptions = {
              ...(annotations ? { annotations } : {}),
              ...(target ? { target } : {}),
              ...(keyContentExtraction ? { keyContentExtraction } : {}),
            };
```

Use this to replace the existing `target` and `composeOptions` block.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run --fileParallelism=false tests/key-content-extractor.test.ts tests/compose-result-heuristic.test.ts tests/vision-analyze-routing.test.ts`

Expected: PASS for all three test files.

- [ ] **Step 6: Commit Task 7**

Run:

```bash
git add src/core/skill-pipeline.ts src/tools/vision-analyze.ts tests/compose-result-heuristic.test.ts
git commit -m "feat: wire key content extraction into vision results"
```

---

### Task 8: Add Unit Suite Coverage And Optional TAPD Smoke

**Files:**
- Modify: `package.json`
- Test: optional local smoke command, no committed TAPD image required

- [ ] **Step 1: Add key-content test to unit suite**

Modify `package.json` `test:unit` script by adding `tests/key-content-extractor.test.ts` near `tests/annotation-detector.test.ts`:

```json
"test:unit": "vitest run --fileParallelism=false tests/provider-router.test.ts tests/planner-active-provider.test.ts tests/model-manager.test.ts tests/minicpm-provider.test.ts tests/smolvlm2-provider.test.ts tests/ppu-paddle-ocr-provider.test.ts tests/annotation-detector.test.ts tests/key-content-extractor.test.ts tests/provider-capabilities.test.ts tests/vision-analyze-routing.test.ts tests/vision-error-classification.test.ts tests/config.test.ts tests/options-propagation.test.ts tests/runtime-detector.test.ts tests/classify-skill.test.ts tests/skill-prompt-detail.test.ts tests/compose-result-heuristic.test.ts tests/llama-server-resolver.test.ts tests/llama-server-process-registry.test.ts tests/llama-server-stop.test.ts"
```

- [ ] **Step 2: Run unit suite**

Run: `pnpm test:unit`

Expected: PASS with the new `tests/key-content-extractor.test.ts` included.

- [ ] **Step 3: Run typecheck and build**

Run: `pnpm typecheck && pnpm build`

Expected: both commands exit 0.

- [ ] **Step 4: Run optional local TAPD smoke when image exists**

Run this command only if `/Users/jary/Desktop/tapd_48801209_base64_1782367293_865.png` exists:

```bash
node --input-type=module -e 'import {spawn} from "node:child_process"; import {readFileSync, existsSync} from "node:fs"; import {join} from "node:path"; const imagePath="/Users/jary/Desktop/tapd_48801209_base64_1782367293_865.png"; if(!existsSync(imagePath)){console.log("SKIP: TAPD image missing"); process.exit(0)} const serverScript=join(process.cwd(),"dist","index.js"); const img=readFileSync(imagePath).toString("base64"); const proc=spawn("node",[serverScript],{stdio:["pipe","pipe","pipe"],env:{...process.env,LOG_LEVEL:"error",VISION_OCR_PROVIDER:"ppu-paddle-ocr",VISION_REQUEST_TIMEOUT_MS:"120000"}}); let buffer=""; const responses=[]; function send(msg){proc.stdin.write(`${JSON.stringify(msg)}\n`)} function waitForResponse(id,timeoutMs=120000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`timeout waiting for ${id}`)),timeoutMs); const onData=()=>{const found=responses.find((msg)=>msg.id===id); if(found){clearTimeout(timer); proc.stdout.off("data",onData); resolve(found)}}; proc.stdout.on("data",onData); onData();});} proc.stdout.on("data",(chunk)=>{buffer+=chunk.toString(); const lines=buffer.split("\n"); buffer=lines.pop()??""; for(const line of lines){if(!line.trim()) continue; responses.push(JSON.parse(line));}}); proc.stderr.on("data",(chunk)=>process.stderr.write(chunk)); try{send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"key-content-smoke",version:"0.1.0"}}}); await waitForResponse(1,10000); send({jsonrpc:"2.0",method:"notifications/initialized"}); send({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"vision.analyze",arguments:{image:`data:image/png;base64,${img}`,intent:"提取红色虚线框中的内容",options:{cache:false,target:{color:"red",position:"right",description:"虚线红框中的内容"}}}}}); const response=await waitForResponse(2,120000); const target=response.result?.structuredContent?.result?.targetExtraction; console.log(JSON.stringify(target,null,2)); if(JSON.stringify(target).includes("默认附加价(元)")){throw new Error("outside header leaked into target extraction")} if(!JSON.stringify(target).includes("默认基础价-半份（元）")){throw new Error("missing merged first column title")} if(!JSON.stringify(target).includes("默认附加价-半份（元）")){throw new Error("missing merged second column title")} if(!JSON.stringify(target).includes("0.00 ¥")){throw new Error("missing normalized money cell")} } finally{proc.kill("SIGTERM");}'
```

Expected local smoke: printed target extraction includes table columns `默认基础价-半份（元）` and `默认附加价-半份（元）`, rows with `0.00 ¥`, and no `默认附加价(元)`.

- [ ] **Step 5: Commit Task 8**

Run:

```bash
git add package.json
git commit -m "test: include key content extraction unit suite"
```

---

## Final Verification

- [ ] Run `pnpm typecheck`

Expected: `tsc --noEmit` exits 0.

- [ ] Run `pnpm build`

Expected: `rm -rf dist && tsc && ...` exits 0 and copies `src/skills/*` to `dist/skills`.

- [ ] Run `pnpm test:unit`

Expected: all unit files pass, including `tests/key-content-extractor.test.ts`.

- [ ] If the TAPD image exists locally, run the optional smoke command in Task 8 Step 4.

Expected: no thrown error and target extraction contains the corrected two-column money table.

## Self-Review Notes

Spec coverage:

- Annotated regions: Tasks 2, 3, 6, 7.
- User-described regions: Tasks 1 and 2.
- Dense UI tables: Task 4.
- Region OCR enhancement: Task 5.
- Error handling: Tasks 5 and 6 include local OCR fallback.
- TAPD success criteria: Task 6 synthetic regression and Task 8 optional local smoke.

No placeholders remain. Function and type names are consistent across tasks: `shouldExtractKeyContent`, `resolveTargetRegion`, `extractOcrItems`, `itemsInsideRegion`, `enhanceRegionOcr`, `buildStructuredContent`, and `extractKeyContent`.
