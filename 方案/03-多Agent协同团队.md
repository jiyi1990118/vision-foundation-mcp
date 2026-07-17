# Vision UI 分析引擎 - 多 Agent 协同团队设计

> 基于 [`02-开发实施方案.md`](./02-开发实施方案.md) 的 Stream S0–S6，设计一套**接口优先、契约冻结、分波次并行**的多 Agent 协同团队。
> 团队基于 opencode 的 Task 子代理（`general` / `research` / `explore`）派发，由 Lead 统一协调。

---

## 1. 协同原则

1. **接口优先（Interface-First）**：S0（IR 契约）必须先冻结，下游 S1–S4 才能并行，避免返工。
2. **契约即边界**：`src/ui-analysis/ir/types.ts` + `schema/*.json` 是所有 Agent 的共享边界，冻结后只允许 Lead 批准的扩展。
3. **只读勘验、按规约写**：每个 Agent 必须先读指定的现有文件（含 file:line），再按规约产出，禁止臆造。
4. **绿线检查**：每波结束 `pnpm typecheck` + `pnpm test:unit` 必须全绿，Lead 检查 git diff 后放行下一波。
5. **不动存量**：现有 `ui-layout-extractor.ts` / `design-extractor.ts` / `vision.analyze` 契约，**只加适配器，不重写**。
6. **关键路径自留**：S0 契约虽可派发，但 Lead 复核；高风险集成（S4）由 Lead 主导。

---

## 2. 团队编制

| 角色 | subagent_type | 负责Stream | 核心职责 | 产出位置 |
|------|--------------|----------|---------|---------|
| **Lead 架构师** | (主控) | 协调 + S0 复核 | 契约冻结、派发、review、放行、集成兜底 | 全局 |
| **契约 Agent** | `general` | S0 | 四层 IR 类型 + Schema + 适配器 mapper | `src/ui-analysis/ir/` |
| **引擎 Agent** | `general` | S1 | AST Builder / Relationship / Constraint / Typography | `src/ui-analysis/{ast,relationship,constraint,typography}/` |
| **重构 Agent** | `general` | S2 | 统一 Trait 接口 + 存量适配类 | `src/ui-analysis/plugin/` |
| **导出 Agent** | `general` | S3 | Codegen IR / Figma JSON / Markdown 导出 | `src/ui-analysis/exporter/` |
| **集成 Agent** | `general` | S4 | Skill 三件套 + vision-analyze 接线 + 向后兼容 | `src/skills/analyze-ui/` + `src/tools/` |
| **质量 Agent** | `general` | S5 | 单测 + Benchmark + 回归 | `tests/ui-analysis/` + `scripts/` |
| **调研 Agent** | `research` | S6 | Figma 规范 / YOLO·Rico·SAM2 可行性 | `方案/调研-note.md` |

> 说明：`explore` 子代理用于 Lead 在派发前的快速代码定位（已在方案制定阶段使用）。`general` 承载绝大多数工程任务。

---

## 3. 派发波次与依赖图

```
Wave 1（无依赖，立即启动）
   ├─ S0  契约 Agent (general)        ── IR 类型 + Schema + mapper
   └─ S6  调研 Agent (research)      ── Figma/YOLO 调研笔记
        │
        ▼  S0 冻结（Lead review + typecheck 绿）后放行
Wave 2（依赖 S0，内部可并行）
   ├─ S1  引擎 Agent (general)        ── AST/Relationship/Constraint/Typography
   └─ S2  重构 Agent (general)        ── 统一 Trait + 存量适配
        │
        ▼  S1 完成
Wave 3（依赖 S1，S2 可先就位）
   ├─ S3  导出 Agent (general)        ── Codegen/Figma/Markdown
   └─ S4  集成 Agent (general)        ── Skill + vision-analyze 接线
        │
        ▼  S3/S4 完成
Wave 4
   └─ S5  质量 Agent (general)        ── 单测 + Benchmark + 回归
        │
        ▼  （可选）
   └─ UI-6 基于 S6 决策是否接入 YOLO
```

---

## 4. Agent 任务规约（派发时逐条写入 prompt）

### 4.1 契约 Agent（S0）— Wave 1

**必读**（先读再写）：
- `src/core/extractors/ui-layout-extractor.ts`（`UiLayoutExtraction` 接口，第 83–94 行；`ComponentType`/`VisualRegion`）
- `src/core/extractors/design-extractor.ts`（`DesignExtraction`，第 22–31 行）
- `src/types/domain.ts`（`UiLayoutBlock`/`BBox`/`UiComponentEntry`，第 152–191 行）
- `src/core/annotation-detector.ts`（CV 基础，了解 Mask/Box 形态）

**产出**：
1. `src/ui-analysis/ir/types.ts`：`VisionIR` / `LayoutIR` / `SemanticAST`（含 30+ 组件类型枚举）/ `CodegenIR`
2. `src/ui-analysis/ir/mappers.ts`：`UiLayoutExtraction -> VisionIR`、`UiLayoutExtraction -> LayoutIR`、`DesignExtraction -> LayoutIR.theme` 的薄适配器
3. `src/ui-analysis/ir/schema/{vision_ir,layout_ir,semantic_ast,codegen_ir}.schema.json`

**铁律**：
- 只新增文件，**不改任何现有类型**；`pnpm typecheck` 必须通过
- IR 字段命名对齐现有（`bbox: {x,y,w,h}`、`layoutType` 枚举含现有 6 类）
- mapper 纯函数、可单测

**验收**：`pnpm typecheck` 绿；mapper 单测 1 条（`UiLayoutExtraction -> VisionIR` round-trip）

---

### 4.2 调研 Agent（S6）— Wave 1（并行）

**产出**：`方案/调研-note.md`，含：
1. **Figma JSON 节点规范**：`Frame`/`Rectangle`/`Text`/`Component` 节点结构、`absoluteBoundingBox`、`fills`、约束字段--供 S3 Figma 导出对齐
2. **YOLO·Rico 可行性**：Rico 数据集规模/许可、YOLOv11 微调流程、模型体积、GPU 推理延迟、CPU 可否退化
3. **SAM2 / GroundingDINO**：集成方式（Python sidecar vs WASM）、成本、是否值得纳入 UI-6

**铁律**：基于最新公开资料，标注来源与日期；给出"推荐/不推荐 + 理由"

**验收**：笔记可直接作为 S3/UI-6 决策输入

---

### 4.3 引擎 Agent（S1）— Wave 2

**必读**：S0 产出（`ir/types.ts`）+ `ui-layout-extractor.ts`（区域/组件检测逻辑）+ `universal-parser.ts:400`（`buildUiLayoutBlock`）

**产出**：
- `ast/ast-builder.ts`：`LayoutIR -> SemanticAST`（扁平数组转层级树）
- `relationship/`：父子包含（bbox 包含 + 对齐聚类）、文字-组件-容器归属
- `constraint/`：行/列/Grid/Flex 约束（基于 `layoutType` + 间距）
- `typography/`：字号 scale / 字重推断（OCR bbox 高度聚类）

**铁律**：纯算法、确定性、可缓存；不调 VLM；每模块单测

---

### 4.4 重构 Agent（S2）— Wave 2（与 S1 并行）

**必读**：S0 产出 + `src/providers/types.ts`（`VisionProvider` 接口范式）

**产出**：`src/ui-analysis/plugin/types.ts`：`Detector` / `OcrEngine` / `Segmenter` / `LayoutEngine` / `AstBuilder` / `Exporter` 接口；为 `ui-layout-extractor`/`design-extractor` 包适配类（**不改原函数**）

**铁律**：适配类只组合不继承；保持现有导出符号不变

---

### 4.5 导出 Agent（S3）— Wave 3

**必读**：S1 产出（`SemanticAST`）+ S6 调研笔记（Figma 规范）

**产出**：`exporter/{codegen,figma,markdown}-exporter.ts`

**铁律**：导出器无副作用；Figma JSON 严格对齐 S6 规范；Markdown 人类可读

---

### 4.6 集成 Agent（S4）— Wave 3

**必读**：S1/S2/S3 + `src/tools/vision-analyze.ts`（第 392/455 行 uiLayoutExtraction 接线点）+ `src/core/skill-pipeline.ts`（Pipeline 结构）+ `AGENTS.md`（Skill 三件套 + build 拷贝约定）

**产出**：
- `src/skills/analyze-ui/{skill.json,prompt.md,schema.json}`
- `vision-analyze.ts`：`scene ∈ {ui,prototype}` 触发 UI 流水线，写入 `result.ui`/`result.codegenIr`，**保留** `result.parse.uiLayout`
- `options` 扩展（`detect_layout`/`build_tree`/`use_llm`/`strict_mode`）

**铁律**：`use_llm:false` 零 VLM（除 OCR）；现有测试全绿

---

### 4.7 质量 Agent（S5）— Wave 4

**产出**：`tests/ui-analysis/*.test.ts` + `scripts/ui-benchmark.ts`

**铁律**：对齐 `scripts/benchmark.ts` 风格；确定性测试（同图 diff=0）；回归 M7/M8

---

## 5. Lead 协调协议

| 时机 | 动作 |
|------|------|
| 派发前 | 用 `explore`/codegraph 确认现有代码定位，写入 Agent prompt 的"必读"段 |
| 派发 | 同一 Wave 内无依赖的 Agent **并行**派发（单消息多 Task 调用） |
| 收尾 | 收集各 Agent 输出，`pnpm typecheck` + `pnpm test:unit`，`git diff` review |
| 放行 | 契约冻结（S0）或引擎完成（S1）后，Lead 确认才进下一 Wave |
| 集成 | S4 由 Lead 主导或紧密 review，确保不破坏 `vision.analyze` |
| 记录 | 每波在 `方案/` 增补进度（`进度-log.md`） |

---

## 6. 并行安全与冲突规避

- **文件隔离**：各 Agent 写入独立目录（`ir/` `ast/` `relationship/` `exporter/` `plugin/` `tests/ui-analysis/`），不交叉
- **共享只读**：现有 `src/core/extractors/*`、`src/types/domain.ts` 仅读不改
- **契约变更**：S0 冻结后，任何 IR 字段调整必须 Lead 批准并同步所有下游 Agent
- **集成串行**：S4 接线涉及 `vision-analyze.ts`，与 S3 若有交叉则 S3 先、S4 后

---

## 7. 首次派发（Wave 1）

立即并行派发：
1. **契约 Agent**（`general`，S0）— 按本文件 §4.1 规约
2. **调研 Agent**（`research`，S6）— 按本文件 §4.2 规约

S0 冻结 + Lead review 后，放行 Wave 2（S1 + S2 并行）。

---

## 8. 成功标准

- 4 波全部完成，`pnpm typecheck` + `pnpm test:unit` + 现有 M1–M8 测试全绿
- `vision.analyze({ scene:"ui", options:{build_tree:true,use_llm:false} })` 输出层级化 `result.ui`
- Benchmark 达标（见方案 02 §6）
- 现有 `result.parse.uiLayout` 不破坏
