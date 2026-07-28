# Phase A 验证报告

> 日期：2026-07-23
> 范围：UI 重建证据回灌与质量校准（A1-A4）

## 1. 实施概要

| 任务 | 状态 | 关键产出 |
|---|---|---|
| A3 源感知融合 | ✅ 完成 | `SourceVote` 类型、`mergeSourceVotes`、跨类型冲突标记 |
| A1 证据回灌 AST | ✅ 完成 | `ast-projection.ts`（`projectEvidenceToNodes` + `injectEvidenceIntoAst`）、orchestrator 接通 |
| A2 质量校准 | ✅ 完成 | `quality-metrics.ts`（`computeUnionArea` / `computeUnexplainedArea` / `computeCriticalElementCoverage`）、`computeQualityReport` 重构 |
| A4 标注 benchmark | ✅ 完成 | `annotation-loader.ts`、`ast-to-predictions.ts`、`ui-benchmark.ts --annotations` 模式 |

## 2. 代码质量验收

| 检查项 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 通过 |
| `pnpm lint` | ✅ 通过（无新 warning） |
| `pnpm build` | ✅ 通过（8 skills 复制到 dist） |
| `pnpm test:unit` | ✅ 333/333 通过 |
| UI 专项测试 | ✅ 362/362 通过（66 文件） |

## 3. 功能验收

### A1: 证据回灌
- balanced/high_fidelity 模式下，`analyzeUiPipeline` 后调用 `projectEvidenceToNodes` + `injectEvidenceIntoAst`
- AST 节点 `props.evidence` 被填充（IoU >= 0.3 的候选链接到节点）
- fast 模式不运行 hub，不注入 evidence（行为不变）
- **修复**：hub 现在同时注册 `structure.regions` 作为 CV 证据源（之前仅注册 `components`，而 legacy 提取器对多数图片返回 0 组件）。实测单图 evidence 节点数从 0 提升至 38/43

### A2: 质量报告
- `criticalElementCoverage`：不再恒为 0，基于 `CRITICAL_ELEMENT_TYPES`（交互元素 + 内容承载元素）的 evidence 覆盖率
- **修复 1**：`CRITICAL_ELEMENT_TYPES` 从仅 10 个交互类型扩展为 23 个（新增 `card`/`image`/`icon`/`text`/`table`/`row` 等内容承载类型）。之前 AST 仅含结构类型，覆盖率恒为 1（vacuously true）；实测 16 图分布 0.250-0.889
- **修复 2**：`unexplainedAreaRatio` 排除 `page` 根节点（其 bbox 恒为全图，导致并集 = 图面积，比率恒为 0）。修复后 16 图分布 0.011-0.878
- `unexplainedAreaRatio`：基于坐标压缩的 bbox 并集面积计算，有图时反映真实未覆盖面积
- 无图时 `unexplainedAreaRatio = 0` + `no-image-dimensions` warning

### A3: 源感知融合
- OCR 文本候选不与视觉组件候选跨类合并
- 同类型 CV + ui-detector 合并时 `sourceVotes` 包含两个来源
- 跨类型高 IoU 候选标记 `conflictReason` 而非抑制

### A4: 标注 benchmark
- `loadAnnotation`：解析 JSON 标注文件，验证必填字段
- `loadDataset`：递归扫描目录，自动配对 `.json` + 同名图片
- `astToPredictions`：过滤 `semantic-only` 节点，仅输出可匹配预测
- `ui-benchmark.ts --annotations <dir>`：加载标注 -> 运行分析 -> 计算 IoU/召回/精确率/F1
- 数据集目录结构 `benchmark/datasets/dev/{app,web,desktop}/` 已建立

## 4. 回归验收

| 指标 | 基线 | Phase A 后 |
|---|---|---|
| UI 专项测试 | 65 文件 / 354 tests | 66 文件 / 362 tests（+8 新增） |
| 单元测试 | 30 文件 / 333 tests | 30 文件 / 333 tests（无回归） |
| 16 图 benchmark | 78.7% coverage | 78.7% coverage（16/16 确定性，无回归） |
| fast 模式 | 不运行 hub | 不运行 hub（行为不变） |

## 5. 新增/修改文件

### 新增
- `src/ui-analysis/evidence/ast-projection.ts` - 证据投影到 AST 节点
- `src/ui-analysis/policy/quality-metrics.ts` - 关键元素覆盖率 + 未解释面积
- `src/ui-analysis/benchmark/annotation-loader.ts` - 标注文件加载器
- `src/ui-analysis/benchmark/ast-to-predictions.ts` - AST 转预测项
- `tests/ui-analysis/annotation-loader.test.ts` - 8 个测试
- `benchmark/datasets/README.md` - 数据集说明

### 修改
- `src/ui-analysis/evidence/types.ts` - `SourceVote`、`sourceVotes` 字段
- `src/ui-analysis/evidence/fusion-engine.ts` - 源感知合并 + 跨类型冲突标记
- `src/ui-analysis/evidence/index.ts` - 导出 `SourceVote`
- `src/ui-analysis/orchestrator.ts` - 证据回灌 + 质量报告新输入 + `collectRenderNodes` 扩展
- `src/ui-analysis/policy/types.ts` - `QualityReportInput`、`QualityReportNode` 类型
- `src/ui-analysis/policy/index.ts` - `computeQualityReport` 重构
- `src/ui-analysis/benchmark/index.ts` - 导出标注模块
- `tests/ui-analysis/policy-types.test.ts` - 新签名 + 新 helper 测试
- `scripts/ui-benchmark.ts` - `--annotations` 模式

## 6. 待办

- 16 张外卖 App 截图的人工标注（逐步补充到 `benchmark/datasets/dev/app/`）
- 标注完成后运行 `--annotations` 模式获取真实 recall/precision/F1
- 发布锁定集 150 张标注（按 annotation-spec 规模要求）
