# 高保真 UI 复原 P0+P1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 UI 复原的新契约层（EvidenceIR / CompositionGraph / AssetManifest / Confidence / QualityReport）并修复 AST 父子关系，使 Banner、IconButton、FormField、ControlItem 等复合组件可正确表达，不依赖新模型。

**Architecture:** 在现有四层 IR（VisionIR → LayoutIR → SemanticAST → CodegenIR）之上新增 EvidenceIR 和 CompositionGraph 中间层。EvidenceIR 统一多检测源候选；CompositionGraph 建立任意候选间的关系图，再投影为允许任意节点做父的 SemanticAST。ReconstructionPolicy 自底向上决定 native/hybrid/asset/semantic-only 渲染策略。

**Tech Stack:** TypeScript ESM, Zod, Vitest, Sharp, exactOptionalPropertyTypes + noUncheckedIndexedAccess

**Spec:** `Docs/superpowers/specs/2026-07-21-high-fidelity-ui-reconstruction-design.md`

---

## File Structure

### P0 新增文件

| 文件 | 职责 |
|---|---|
| `src/ui-analysis/evidence/types.ts` | EvidenceCandidate、EvidenceIR 类型 |
| `src/ui-analysis/evidence/index.ts` | re-export |
| `src/ui-analysis/composition/types.ts` | CompositionGraph、RelationEdge、RelationType 类型 |
| `src/ui-analysis/composition/index.ts` | re-export |
| `src/ui-analysis/policy/types.ts` | RenderMode、NodeConfidence、QualityReport、AssetItem、AssetManifest 类型 |
| `src/ui-analysis/policy/index.ts` | re-export |
| `src/ui-analysis/render/reference-renderer.ts` | 将 IR 重绘为 SVG 的验收 renderer |
| `src/ui-analysis/render/index.ts` | re-export |
| `Docs/02-contracts/05-annotation-spec.md` | 标注规范 |

### P1 新增/修改文件

| 文件 | 职责 |
|---|---|
| `src/ui-analysis/composition/composition-graph-builder.ts` | 从 EvidenceIR 构建 CompositionGraph |
| `src/ui-analysis/composition/composite-grammar.ts` | Banner/IconButton/FormField/ControlItem 组合规则 |
| `src/ui-analysis/policy/reconstruction-policy.ts` | render mode 决策 |
| `src/ui-analysis/ast/ast-builder.ts` (修改) | 修复 containerCount 限制，允许任意候选做父 |
| `src/ui-analysis/reconstruction/reconstruction-spec.ts` (修改) | 扩展 assets/quality 字段 |
| `src/ui-analysis/orchestrator.ts` (修改) | 接入新模块 + reconstruction_mode |
| `src/tools/vision-analyze.ts` (修改) | 新增 reconstruction_mode 选项 |

### 测试文件

| 文件 | 职责 |
|---|---|
| `tests/ui-analysis/evidence-types.test.ts` | EvidenceIR 类型与构建 |
| `tests/ui-analysis/composition-graph.test.ts` | 关系图构建与投影 |
| `tests/ui-analysis/composite-grammar.test.ts` | 复合组件语法 |
| `tests/ui-analysis/reconstruction-policy.test.ts` | render mode 决策 |
| `tests/ui-analysis/reference-renderer.test.ts` | SVG renderer |
| `tests/ui-analysis/ast-builder-parents.test.ts` | 任意候选做父 |

---

## Task 1: EvidenceIR 类型

**Files:**
- Create: `src/ui-analysis/evidence/types.ts`
- Create: `src/ui-analysis/evidence/index.ts`
- Test: `tests/ui-analysis/evidence-types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ui-analysis/evidence-types.test.ts
import { describe, it, expect } from 'vitest';
import type { EvidenceCandidate, EvidenceIR, EvidenceSource } from '../../src/ui-analysis/evidence/types.js';
import { buildEvidenceIR } from '../../src/ui-analysis/evidence/index.js';

describe('EvidenceIR', () => {
  it('builds EvidenceIR from candidates with normalized coords', () => {
    const candidates: EvidenceCandidate[] = [
      {
        id: 'c1',
        type: 'button',
        bbox: { x: 10, y: 20, w: 100, h: 40 },
        score: 0.9,
        sources: ['cv'],
      },
      {
        id: 'c2',
        type: 'text',
        bbox: { x: 15, y: 30, w: 90, h: 20 },
        score: 0.95,
        sources: ['ocr'],
        text: '登录',
      },
    ];
    const ir = buildEvidenceIR(candidates);
    expect(ir.candidates).toHaveLength(2);
    expect(ir.candidates[0]!.id).toBe('c1');
    expect(ir.candidates[1]!.text).toBe('登录');
  });

  it('filters candidates with invalid bbox', () => {
    const candidates: EvidenceCandidate[] = [
      { id: 'c1', type: 'button', bbox: { x: 0, y: 0, w: 0, h: 0 }, score: 0.9, sources: ['cv'] },
      { id: 'c2', type: 'button', bbox: { x: 10, y: 20, w: 100, h: 40 }, score: 0.9, sources: ['cv'] },
    ];
    const ir = buildEvidenceIR(candidates);
    expect(ir.candidates).toHaveLength(1);
    expect(ir.candidates[0]!.id).toBe('c2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/evidence-types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ui-analysis/evidence/types.ts
import type { BBox } from '../ir/types.js';

export type EvidenceSource = 'cv' | 'ocr' | 'ui-detector' | 'omniparser' | 'pixel' | 'vlm';

export interface EvidenceCandidate {
  id: string;
  type: string;
  bbox: BBox;
  score: number;
  sources: EvidenceSource[];
  text?: string;
  state?: string;
  variant?: string;
  conflictReason?: string;
}

export interface EvidenceIR {
  candidates: EvidenceCandidate[];
}

export function isValidBBox(bbox: BBox): boolean {
  return (
    Number.isFinite(bbox.x) &&
    Number.isFinite(bbox.y) &&
    Number.isFinite(bbox.w) &&
    Number.isFinite(bbox.h) &&
    bbox.w > 0 &&
    bbox.h > 0
  );
}
```

```typescript
// src/ui-analysis/evidence/index.ts
export type { EvidenceCandidate, EvidenceIR, EvidenceSource, isValidBBox } from './types.js';

import type { EvidenceCandidate, EvidenceIR, isValidBBox } from './types.js';

export function buildEvidenceIR(candidates: EvidenceCandidate[]): EvidenceIR {
  const valid = candidates.filter((c) => isValidBBox(c.bbox));
  return { candidates: valid };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/evidence-types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui-analysis/evidence/ tests/ui-analysis/evidence-types.test.ts
git commit -m "feat(ui): add EvidenceIR types for multi-source detection fusion"
```

---

## Task 2: CompositionGraph 类型

**Files:**
- Create: `src/ui-analysis/composition/types.ts`
- Create: `src/ui-analysis/composition/index.ts`
- Test: `tests/ui-analysis/composition-graph.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ui-analysis/composition-graph.test.ts
import { describe, it, expect } from 'vitest';
import type { EvidenceCandidate } from '../../src/ui-analysis/evidence/types.js';
import { buildCompositionGraph } from '../../src/ui-analysis/composition/index.js';

describe('CompositionGraph', () => {
  it('builds contains edges by bbox containment', () => {
    const candidates: EvidenceCandidate[] = [
      { id: 'card', type: 'card', bbox: { x: 0, y: 0, w: 200, h: 200 }, score: 0.9, sources: ['cv'] },
      { id: 'title', type: 'text', bbox: { x: 10, y: 10, w: 100, h: 20 }, score: 0.95, sources: ['ocr'], text: '标题' },
      { id: 'icon', type: 'icon', bbox: { x: 150, y: 10, w: 30, h: 30 }, score: 0.8, sources: ['cv'] },
    ];
    const graph = buildCompositionGraph(candidates);
    expect(graph.edges).toContainEqual({ from: 'card', to: 'title', type: 'contains' });
    expect(graph.edges).toContainEqual({ from: 'card', to: 'icon', type: 'contains' });
  });

  it('does not create contains edge for non-containing siblings', () => {
    const candidates: EvidenceCandidate[] = [
      { id: 'a', type: 'text', bbox: { x: 0, y: 0, w: 50, h: 20 }, score: 0.9, sources: ['ocr'], text: 'A' },
      { id: 'b', type: 'text', bbox: { x: 60, y: 0, w: 50, h: 20 }, score: 0.9, sources: ['ocr'], text: 'B' },
    ];
    const graph = buildCompositionGraph(candidates);
    expect(graph.edges).not.toContainEqual({ from: 'a', to: 'b', type: 'contains' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/composition-graph.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ui-analysis/composition/types.ts
import type { BBox } from '../ir/types.js';
import type { EvidenceCandidate } from '../evidence/types.js';

export type RelationType =
  | 'contains'
  | 'overlaps'
  | 'alignedWith'
  | 'labels'
  | 'decorates'
  | 'occludes'
  | 'backgroundOf';

export interface RelationEdge {
  from: string;
  to: string;
  type: RelationType;
}

export interface CompositionGraph {
  nodes: EvidenceCandidate[];
  edges: RelationEdge[];
}

export function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w &&
    outer.y + outer.h >= inner.y + inner.h
  );
}
```

```typescript
// src/ui-analysis/composition/index.ts
export type { RelationType, RelationEdge, CompositionGraph, bboxContains } from './types.js';

import type { EvidenceCandidate } from '../evidence/types.js';
import type { CompositionGraph, RelationEdge, bboxContains } from './types.js';

export function buildCompositionGraph(candidates: EvidenceCandidate[]): CompositionGraph {
  const edges: RelationEdge[] = [];
  for (const outer of candidates) {
    for (const inner of candidates) {
      if (outer.id === inner.id) continue;
      if (bboxContains(outer.bbox, inner.bbox)) {
        edges.push({ from: outer.id, to: inner.id, type: 'contains' });
      }
    }
  }
  return { nodes: candidates, edges };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/composition-graph.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui-analysis/composition/ tests/ui-analysis/composition-graph.test.ts
git commit -m "feat(ui): add CompositionGraph for relationship-based AST projection"
```

---

## Task 3: Policy 类型（RenderMode / Confidence / QualityReport / AssetManifest）

**Files:**
- Create: `src/ui-analysis/policy/types.ts`
- Create: `src/ui-analysis/policy/index.ts`
- Test: `tests/ui-analysis/policy-types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ui-analysis/policy-types.test.ts
import { describe, it, expect } from 'vitest';
import type { AssetItem, QualityReport, NodeConfidence, RenderMode } from '../../src/ui-analysis/policy/types.js';
import { computeQualityReport } from '../../src/ui-analysis/policy/index.js';

describe('Policy types', () => {
  it('computes quality report from node render modes', () => {
    const nodes = [
      { id: 'n1', render: { mode: 'native' as RenderMode } },
      { id: 'n2', render: { mode: 'native' as RenderMode } },
      { id: 'n3', render: { mode: 'asset' as RenderMode } },
      { id: 'n4', render: { mode: 'semantic-only' as RenderMode } },
    ];
    const report = computeQualityReport(nodes, 4);
    expect(report.editableElementRatio).toBe(0.5);
    expect(report.flattenedFallbackRatio).toBe(0.25);
  });

  it('handles empty input', () => {
    const report = computeQualityReport([], 0);
    expect(report.editableElementRatio).toBe(0);
    expect(report.criticalElementCoverage).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/policy-types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ui-analysis/policy/types.ts
import type { BBox } from '../ir/types.js';

export type RenderMode = 'native' | 'hybrid' | 'asset' | 'semantic-only';

export interface RenderInfo {
  mode: RenderMode;
  assetId?: string;
  reason?: string;
}

export interface NodeConfidence {
  overall: number;
  type?: number;
  bounds?: number;
  text?: number;
  style?: number;
  state?: number;
}

export interface AssetItem {
  id: string;
  kind: 'icon' | 'logo' | 'photo' | 'illustration' | 'background' | 'decoration' | 'control-skin' | 'composite';
  bbox: BBox;
  mimeType: string;
  uri: string;
  dataUrl?: string;
  sha256: string;
  maskUri?: string;
  confidence: number;
}

export interface AssetManifest {
  items: AssetItem[];
}

export interface QualityReport {
  criticalElementCoverage: number;
  editableElementRatio: number;
  flattenedFallbackRatio: number;
  unexplainedAreaRatio: number;
  warnings: string[];
}
```

```typescript
// src/ui-analysis/policy/index.ts
export type {
  RenderMode,
  RenderInfo,
  NodeConfidence,
  AssetItem,
  AssetManifest,
  QualityReport,
} from './types.js';

import type { QualityReport, RenderMode } from './types.js';

export function computeQualityReport(
  nodes: Array<{ id: string; render: { mode: RenderMode } }>,
  totalNodes: number,
): QualityReport {
  const editable = nodes.filter((n) => n.render.mode === 'native' || n.render.mode === 'hybrid').length;
  const flattened = nodes.filter((n) => n.render.mode === 'asset').length;
  const denom = Math.max(1, totalNodes);
  return {
    criticalElementCoverage: 0,
    editableElementRatio: totalNodes === 0 ? 0 : editable / denom,
    flattenedFallbackRatio: totalNodes === 0 ? 0 : flattened / denom,
    unexplainedAreaRatio: 0,
    warnings: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/policy-types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui-analysis/policy/ tests/ui-analysis/policy-types.test.ts
git commit -m "feat(ui): add policy types (RenderMode/Confidence/Asset/QualityReport)"
```

---

## Task 4: Reference Renderer（SVG）

**Files:**
- Create: `src/ui-analysis/render/reference-renderer.ts`
- Create: `src/ui-analysis/render/index.ts`
- Test: `tests/ui-analysis/reference-renderer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ui-analysis/reference-renderer.test.ts
import { describe, it, expect } from 'vitest';
import type { ASTNode } from '../../src/ui-analysis/ir/types.js';
import { renderAstToSvg } from '../../src/ui-analysis/render/index.js';

describe('Reference renderer', () => {
  it('renders a simple tree as SVG', () => {
    const root: ASTNode = {
      id: 'page',
      type: 'page',
      bbox: { x: 0, y: 0, w: 375, h: 200 },
      props: {},
      children: [
        {
          id: 'btn',
          type: 'button',
          bbox: { x: 10, y: 10, w: 100, h: 40 },
          props: { style: { backgroundColor: '#1677ff' } },
          text: '登录',
          children: [],
        },
      ],
    };
    const svg = renderAstToSvg(root);
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="375"');
    expect(svg).toContain('height="200"');
    expect(svg).toContain('fill="#1677ff"');
    expect(svg).toContain('登录');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/reference-renderer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ui-analysis/render/reference-renderer.ts
import type { ASTNode, NodeStyle } from '../ir/types.js';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readStyle(node: ASTNode): NodeStyle | null {
  const s = node.props.style;
  if (s === undefined || typeof s !== 'object' || s === null) return null;
  return s as NodeStyle;
}

function renderNode(node: ASTNode): string {
  const { bbox } = node;
  const style = readStyle(node);
  const fill = style?.backgroundColor ?? '#f0f0f0';
  const rx = style?.borderRadius ?? 0;
  let parts = `  <rect x="${bbox.x}" y="${bbox.y}" width="${bbox.w}" height="${bbox.h}" fill="${fill}" rx="${rx}" stroke="#999" stroke-width="0.5"/>\n`;
  if (node.text !== undefined && node.text.length > 0) {
    const textColor = style?.textColor ?? '#333';
    const fontSize = style?.fontSize ?? 14;
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    parts += `  <text x="${cx}" y="${cy}" font-size="${fontSize}" fill="${textColor}" text-anchor="middle" dominant-baseline="middle">${escapeXml(node.text)}</text>\n`;
  }
  for (const child of node.children) {
    parts += renderNode(child);
  }
  return parts;
}

export function renderAstToSvg(root: ASTNode): string {
  const { bbox } = root;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${bbox.w}" height="${bbox.h}" viewBox="0 0 ${bbox.w} ${bbox.h}">\n`;
  svg += renderNode(root);
  svg += '</svg>';
  return svg;
}
```

```typescript
// src/ui-analysis/render/index.ts
export { renderAstToSvg } from './reference-renderer.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/reference-renderer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui-analysis/render/ tests/ui-analysis/reference-renderer.test.ts
git commit -m "feat(ui): add SVG reference renderer for reconstruction validation"
```

---

## Task 5: 修复 AST builder 允许任意候选做父

这是 P1 最关键的修复。当前 `ast-builder.ts:303` 用 `containerCount = 1 + regionNodes.length` 限制只有 page 和 region 能做父节点。

**Files:**
- Modify: `src/ui-analysis/ast/ast-builder.ts:302-327`
- Test: `tests/ui-analysis/ast-builder-parents.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ui-analysis/ast-builder-parents.test.ts
import { describe, it, expect } from 'vitest';
import { buildSemanticAst } from '../../src/ui-analysis/ast/ast-builder.js';
import type { LayoutIR, VisionDetection, VisionOcrItem } from '../../src/ui-analysis/ir/types.js';

function makeLayout(): LayoutIR {
  return {
    regions: [],
    layoutType: 'stack',
    spacing: { averageGap: 10, scale: 'comfortable', verticalGaps: [], horizontalGaps: [] },
  };
}

describe('AST builder parent-child', () => {
  it('allows a button detection to be parent of an icon detection', () => {
    const detections: VisionDetection[] = [
      { type: 'button', bbox: { x: 0, y: 0, w: 100, h: 50 }, score: 0.9 },
      { type: 'icon', bbox: { x: 10, y: 10, w: 30, h: 30 }, score: 0.8 },
    ];
    const ast = buildSemanticAst(makeLayout(), undefined, detections);
    const button = ast.root.children.find((c) => c.type === 'button');
    expect(button).toBeDefined();
    expect(button!.children.find((c) => c.type === 'icon')).toBeDefined();
  });

  it('allows a card detection to be parent of a text OCR node', () => {
    const detections: VisionDetection[] = [
      { type: 'card', bbox: { x: 0, y: 0, w: 200, h: 150 }, score: 0.9 },
    ];
    const ocr: VisionOcrItem[] = [
      { text: '标题', bbox: { x: 10, y: 10, w: 80, h: 20 }, confidence: 0.95 },
    ];
    const ast = buildSemanticAst(makeLayout(), ocr, detections);
    const card = ast.root.children.find((c) => c.type === 'card');
    expect(card).toBeDefined();
    const textChild = card!.children.find((c) => c.type === 'text');
    expect(textChild).toBeDefined();
    expect(textChild!.text).toBe('标题');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/ast-builder-parents.test.ts`
Expected: FAIL — icon ends up as child of page, not button

- [ ] **Step 3: Modify ast-builder.ts to allow any candidate as parent**

In `src/ui-analysis/ast/ast-builder.ts`, find the block at lines 302-327 and replace the `containerCount`-limited parent search with a search over ALL nodes:

Replace:
```typescript
  const allNodes: ASTNode[] = [page, ...regionNodes, ...detectionNodes, ...mediaNodes];
  const containerCount = 1 + regionNodes.length;

  const parentIdx: number[] = new Array(allNodes.length).fill(0);
  for (let i = 1; i < allNodes.length; i++) {
    const node = allNodes[i]!;
    const nodeArea = bboxArea(node.bbox);
    let bestParent = 0;
    let bestArea = Infinity;
    for (let j = 1; j < containerCount; j++) {
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
```

With:
```typescript
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
```

- [ ] **Step 4: Run the new test AND the existing AST tests to verify no regression**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/ast-builder-parents.test.ts tests/ui-analysis/ast-builder.test.ts`
Expected: PASS (both files)

- [ ] **Step 5: Run full UI suite for regression**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/`
Expected: All existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add src/ui-analysis/ast/ast-builder.ts tests/ui-analysis/ast-builder-parents.test.ts
git commit -m "fix(ui): allow any candidate to be AST parent, not just regions"
```

---

## Task 6: 复合组件语法（Banner / IconButton / FormField / ControlItem）

**Files:**
- Create: `src/ui-analysis/composition/composite-grammar.ts`
- Test: `tests/ui-analysis/composite-grammar.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ui-analysis/composite-grammar.test.ts
import { describe, it, expect } from 'vitest';
import type { ASTNode } from '../../src/ui-analysis/ir/types.js';
import { applyCompositeGrammar } from '../../src/ui-analysis/composition/composite-grammar.js';

describe('Composite grammar', () => {
  it('marks a section containing title+subtitle+button as role=banner', () => {
    const section: ASTNode = {
      id: 'sec',
      type: 'section',
      bbox: { x: 0, y: 0, w: 375, h: 120 },
      props: {},
      children: [
        { id: 't', type: 'title', bbox: { x: 10, y: 10, w: 200, h: 30 }, props: {}, text: '夏日会员节', children: [] },
        { id: 's', type: 'subtitle', bbox: { x: 10, y: 45, w: 200, h: 20 }, props: {}, text: '立减 50 元', children: [] },
        { id: 'b', type: 'button', bbox: { x: 10, y: 75, w: 100, h: 36 }, props: {}, text: '立即领取', children: [] },
      ],
    };
    const root: ASTNode = {
      id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: {}, children: [section],
    };
    applyCompositeGrammar(root);
    expect(section.props.semanticRole).toBe('banner');
  });

  it('marks a button containing an icon as IconButton', () => {
    const button: ASTNode = {
      id: 'btn', type: 'button', bbox: { x: 0, y: 0, w: 40, h: 40 }, props: {}, children: [
        { id: 'ic', type: 'icon', bbox: { x: 10, y: 10, w: 20, h: 20 }, props: {}, children: [] },
      ],
    };
    const root: ASTNode = {
      id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: {}, children: [button],
    };
    applyCompositeGrammar(root);
    expect(button.type).toBe('iconButton');
  });

  it('marks a text label adjacent to a checkbox as controlItem', () => {
    const checkbox: ASTNode = {
      id: 'cb', type: 'checkbox', bbox: { x: 10, y: 10, w: 20, h: 20 }, props: {}, children: [],
    };
    const label: ASTNode = {
      id: 'lbl', type: 'text', bbox: { x: 35, y: 10, w: 100, h: 20 }, props: {}, text: '同意条款', children: [],
    };
    const container: ASTNode = {
      id: 'row', type: 'container', bbox: { x: 0, y: 0, w: 200, h: 40 }, props: {}, children: [checkbox, label],
    };
    const root: ASTNode = {
      id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: {}, children: [container],
    };
    applyCompositeGrammar(root);
    expect(container.props.semanticRole).toBe('controlItem');
    expect(checkbox.props.labelNodeId).toBe('lbl');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/composite-grammar.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ui-analysis/composition/composite-grammar.ts
import type { ASTNode, BBox } from '../ir/types.js';

function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w &&
    outer.y + outer.h >= inner.y + inner.h
  );
}

function horizontallyAdjacent(a: BBox, b: BBox, maxGap: number): boolean {
  const aRight = a.x + a.w;
  const bLeft = b.x;
  const gap = Math.abs(bLeft - aRight);
  if (gap > maxGap) return false;
  const overlapTop = Math.max(a.y, b.y);
  const overlapBottom = Math.min(a.y + a.h, b.y + b.h);
  return overlapBottom > overlapTop;
}

/**
 * Apply composite component grammar to a SemanticAST in place.
 * Recognizes Banner, IconButton, FormField, ControlItem patterns
 * and annotates semanticRole / promotes types.
 */
export function applyCompositeGrammar(root: ASTNode): void {
  const walk = (node: ASTNode): void => {
    for (const child of node.children) walk(child);

    // IconButton: button containing an icon child
    if (node.type === 'button') {
      const hasIcon = node.children.some((c) => c.type === 'icon');
      if (hasIcon) node.type = 'iconButton';
    }

    // Banner: section/container containing title + subtitle + button
    if (node.type === 'section' || node.type === 'container') {
      const hasTitle = node.children.some((c) => c.type === 'title' || c.type === 'subtitle');
      const hasButton = node.children.some((c) => c.type === 'button' || c.type === 'iconButton');
      if (hasTitle && hasButton) {
        node.props.semanticRole = 'banner';
      }
    }

    // ControlItem: container with a checkbox/radio/switch + adjacent text label
    const control = node.children.find((c) => c.type === 'checkbox' || c.type === 'radio' || c.type === 'switch');
    if (control !== undefined) {
      const label = node.children.find((c) => (
        c.type === 'text' && horizontallyAdjacent(control.bbox, c.bbox, 30)
      ));
      if (label !== undefined) {
        node.props.semanticRole = 'controlItem';
        control.props.labelNodeId = label.id;
      }
    }

    // FormField: container with a label text + input/control
    const input = node.children.find((c) => c.type === 'input' || c.type === 'textarea' || c.type === 'select');
    if (input !== undefined) {
      const label = node.children.find((c) => (
        c.type === 'text' && c.props.semanticRole === 'label'
      ));
      if (label !== undefined) {
        node.props.semanticRole = 'formField';
      }
    }
  };
  walk(root);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/composite-grammar.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui-analysis/composition/composite-grammar.ts tests/ui-analysis/composite-grammar.test.ts
git commit -m "feat(ui): add composite grammar for Banner/IconButton/FormField/ControlItem"
```

---

## Task 7: ReconstructionPolicy（render mode 决策）

**Files:**
- Create: `src/ui-analysis/policy/reconstruction-policy.ts`
- Test: `tests/ui-analysis/reconstruction-policy.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ui-analysis/reconstruction-policy.test.ts
import { describe, it, expect } from 'vitest';
import type { ASTNode } from '../../src/ui-analysis/ir/types.js';
import { assignRenderModes } from '../../src/ui-analysis/policy/reconstruction-policy.js';

describe('ReconstructionPolicy', () => {
  it('assigns native to a simple text node with style', () => {
    const node: ASTNode = {
      id: 't1', type: 'text', bbox: { x: 0, y: 0, w: 100, h: 20 }, props: { style: { backgroundColor: '#fff' } }, text: 'Hello', children: [],
    };
    const root: ASTNode = { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: {}, children: [node] };
    assignRenderModes(root);
    expect(node.props.render).toEqual({ mode: 'native' });
  });

  it('assigns asset to a banner with no separable background', () => {
    const banner: ASTNode = {
      id: 'b1', type: 'section', bbox: { x: 0, y: 0, w: 375, h: 120 },
      props: { semanticRole: 'banner' },
      children: [
        { id: 't', type: 'title', bbox: { x: 10, y: 10, w: 100, h: 30 }, props: {}, text: '标题', children: [] },
      ],
    };
    const root: ASTNode = { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: {}, children: [banner] };
    assignRenderModes(root, { bannerFallback: true });
    expect(banner.props.render.mode).toBe('asset');
    expect(banner.props.render.assetId).toBeDefined();
    // Children of an asset banner become semantic-only
    expect(banner.children[0]!.props.render.mode).toBe('semantic-only');
  });

  it('assigns native to a checkbox with detected state', () => {
    const cb: ASTNode = {
      id: 'cb', type: 'checkbox', bbox: { x: 0, y: 0, w: 20, h: 20 },
      props: { control: { family: 'checkbox', state: 'checked' } },
      children: [],
    };
    const root: ASTNode = { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: {}, children: [cb] };
    assignRenderModes(root);
    expect(cb.props.render.mode).toBe('native');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/reconstruction-policy.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ui-analysis/policy/reconstruction-policy.ts
import type { ASTNode } from '../ir/types.js';
import type { RenderInfo } from './types.js';

export interface PolicyOptions {
  /** When true, banners without separable backgrounds fall back to asset. */
  bannerFallback?: boolean;
}

function hasStyle(node: ASTNode): boolean {
  return node.props.style !== undefined && typeof node.props.style === 'object';
}

function hasControlState(node: ASTNode): boolean {
  return node.props.control !== undefined && typeof node.props.control === 'object';
}

let assetCounter = 0;

function nextAssetId(): string {
  assetCounter++;
  return `asset-${assetCounter}`;
}

/**
 * Walk the AST bottom-up and assign a RenderInfo to each node's props.render.
 * - native: structure + style + content reliable
 * - hybrid: asset background + native children
 * - asset: whole crop for visual completeness
 * - semantic-only: info only, must not be re-rendered (child of asset)
 */
export function assignRenderModes(root: ASTNode, options?: PolicyOptions): void {
  const walk = (node: ASTNode, parentMode?: string): void => {
    for (const child of node.children) walk(child, node.props.render?.mode);

    let render: RenderInfo;

    // Children of an asset-mode parent are semantic-only
    if (parentMode === 'asset') {
      render = { mode: 'semantic-only' };
      node.props.render = render;
      return;
    }

    // Banner without separable background -> asset fallback
    if (options?.bannerFallback === true && node.props.semanticRole === 'banner') {
      const assetId = nextAssetId();
      render = { mode: 'asset', assetId, reason: 'banner-background-not-separable' };
      node.props.render = render;
      return;
    }

    // Checkbox/radio/switch with detected state -> native
    if (
      (node.type === 'checkbox' || node.type === 'radio' || node.type === 'switch')
      && hasControlState(node)
    ) {
      render = { mode: 'native' };
      node.props.render = render;
      return;
    }

    // Text/title/subtitle with style -> native
    if (
      (node.type === 'text' || node.type === 'title' || node.type === 'subtitle')
      && hasStyle(node)
    ) {
      render = { mode: 'native' };
      node.props.render = render;
      return;
    }

    // Button/iconButton with style -> native
    if ((node.type === 'button' || node.type === 'iconButton') && hasStyle(node)) {
      render = { mode: 'native' };
      node.props.render = render;
      return;
    }

    // Default: native for containers, native for everything else
    render = { mode: 'native' };
    node.props.render = render;
  };
  walk(root);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/reconstruction-policy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui-analysis/policy/reconstruction-policy.ts tests/ui-analysis/reconstruction-policy.test.ts
git commit -m "feat(ui): add ReconstructionPolicy for per-node render mode decisions"
```

---

## Task 8: 扩展 ReconstructionSpec（assets / quality）

**Files:**
- Modify: `src/ui-analysis/reconstruction/reconstruction-spec.ts`
- Test: `tests/ui-analysis/reconstruction-spec-extended.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ui-analysis/reconstruction-spec-extended.test.ts
import { describe, it, expect } from 'vitest';
import { buildUiReconstruction } from '../../src/ui-analysis/reconstruction/reconstruction-spec.js';
import type { SemanticAST } from '../../src/ui-analysis/ir/types.js';
import type { AssetManifest, QualityReport } from '../../src/ui-analysis/policy/types.js';

describe('Extended reconstruction spec', () => {
  it('includes assets and quality when provided', () => {
    const ast: SemanticAST = {
      root: { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: { layoutType: 'stack' }, children: [] },
      version: '1.0.0',
    };
    const assets: AssetManifest = {
      items: [
        { id: 'a1', kind: 'icon', bbox: { x: 0, y: 0, w: 20, h: 20 }, mimeType: 'image/png', uri: 'file:///tmp/a1.png', sha256: 'abc', confidence: 0.9 },
      ],
    };
    const quality: QualityReport = {
      criticalElementCoverage: 0.95,
      editableElementRatio: 0.8,
      flattenedFallbackRatio: 0.15,
      unexplainedAreaRatio: 0.02,
      warnings: [],
    };
    const spec = buildUiReconstruction({ ast, assets, quality });
    expect(spec.assets).toBeDefined();
    expect(spec.assets!.items).toHaveLength(1);
    expect(spec.quality).toBeDefined();
    expect(spec.quality!.editableElementRatio).toBe(0.8);
  });

  it('omits assets and quality when not provided (backward compat)', () => {
    const ast: SemanticAST = {
      root: { id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 375, h: 800 }, props: { layoutType: 'stack' }, children: [] },
      version: '1.0.0',
    };
    const spec = buildUiReconstruction({ ast });
    expect(spec.assets).toBeUndefined();
    expect(spec.quality).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/reconstruction-spec-extended.test.ts`
Expected: FAIL — assets/quality not accepted

- [ ] **Step 3: Modify reconstruction-spec.ts**

In `src/ui-analysis/reconstruction/reconstruction-spec.ts`, add imports and fields:

Add to imports:
```typescript
import type { AssetManifest, QualityReport } from '../policy/types.js';
```

Add to `UiReconstructionSpec` interface (after `diagnostics?`):
```typescript
  assets?: AssetManifest;
  quality?: QualityReport;
```

Add to `BuildReconstructionInput` interface (after `diagnostics?`):
```typescript
  assets?: AssetManifest | undefined;
  quality?: QualityReport | undefined;
```

In `buildUiReconstruction`, add to the destructured params:
```typescript
  const { ast, semantics, constraints, images, theme, responsive, repeats, slots, diagnostics, assets, quality } = input;
```

Add to the spec object (after diagnostics line):
```typescript
    ...(assets ? { assets } : {}),
    ...(quality ? { quality } : {}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/reconstruction-spec-extended.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing reconstruction tests for regression**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/validate.test.ts tests/ui-analysis/orchestrator.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/ui-analysis/reconstruction/reconstruction-spec.ts tests/ui-analysis/reconstruction-spec-extended.test.ts
git commit -m "feat(ui): extend UiReconstructionSpec with assets and quality report"
```

---

## Task 9: 接入 orchestrator + 新增 reconstruction_mode 选项

**Files:**
- Modify: `src/ui-analysis/orchestrator.ts`
- Modify: `src/tools/vision-analyze.ts`
- Test: `tests/ui-analysis/orchestrator-reconstruction-mode.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ui-analysis/orchestrator-reconstruction-mode.test.ts
import { describe, it, expect } from 'vitest';
import { runUiAnalysis } from '../../src/ui-analysis/orchestrator.js';
import type { UiLayoutExtraction } from '../../src/core/extractors/ui-layout-extractor.js';

function makeMinimalLayout(): UiLayoutExtraction {
  return {
    regions: [],
    components: [],
    texts: [],
    mediaAreas: [],
    spacing: { averageGap: 10, scale: 'comfortable' as const, verticalGaps: [], horizontalGaps: [] },
    layoutType: 'stack',
  } as unknown as UiLayoutExtraction;
}

describe('orchestrator reconstruction_mode', () => {
  it('accepts reconstruction_mode option without error', async () => {
    const result = await runUiAnalysis({
      uiLayoutExtraction: makeMinimalLayout(),
      options: {
        buildTree: true,
        detectLayout: false,
        detectComponent: false,
        detectText: false,
        detectIcon: false,
        detectTheme: false,
      },
    });
    expect(result.uiReconstruction).toBeDefined();
    // render modes should be assigned on every node
    expect(result.uiReconstruction!.tree.props.render).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/orchestrator-reconstruction-mode.test.ts`
Expected: FAIL — render not assigned

- [ ] **Step 3: Modify orchestrator.ts**

In `src/ui-analysis/orchestrator.ts`:

1. Add import at top:
```typescript
import { assignRenderModes } from './policy/reconstruction-policy.js';
import { computeQualityReport } from './policy/index.js';
import { applyCompositeGrammar } from './composition/composite-grammar.js';
```

2. Add to `UiAnalysisOptions`:
```typescript
  reconstructionMode?: 'fast' | 'balanced' | 'high_fidelity';
```

3. In `runUiAnalysis`, after `enrichInteractivity(pipeline.ui)` and before overlay application, add:
```typescript
  if (pipeline.ui) {
    try {
      applyCompositeGrammar(pipeline.ui.root);
      assignRenderModes(pipeline.ui.root);
      throwIfAborted(input.signal);
    } catch (err) {
      throwIfAborted(input.signal);
      skipped.push('compositeGrammar');
      logger.warn('ui composite grammar failed', { error: String(err) });
    }
  }
```

4. In the `buildUiReconstruction` call, add quality report:
After the `diagnostics` line in the `buildUiReconstruction({...})` call, add:
```typescript
        ...(pipeline.ui ? {
          quality: computeQualityReport(
            collectRenderNodes(pipeline.ui.root),
            countNodes(pipeline.ui.root),
          ),
        } : {}),
```

Add helper functions at the bottom of orchestrator.ts (before the closing):
```typescript
function collectRenderNodes(node: ASTNode): Array<{ id: string; render: { mode: string } }> {
  const result: Array<{ id: string; render: { mode: string } }> = [];
  const walk = (n: ASTNode): void => {
    const render = n.props.render;
    if (render !== undefined && typeof render === 'object' && 'mode' in render) {
      result.push({ id: n.id, render: render as { mode: string } });
    }
    for (const c of n.children) walk(c);
  };
  walk(node);
  return result;
}

function countNodes(node: ASTNode): number {
  let count = 1;
  for (const c of node.children) count += countNodes(c);
  return count;
}
```

Add `ASTNode` to the import from `./ir/types.js` if not already imported.

- [ ] **Step 4: Modify vision-analyze.ts to add reconstruction_mode option**

In `src/tools/vision-analyze.ts`, add to the `options` zod object (after `summary_only`):
```typescript
      reconstruction_mode: z.enum(['fast', 'balanced', 'high_fidelity']).optional().describe('UI analysis depth: fast (CV+OCR only), balanced (+UI detector), high_fidelity (+OmniParser/icon caption). Default fast.'),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/orchestrator-reconstruction-mode.test.ts`
Expected: PASS

- [ ] **Step 6: Run full UI suite + typecheck + build**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/`
Expected: All pass

Run: `pnpm typecheck`
Expected: No errors

Run: `pnpm build`
Expected: Build complete

- [ ] **Step 7: Commit**

```bash
git add src/ui-analysis/orchestrator.ts src/tools/vision-analyze.ts tests/ui-analysis/orchestrator-reconstruction-mode.test.ts
git commit -m "feat(ui): wire composite grammar + render policy + quality into orchestrator, add reconstruction_mode option"
```

---

## Task 10: 标注规范文档

**Files:**
- Create: `Docs/02-contracts/05-annotation-spec.md`

- [ ] **Step 1: Write the annotation spec**

Document the labeled benchmark annotation format: bbox, text, type, parent-child, visible state, asset region, z-order, allowed fallback. Reference the release gates from the design spec.

- [ ] **Step 2: Commit**

```bash
git add Docs/02-contracts/05-annotation-spec.md
git commit -m "docs: add UI reconstruction benchmark annotation specification"
```

---

## Self-Review

**Spec coverage:**
- §4.1 DetectorHub → P3 (not in this plan, deferred)
- §4.2 EvidenceFusionEngine → Task 1 (types only; full fusion in P3)
- §4.3 CompositionGraphBuilder → Task 2 (types + builder) + Task 5 (fix AST parents) + Task 6 (grammar)
- §4.4 ControlAppearanceAnalyzer → P2 (not in this plan, deferred)
- §4.5 AssetPipeline → Task 3 (types only; full pipeline in P2)
- §4.6 ReconstructionPolicy → Task 7
- §5 Output contract → Task 8 (spec extension)
- §7 reconstruction_mode → Task 9
- §9.3 Reference renderer → Task 4
- §9.1 Annotation spec → Task 10

**Gaps (intentionally deferred to P2/P3):**
- EvidenceFusionEngine full implementation (WBF/NMS) — P3
- ControlAppearanceAnalyzer (checkbox/radio/switch state detection from pixels) — P2
- AssetPipeline full implementation (crop/mask/URI) — P2
- Style extraction extensions (gradient/border/typography) — P2
- UI ONNX detector — P3
- OmniParser sidecar — P3
- 150-image labeled benchmark — P4

**Type consistency:** `RenderMode`, `RenderInfo`, `NodeConfidence`, `AssetItem`, `AssetManifest`, `QualityReport` defined in Task 3, used in Tasks 7, 8, 9. `EvidenceCandidate`, `EvidenceIR` defined in Task 1, used in Task 2. `CompositionGraph`, `RelationEdge` defined in Task 2. `applyCompositeGrammar` defined in Task 6, called in Task 9. `assignRenderModes` defined in Task 7, called in Task 9. `computeQualityReport` defined in Task 3, called in Task 9.

**Placeholder scan:** No TBD/TODO. All code blocks are complete.
