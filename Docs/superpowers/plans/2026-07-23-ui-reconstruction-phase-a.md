# Phase A: 证据回灌 AST + 标注基准 + 源感知融合 + 质量校准

> 日期：2026-07-23
> 状态：执行中
> 前置：v0.5.0 基线已提交（`6161cd3`），P0-P4 设计已实现并验证

## 1. 背景与目标

v0.5.0 基线完成了分层 IR、证据融合引擎（EvidenceFusionEngine）、检测器中枢（DetectorHub）、ONNX/OmniParser 适配器和基准框架骨架。但深度审查发现四个关键缺口，阻碍从"骨架可用"到"准确率可量化"的跨越：

### 差距分析

| # | 差距 | 现状 | 影响 |
|---|---|---|---|
| G1 | **证据未回灌 AST** | `runDetectorHub` 产出 `hubCandidates`，但 `orchestrator.ts:339-343` 仅 `logger.debug`，AST 仍纯来自 legacy CV/OCR 路径 | 多源融合结果被丢弃，AST 无法获得检测器增强的置信度/类型/来源信息 |
| G2 | **质量报告占位指标** | `computeQualityReport` 硬编码 `criticalElementCoverage: 0`、`unexplainedAreaRatio: 0` | 质量报告无法反映真实复原质量，发布门槛无法自动校验 |
| G3 | **无真实标注 benchmark** | `scripts/ui-benchmark.ts` 仅无标注模式（coverage），`matchDetections`/`computeMetrics` 无标注加载器和数据集 | 无法量化召回率/精确率/F1，无法按平台达标验收 |
| G4 | **源感知融合不完整** | `fuseEvidence` 合并候选时丢失 OCR 文本与视觉组件的来源区分，`weightedMerge` 直接覆盖 text 字段 | OCR 高置信文本可能被低分视觉候选覆盖，融合后溯源困难 |

### Phase A 目标

1. **G1 修复**：将 DetectorHub 融合候选回灌 AST，为每个节点附加证据元数据（来源、置信度、匹配 IoU）。
2. **G2 修复**：真实计算 `criticalElementCoverage`（关键元素证据覆盖率）和 `unexplainedAreaRatio`（未解释面积比）。
3. **G3 修复**：建立标注加载器 + 数据集结构 + 扩展 benchmark 脚本，支持对 ground truth 计算 IoU/召回/F1。
4. **G4 修复**：源感知融合保留来源细分，OCR 文本候选与视觉组件候选不跨类合并。

### 非目标（Phase B/C）

- 真实 AssetPipeline（裁剪/哈希/落盘）→ Phase B
- 高频复合组件扩展（Card/ListItem/TabBar/Dialog）→ Phase B
- 按平台 benchmark 门槛接入外部模型（UI-DETR-1/icon_detect_v3/YOLO11s）→ Phase C

---

## 2. 任务分解

### A1: 证据回灌 AST（修复 G1）

**目标**：DetectorHub 融合候选不再被丢弃，而是匹配到 AST 节点并附加证据元数据。

#### A1.1 扩展 EvidenceCandidate 来源追踪

`src/ui-analysis/evidence/types.ts`:

```typescript
export interface SourceVote {
  source: EvidenceSource;
  score: number;
  type?: string;  // 该来源检测到的类型（可能与融合后类型不同）
}

export interface EvidenceCandidate {
  id: string;
  type: string;
  bbox: BBox;
  score: number;
  sources: EvidenceSource[];
  sourceVotes?: SourceVote[];   // NEW: 每来源的独立投票
  text?: string;
  state?: string;
  variant?: string;
  conflictReason?: string;
}
```

`sourceVotes` 是可选字段，保持向后兼容。融合引擎在 `weightedMerge` 时合并两方的 `sourceVotes`。

#### A1.2 证据投影函数

新增 `src/ui-analysis/evidence/ast-projection.ts`:

```typescript
export interface NodeEvidence {
  candidateId: string;
  sources: EvidenceSource[];
  score: number;
  matchIoU: number;
  sourceVotes?: SourceVote[];
  text?: string;
  state?: string;
}

export interface ProjectionOptions {
  iouThreshold: number;  // 默认 0.3（宽松匹配，因为 AST bbox 可能与检测框不完全对齐）
}

/**
 * 将融合候选匹配到 AST 节点，返回 nodeId -> NodeEvidence[] 映射。
 * 一个节点可能匹配多个候选（取最高 IoU）；一个候选最多匹配一个节点。
 */
export function projectEvidenceToNodes(
  candidates: EvidenceCandidate[],
  ast: SemanticAST,
  options?: ProjectionOptions,
): Map<string, NodeEvidence[]>;
```

匹配策略：
- 遍历 AST 所有节点，对每个节点找 IoU 最高的候选（类型相同时优先）
- 类型不同但 IoU ≥ 阈值时仍记录（作为类型冲突信号）
- 附加到 `node.props.evidence: NodeEvidence[]`（私有字段，不进入公开 CodegenIR/Figma 输出）

#### A1.3 Orchestrator 接通

`orchestrator.ts` 修改点：
- `runDetectorHub` 返回值改为同时返回候选和诊断信息（`DetectorResult[]`）
- 在 `analyzeUiPipeline` 之后、`computeQualityReport` 之前调用 `projectEvidenceToNodes`
- 将投影结果注入 `node.props.evidence`
- 诊断信息加入 `skipped` 追踪和 `recon.diagnostics`

**TDD 步骤**：
1. 测试 `projectEvidenceToNodes`：构造 3 节点 AST + 3 候选（2 匹配 + 1 不匹配），验证映射正确
2. 测试类型冲突：节点是 `button`，候选是 `input`，IoU≥0.3，验证记录 `conflictReason`
3. 测试多候选匹配：1 节点匹配 2 候选，验证取最高 IoU
4. 测试 orchestrator 集成：balanced 模式下 `node.props.evidence` 被填充
5. 测试 fast 模式：不运行 hub，`node.props.evidence` 不存在

---

### A2: 质量报告校准（修复 G2）

**目标**：`criticalElementCoverage` 和 `unexplainedAreaRatio` 反映真实数据。

#### A2.1 关键元素覆盖率

`criticalElementCoverage` = 有证据 backing 的关键元素节点数 / 关键元素节点总数

关键元素类型集合（`src/ui-analysis/policy/quality-metrics.ts`）：
```typescript
export const CRITICAL_ELEMENT_TYPES = new Set([
  'button', 'iconButton', 'input', 'textarea', 'select',
  'checkbox', 'radio', 'switch', 'link', 'tab',
]);
```

计算逻辑：
- 遍历 AST，收集所有 `type ∈ CRITICAL_ELEMENT_TYPES` 的节点
- 检查 `node.props.evidence` 是否非空（A1 注入）
- 覆盖率 = 有证据的关键节点 / 关键节点总数
- 无关键节点时返回 1.0（无关键元素可覆盖，视为满足）

#### A2.2 未解释面积比

`unexplainedAreaRatio` = 1 - (AST 节点 bbox 并集面积 / 图像总面积)

计算逻辑（`src/ui-analysis/policy/quality-metrics.ts`）：
```typescript
export function computeUnexplainedArea(
  nodes: Array<{ bbox: BBox }>,
  imageWidth: number,
  imageHeight: number,
): number;
```

- 对所有 AST 节点 bbox 求并集面积（扫描线算法，处理重叠）
- 图像总面积 = width × height
- 未解释比 = 1 - coveredArea / totalArea
- 仅计算叶子节点 + 半叶子容器（避免父容器面积重复计入）

#### A2.3 重构 computeQualityReport

```typescript
export interface QualityReportInput {
  nodes: Array<{ id: string; type: string; bbox: BBox; render: { mode: RenderMode } }>;
  totalNodes: number;
  imageWidth?: number;
  imageHeight?: number;
}

export function computeQualityReport(input: QualityReportInput): QualityReport;
```

- `criticalElementCoverage`：基于 A2.1
- `editableElementRatio`：保持现有逻辑（native + hybrid / total）
- `flattenedFallbackRatio`：保持现有逻辑（asset / total）
- `unexplainedAreaRatio`：基于 A2.2（需要 imageWidth/Height，无图时返回 0 + warning）
- `warnings`：加入"no-image-cannot-compute-area"等诊断

**TDD 步骤**：
1. 测试 `computeUnexplainedArea`：3 个不重叠 bbox，验证并集面积
2. 测试重叠 bbox：2 个重叠 50%，验证并集正确
3. 测试 `criticalElementCoverage`：3 按钮（2 有证据）→ 0.667
4. 测试无关键元素 → 1.0
5. 测试无图时 `unexplainedAreaRatio = 0` + warning
6. 测试 orchestrator 集成：质量报告数值非零

---

### A3: 源感知融合（修复 G4）

**目标**：融合保留来源细分，OCR 文本候选不与视觉组件候选跨类合并。

#### A3.1 融合引擎改进

`fusion-engine.ts` 修改：
- `weightedMerge` 合并 `sourceVotes`（按来源去重，取该来源最高分）
- 分组策略调整：`type === 'text'` 的候选单独分组，不与组件类型合并
- 跨类型高 IoU 候选标记 `conflictReason` 而非抑制

```typescript
function shouldMerge(a: EvidenceCandidate, b: EvidenceCandidate): boolean {
  // OCR text 候选不与视觉组件候选合并（即使 IoU 高）
  if (a.sources.includes('ocr') && !b.sources.includes('ocr')) return false;
  if (b.sources.includes('ocr') && !a.sources.includes('ocr')) return false;
  return a.type === b.type;
}
```

#### A3.2 来源投票填充

`runDetectorHub` 中构造候选时填充 `sourceVotes`：
```typescript
// CV 候选
{ ..., sources: ['cv'], sourceVotes: [{ source: 'cv', score: 0.7, type: c.type }] }
// OCR 候选
{ ..., sources: ['ocr'], sourceVotes: [{ source: 'ocr', score: 0.9, type: 'text' }] }
```

**TDD 步骤**：
1. 测试 OCR + CV 同位置不合并（保留两个候选）
2. 测试同类型 CV + ui-detector 合并，`sourceVotes` 包含两个来源
3. 测试跨类型高 IoU 标记 `conflictReason`
4. 回归测试：现有融合测试不破坏

---

### A4: 真实标注 benchmark（修复 G3）

**目标**：支持对 ground truth 标注计算 IoU/召回/精确率/F1，建立数据集结构。

#### A4.1 标注加载器

新增 `src/ui-analysis/benchmark/annotation-loader.ts`:

```typescript
export interface AnnotationFile {
  image: string;
  imageSize: { width: number; height: number };
  platform: 'app' | 'web' | 'desktop';
  theme: 'light' | 'dark';
  language: 'zh' | 'en' | 'mixed';
  dpi: 'standard' | 'high';
  elements: AnnotationElement[];
  relations: AnnotationRelation[];
  zOrder: Array<{ id: string; z: number }>;
  warnings: string[];
}

export interface AnnotationElement {
  id: string;
  type: string;
  semanticRole?: string;
  bbox: BBox;
  render: string;
  text?: string;
  variant?: string;
  control?: { family: string; state: string; shape?: string };
  labelNodeId?: string;
  children?: string[];
  backgroundAsset?: boolean;
  assetRegion?: { kind: string; allowFallback?: boolean };
}

export function loadAnnotation(filePath: string): AnnotationFile;
export function loadDataset(dir: string): Array<{ annotation: AnnotationFile; imagePath: string }>;
```

标注格式遵循 `Docs/02-contracts/05-annotation-spec.md`。

#### A4.2 AST -> 预测项转换

新增 `src/ui-analysis/benchmark/ast-to-predictions.ts`:

```typescript
export function astToPredictions(ast: SemanticAST): PredictedItem[] {
  // 遍历 AST，提取每个节点的 {id, type, bbox}
  // 过滤 semantic-only 节点（不参与匹配）
}
```

#### A4.3 扩展 benchmark 脚本

`scripts/ui-benchmark.ts` 增加 `--annotations <dir>` 选项：
- 有标注时：加载标注 + 运行分析 + `astToPredictions` + `computeMetrics`，输出 per-image 和 aggregate 召回/F1/per-type
- 无标注时：保持现有 coverage 模式

#### A4.4 数据集结构

```
benchmark/datasets/
  dev/                        # 开发集（60 张目标，Phase A 先放 16 张已有真实图）
    app/
      screenshot_001.png
      screenshot_001.json     # 标注文件
    web/
    desktop/
```

Phase A 先用现有 16 张外卖 App 截图建立 `dev/app/` 子集，标注文件后续逐步补充（标注本身是人工工作，不在代码任务范围内，但加载器和脚本必须就绪）。

**TDD 步骤**：
1. 测试 `loadAnnotation`：解析样例 JSON，验证字段完整
2. 测试 `loadDataset`：扫描目录，返回 image+annotation 对
3. 测试 `astToPredictions`：3 节点 AST → 3 PredictedItem（过滤 semantic-only）
4. 测试端到端：标注 + 预测 → MetricsReport（构造已知匹配）
5. 测试脚本运行：`--annotations` 模式无崩溃

---

## 3. 实施顺序与依赖

```
A3（源感知融合）──┐
                  ├──> A1（证据回灌）──> A2（质量校准）
A4.1-A4.2（标注）─┘                           │
                                               v
                                          A4.3（扩展脚本）
```

- A3 先行：改进融合引擎，使 A1 回灌的候选已有来源细分
- A1 依赖 A3：投影需要 `sourceVotes`
- A2 依赖 A1：质量报告需要 `node.props.evidence`
- A4 独立但与 A2 共享 metrics 模块

建议执行顺序：**A3 → A1 → A2 → A4**

---

## 4. 验收标准

### 代码质量
- `pnpm typecheck` 通过
- `pnpm lint` 通过（无新 warning）
- `pnpm build` 通过（skill 资产正确复制）
- `pnpm test:unit` 全绿（无回归）

### 功能验收
- balanced 模式下 AST 节点 `props.evidence` 被填充（至少关键元素类型）
- `qualityReport.criticalElementCoverage` 不再恒为 0
- `qualityReport.unexplainedAreaRatio` 在有图时反映真实未覆盖面积
- 融合引擎不跨类合并 OCR 文本与视觉组件
- benchmark 脚本 `--annotations` 模式可运行（即使标注为空也优雅降级）

### 回归验收
- 16 图 benchmark coverage 不退化（≥ 78.7% 基线）
- 现有 65 UI 专项测试 + 30 单元测试全绿
- fast 模式行为不变（不运行 hub，不注入 evidence）

---

## 5. 文件变更清单

### 新增
- `src/ui-analysis/evidence/ast-projection.ts` — 证据投影到 AST 节点
- `src/ui-analysis/policy/quality-metrics.ts` — 关键元素覆盖率 + 未解释面积
- `src/ui-analysis/benchmark/annotation-loader.ts` — 标注文件加载器
- `src/ui-analysis/benchmark/ast-to-predictions.ts` — AST 转预测项
- 对应测试文件（`*.test.ts`）

### 修改
- `src/ui-analysis/evidence/types.ts` — 新增 `SourceVote`、`sourceVotes` 字段
- `src/ui-analysis/evidence/fusion-engine.ts` — 源感知合并 + `sourceVotes` 填充
- `src/ui-analysis/orchestrator.ts` — 接通证据回灌 + 质量报告新输入
- `src/ui-analysis/policy/index.ts` — 重构 `computeQualityReport` 签名
- `src/ui-analysis/policy/types.ts` — `QualityReportInput` 类型
- `src/ui-analysis/evidence/index.ts` — 导出新模块
- `src/ui-analysis/benchmark/index.ts` — 导出新模块
- `scripts/ui-benchmark.ts` — `--annotations` 选项

### 文档
- `方案/08-phase-a-验证报告.md` — Phase A 验证记录（完成后创建）
