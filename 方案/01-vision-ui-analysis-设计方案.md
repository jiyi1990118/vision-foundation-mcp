# Vision UI 分析引擎 - 可执行方案设计

> 本文档基于 [`设计沟通.md`](../设计沟通.md) 的讨论归纳整理而成。
> 核心命题：**UI 图的结构布局、元素、层级、坐标、颜色、组件等信息，90% 可不依赖大模型（LLM）完成**——以传统 CV + OCR + 检测模型为主，LLM 仅在「理解/生成」环节按需介入。
>
> 本方案是工程落地的执行依据，而非 Prompt 或愿景描述。所有阶段均给出交付物、与现有代码的映射、验收标准。

---

## 1. 背景与目标

### 1.1 问题陈述

当前项目 `vision-foundation-mcp` 已具备完整的 VLM（SmolVLM2 / SmolVLM / MiniCPM-V）+ PaddleOCR 推理链路（M1–M8 已完成，见 [`Docs/05-roadmap/01-roadmap.md`](../Docs/05-roadmap/01-roadmap.md)）。但「UI 截图 → 结构化布局树」这一类任务目前**高度依赖 VLM 一次性生成**，存在：

- **延迟高**：单图秒级，远高于纯 CV 的 10–30ms。
- **成本高**：每次都走模型推理。
- **不稳定**：小模型输出漂移、坐标幻觉、JSON 结构不合规。
- **不可解释**：无法追溯某个组件框的来源。

而业界成熟做法是：**CV + OCR + 检测模型负责「看见」，LLM 只负责「理解」**。设计沟通确认了这条路可行，且很多产品已验证。

### 1.2 目标（本方案要做的事）

构建一套 **CV/OCR/检测优先、LLM 可选** 的 UI 分析引擎，并最终沉淀为 **Vision MCP 规范（VMCP Spec）** 的雏形：

| # | 目标 | 衡量标准 |
|---|------|----------|
| G1 | UI 元素检测（按钮/输入框/卡片/导航等）不依赖 LLM | 纯 CV/检测路径单图 < 200ms（含 OCR） |
| G2 | 文字识别 + 坐标定位由 OCR 完成 | OCR 文本与 bbox 准确率 ≥ 90% |
| G3 | 布局分析（行/列/Grid/Flex/父子关系）由几何算法完成 | 输出确定性的 Layout Tree JSON |
| G4 | 统一中间表示（IR）分层，支持多端导出 | Vision IR → Layout IR → UI AST → Codegen IR |
| G5 | LLM 仅在「页面语义/命名/代码生成」按需介入 | 90% 字段确定性产出，LLM 仅增强非必要字段 |
| G6 | 插件化：检测器/OCR/分割器统一接口，热插拔 | 新增一个检测器不改核心引擎 |

### 1.3 非目标（本方案不做）

- ❌ 业务语义推理（这是 LLM/上层 Agent 的事）
- ❌ API/交互行为推断
- ❌ 直接生成可运行的生产代码（本方案只产出 Codegen IR，由下游消费）
- ❌ 推翻现有 VLM 链路；本方案是**增强并下沉**现有能力

---

## 2. 现状与差距分析

### 2.1 已具备（复用基础）

| 现有能力 | 位置 | 在本方案中的角色 |
|----------|------|------------------|
| Provider 抽象 | `src/providers/types.ts` (`VisionProvider`) | 扩展为统一的 Detector/OCR/Segmenter 插件接口基类 |
| Provider 路由 | `src/core/provider-router.ts` | 复用「能力匹配 + 资源筛选」思路做检测器选择 |
| PaddleOCR Provider | `src/providers/ppu-paddle-ocr/provider.ts` | 直接作为 OCR 引擎插件（已具备 native OCR） |
| 通用视觉解析器 | `src/core/universal-parser.ts` | `result.parse` 的 `uiLayout` 字段是 UI AST 的雏形 |
| 场景分类法 | `src/core/scene-taxonomy.ts`（含 `ui`/`prototype`） | 触发 UI 分析流水线的入口判定 |
| 布局数据结构 | `src/types/domain.ts` (`UiLayoutBlock`/`VisualRegion`/`UiComponentEntry`/`BBox`) | 作为 UI AST 的起始 Schema |
| 标注检测 | `src/core/annotation-detector.ts` | CV 预处理阶段可复用（多色框检测已是纯算法） |
| Skill 流水线 | `src/core/skill-pipeline.ts` | UI 分析作为新 Skill/流水线编排进现有 Pipeline |

### 2.2 缺失（本方案要补齐）

- **检测模型接入**：当前无 YOLO/RT-DETR/GroundingDINO 等 UI 组件检测器。
- **纯 CV 布局推断**：当前 UI 布局主要靠 OCR + 启发式，缺少 OpenCV 轮廓/边缘/NMS 的几何层。
- **分层 IR**：当前只有「Skill 结果 → structuredContent」，缺少 Vision IR / Layout IR / Semantic AST / Codegen IR 的明确分层。
- **布局/约束引擎**：无独立的 Layout Engine / Relationship Engine / Constraint Engine。
- **插件接口规范**：检测器/OCR/分割器无统一 Trait/Interface。
- **导出器**：无 Figma JSON / React IR / Vue IR 等导出能力。

---

## 3. 设计原则

1. **看见 ≠ 理解**：CV/OCR/检测负责确定性的事实采集；LLM 只做语义增强，且可关。
2. **确定性优先**：所有几何/坐标/层级由算法产出，可复现、可解释、可缓存。
3. **分层 IR**：每层 IR 独立可测、可缓存、可被下游独立消费。
4. **插件化**：检测器、OCR、分割器、导出器全部统一接口，热插拔，新增不改核心。
5. **渐进下沉**：先在现有 TS 项目内以「Skill + Provider」形态落地，验证后再抽 Spec / SDK。
6. **LLM 可选**：流水线在任何阶段都允许 `useLLM: false`，退化为纯确定性输出。
7. **对齐现有约定**：术语/分层规则/目录结构遵守 [`Docs/02-contracts/`](../Docs/02-contracts/) 与 [`Docs/03-development/`](../Docs/03-development/)。

---

## 4. 方案对比与选型

设计沟通中讨论了 7 种技术路线。归纳如下（★ 为推荐采纳）：

| 方案 | 能力 | 速度 | 是否需训练 | 采纳 | 角色 |
|------|------|------|-----------|------|------|
| 一·纯 CV (OpenCV) | 轮廓/边缘/矩形/NMS/布局 | 10–30ms | 否 | ★ | 预处理 + 布局几何层 |
| 二·目标检测 (YOLO/RT-DETR) | UI 组件分类定位 | 5–20ms(GPU) | 是(微调) | ★ | 组件检测器（主） |
| 三·OCR (PaddleOCR) | 文字+坐标 | 快 | 否 | ★ | 文字层（**已落地**） |
| 四·UI 专用检测模型 (UIED/Rico) | 专用 UI 元素 | 中 | 部分 | ☆ | 数据集/微调来源 |
| 五·SAM (Segment Anything) | 任意区域 Mask | 中 | 否 | ☆ | 高精度分割补充 |
| 六·GroundingDINO | 文本提示检测 | 中 | 否 | ☆ | 零样本图标/稀有组件检测 |
| 七·OCR+CV 融合 | 工业最常见 | 快 | 否 | ★ | 默认兜底路径（无检测模型时） |

### 4.1 选型结论：混合流水线

采用设计沟通推荐的混合架构，按「可用性优先」分层降级：

```
Level-A（完整）: OpenCV 预处理 → YOLO/RT-DETR 组件检测 → PaddleOCR 文字 → SAM2 分割(可选) → Layout Engine → UI AST
Level-B（无检测模型时）: OpenCV 预处理 → PaddleOCR 文字 + 矩形 → 几何推断组件 → Layout Engine → UI AST   ← 工业兜底
Level-C（无 CV 时，现状）: VLM 一次性生成 → universal-parser 解析                                          ← 现有退化路径
```

- **Level-B 为 v1 默认**：不依赖任何需训练/下载的检测模型，复用已有 PaddleOCR + OpenCV，即可产出确定性 Layout Tree。
- **Level-A 为 v1.1+**：接入 YOLO（基于 Rico 数据集微调）后启用，提升组件分类精度。
- **Level-C 保留**：作为无 CV 依赖环境或非 UI 场景的兜底。

---

## 5. 目标架构

### 5.1 总体流水线

```
              UI 截图
                 │
                 ▼
        ┌────────────────────┐
        │ 0. 预处理 (OpenCV)  │  缩放/灰度/去噪/边缘(Canny)/轮廓(findContours)/矩形合并(NMS)
        └────────┬───────────┘
                 ▼
        ┌────────────────────┐
        │ 1. 组件检测         │  Level-A: YOLO/RT-DETR  ;  Level-B: 几何矩形 + 启发式分类
        │   (Detector 插件)   │  输出: [{type, bbox, score}]
        └────────┬───────────┘
                 ▼
        ┌────────────────────┐
        │ 2. OCR (PaddleOCR)  │  文字 + bbox  （已落地：ppu-paddle-ocr）
        └────────┬───────────┘
                 ▼
        ┌────────────────────┐
        │ 3. 分割 (SAM2 可选) │  精修边界 / 图标轮廓
        └────────┬───────────┘
                 ▼
        ┌────────────────────┐
        │ 4. Layout Engine    │  对齐聚类 / 间距 / padding / Grid-Flex 推断
        └────────┬───────────┘
                 ▼
        ┌────────────────────┐
        │ 5. Relationship Eng │  父子包含 / 同级分组 / 文字-组件归属
        └────────┬───────────┘
                 ▼
        ┌────────────────────┐
        │ 6. Constraint Eng   │  行/列/Grid/Flex 约束生成
        └────────┬───────────┘
                 ▼
        ┌────────────────────┐
        │ 7. Theme/Typography │  调色板/对比度/字号层级（纯算法）
        └────────┬───────────┘
                 ▼
        ┌────────────────────┐
        │ 8. AST Builder      │  产出 Semantic UI AST (JSON)
        └────────┬───────────┘
            ┌────┴─────┐
            ▼          ▼
     ┌──────────┐  ┌──────────────┐
     │ Exporter │  │ LLM 增强(可选)│  页面语义/命名/优化建议
     │ Figma/IR │  └──────────────┘
     └──────────┘
```

### 5.2 分层 IR（本方案最核心的设计资产）

四层 IR，每层独立 Schema、可缓存、可独立测试：

```
Raw Vision IR  →  Layout IR  →  Semantic UI AST  →  Codegen IR
(原始检测事实)    (几何布局)      (语义组件树)        (多端代码 IR)
```

| IR 层 | 内容 | 产出者 | 是否含 LLM |
|-------|------|--------|-----------|
| **Vision IR** | 原始检测框、OCR 文本框、Mask、颜色采样——未经推理的「事实」 | Detector/OCR/Segmenter | ❌ |
| **Layout IR** | 对齐组、间距、padding、行列/Grid/Flex 结构、父子包含关系 | Layout/Relationship/Constraint Engine | ❌ |
| **Semantic UI AST** | 带类型的组件树（Button/Card/Input/Navbar…）、属性、层级 | AST Builder | ❌（命名可选 LLM） |
| **Codegen IR** | 与框架无关的描述（响应式约束、插槽、重复项），供 React/Vue/Flutter 消费 | Codegen Transformer | ❌ |

> 与现有代码映射：`result.parse.uiLayout`（`UiLayoutBlock`）对应 **Layout IR 的早期形态**；本方案将其升级为独立、分层的 IR 体系，并新增 Semantic AST / Codegen IR。

### 5.3 目录结构（在现有 `src/` 下扩展）

```
src/
├── ui-analysis/                 ← 新增模块（本方案核心）
│   ├── pipeline.ts              # 编排 0–8 阶段，每阶段可缓存
│   ├── preprocess/             # OpenCV 预处理
│   ├── detector/               # 组件检测插件接口 + 实现
│   │   ├── types.ts            #   Detector 接口
│   │   ├── geometry-detector.ts#   Level-B 几何检测器（默认）
│   │   └── yolo-detector.ts    #   Level-A YOLO 检测器（v1.1+）
│   ├── ocr/                    # 复用 ppu-paddle-ocr，封装为 OCR 插件
│   ├── segmentation/           # SAM2 适配（可选）
│   ├── layout/                 # Layout Engine
│   ├── relationship/           # Relationship Engine
│   ├── constraint/             # Constraint Engine
│   ├── theme/                  # Theme + Typography Engine
│   ├── ast/                    # AST Builder
│   ├── ir/                     # 四层 IR 类型定义
│   └── exporter/               # Figma JSON / Codegen IR / Markdown
├── skills/
│   └── analyze-ui/             # 作为新 Skill 接入现有 SkillPipeline
│       ├── skill.json
│       ├── prompt.md           # 仅 LLM 增强时使用
│       └── schema.json
└── providers/                  # 不变
```

---

## 6. 能力清单与 API

### 6.1 组件类型表（Semantic UI AST 支持的类型）

```
Page, Container, Header, Footer, Navbar, Sidebar, Toolbar,
Card, Section, List, ListItem, Table, Row, Column, Grid,
Button, IconButton, Text, Title, Subtitle,
Input, Textarea, Checkbox, Radio, Switch, Select, Dropdown,
Image, Avatar, Icon, Divider, Progress, Badge, Tag, Tab,
Dialog, Drawer, BottomSheet, Unknown
```

> 超出已知类型的元素归为 `Unknown` 并保留 bbox，保证不丢信息。

### 6.2 MCP API 演进

现有单一工具 `vision.analyze`（[`src/tools/vision-analyze.ts`](../src/tools/vision-analyze.ts)）保留为统一入口。UI 分析作为其 `scene=ui|prototype` 时的增强路径，通过 `options` 控制开关，避免破坏现有契约：

```
vision.analyze(image, intent, {
  scene: "ui",
  options: {
    detect_layout:    true,   # 布局分析
    detect_component: true,   # 组件检测
    detect_text:      true,   # OCR
    detect_icon:      false,  # 图标检测（v1.1+）
    detect_theme:     true,   # 主题/排版提取
    build_tree:       true,   # 构建 UI AST
    use_llm:          false,  # 是否启用 LLM 增强（默认 false）
    strict_mode:      false   # 严格模式：缺字段即失败
  }
})
```

**输出**（写入 `structuredContent.result`）：

```
ui: {                 # 复用现有 result.ui，升级为 Semantic AST
  page, components[], constraints[], theme, typography
}
layout: {             # Layout IR
  regions[], layoutType, averageGap, spacingScale
}
parse.uiLayout: ...    # 兼容现有字段（向后兼容）
codegenIr?: ...        # 当请求 export 时附带
```

> Spec 级独立 API（`vision.detect_objects` / `vision.build_ast` / `vision.export_codegen` 等）作为 **v2 Spec 阶段** 拆分，不在 v1 范围。

---

## 7. 插件接口规范

所有检测/识别能力统一接口（对齐设计沟通的 Rust Trait 思路，先用 TS Interface 落地）：

```typescript
// src/ui-analysis/detector/types.ts
export interface Detector {
  readonly name: string;
  readonly version: string;
  initialize(): Promise<void>;
  detect(image: ImageInput): Promise<Detection[]>;  // Detection = { type, bbox, score }
}

export interface OcrEngine {
  readonly name: string;
  recognize(image: ImageInput): Promise<OcrResult[]>;  // OcrResult = { text, bbox, confidence }
}

export interface Segmenter {
  segment(image: ImageInput, prompts?: BBox[]): Promise<Mask[]>;
}

export interface LayoutEngine {
  build(detections: Detection[], ocr: OcrResult[]): Promise<LayoutIR>;
}

export interface AstBuilder {
  build(layout: LayoutIR): Promise<SemanticAST>;
}

export interface Exporter {
  readonly format: string;  // 'figma' | 'react-ir' | 'vue-ir' | 'html' | 'markdown'
  export(ast: SemanticAST): Promise<unknown>;
}
```

> `VisionProvider`（现有）与上述接口的关系：`ppu-paddle-ocr` 同时实现 `VisionProvider`（对外）与 `OcrEngine`（对内被 UI 流水线复用）。这是关键复用点。

---

## 8. 分阶段实施计划

> 原则：每个阶段都可独立交付、可测、不破坏现有 `vision.analyze` 契约。
> 编号 `UI-1 / UI-2 …` 与现有里程碑 M1–M8 并行，作为「UI 分析」子线。

### 阶段 UI-1：IR 类型与 Schema 定义（无运行时依赖）

**交付物**
- `src/ui-analysis/ir/` 下四层 IR 的 TS 类型 + JSON Schema（`vision_ir / layout_ir / semantic_ast / codegen_ir`）
- 将现有 `src/types/domain.ts` 的 `UiLayoutBlock` 标注为 Layout IR 的兼容子集，保持向后兼容

**验收**
- `pnpm typecheck` 通过
- Schema 文件可被独立加载校验

**依赖**：无

---

### 阶段 UI-2：纯 CV 预处理 + 几何检测器（Level-B 默认路径）

**交付物**
- `preprocess/`：OpenCV 缩放/灰度/Canny/findContours/NMS（用 `sharp` 或 `opencv-js`；优先复用项目已批准的原生依赖 `sharp`）
- `detector/geometry-detector.ts`：基于轮廓矩形 + 启发式分类（按宽高比/位置/文字归属推断 Button/Input/Card 等）
- `layout/layout-engine.ts`：对齐聚类、间距、padding 推断、Grid/Flex 检测
- `relationship/`：父子包含、文字-组件归属
- `ast/ast-builder.ts`：产出 Semantic UI AST

**验收**
- 给定一张登录页截图 → 不调用任何 LLM → 输出含 `Input/Button/Title` 的 AST JSON
- 单图（不含 OCR）< 200ms；含 PaddleOCR < 500ms
- 确定性：同一图两次运行结果完全一致

**依赖**：UI-1

---

### 阶段 UI-3：接入现有 OCR + Theme/Typography

**交付物**
- `ocr/` 适配器：复用 `ppu-paddle-ocr`，输出 `OcrResult[]`
- `theme/theme-engine.ts`：调色板提取、主色/背景/文字色、对比度、暗色模式判定（纯算法）
- `theme/typography-engine.ts`：字号层级推断（基于 OCR 字号 + 聚类）
- 文字-组件归属回填到 AST

**验收**
- `result.ui.theme` 输出调色板 + 对比度
- OCR 文本正确归属到对应组件（如「登录」归属到 Button）

**依赖**：UI-2、现有 `ppu-paddle-ocr`

---

### 阶段 UI-4：作为 Skill 接入现有 Pipeline

**交付物**
- `src/skills/analyze-ui/{skill.json,prompt.md,schema.json}`（注意：`pnpm build` 会拷贝这些资产，见 AGENTS.md）
- `src/tools/vision-analyze.ts`：当 `scene ∈ {ui, prototype}` 时，在 universal-parser 之前/并行触发 UI 分析流水线，结果合并进 `result.ui` / `result.layout`
- `use_llm` 选项：为 `true` 时把 AST 交给 VLM 做命名/页面语义增强

**验收**
- `vision.analyze({ image, intent: "auto", scene: "ui" })` 返回 `result.ui.components[]`
- `use_llm:false` 时全程零模型推理（除 OCR）
- 现有 M7/M8 测试全部仍通过（向后兼容）

**依赖**：UI-3

---

### 阶段 UI-5：导出器（Codegen IR / Figma JSON）

**交付物**
- `exporter/codegen-exporter.ts`：Semantic AST → Codegen IR（响应式约束、重复项、插槽）
- `exporter/figma-exporter.ts`：AST → Figma JSON 结构
- `exporter/markdown-exporter.ts`：AST → 可读文档

**验收**
- 给定 AST → 输出 Codegen IR，可被一个最小 React 模板渲染出近似布局
- Figma JSON 可被 Figma 插件导入（结构合法）

**依赖**：UI-4

---

### 阶段 UI-6（可选）：检测模型接入（Level-A 升级）

**交付物**
- `detector/yolo-detector.ts`：接入 YOLOv11 / RT-DETR（基于 Rico 数据集微调的 UI 检测权重）
- 路由：GPU 可用时优先 YOLO，否则回退 geometry-detector
- Benchmark：OCR/组件/布局准确率 + 延迟/内存/FPS

**验收**
- 组件分类 mAP 较 Level-B 提升
- 无 GPU 环境自动降级到 Level-B，不报错

**依赖**：UI-4；需 GPU + 模型权重

---

### 阶段 UI-7（远期）：抽 Spec / SDK

**交付物**
- `方案/spec/` 下 RFC 文档（Vision IR / Layout IR / Semantic AST / Plugin SDK / Detector Interface / Benchmark）
- 插件开发规范
- 多语言 SDK 占位（Rust/TS/Python/Go），TS 为参考实现

**验收**
- 第三方按 RFC 可独立实现一个兼容 Detector 插件

**依赖**：UI-1~UI-5 稳定运行

---

## 9. 验收与度量（Benchmark）

对齐设计沟通的 Benchmark 体系，建立可回归的度量：

| 维度 | 指标 | 目标 |
|------|------|------|
| OCR 准确率 | 文本 char-level accuracy | ≥ 90% |
| 组件检测 | Precision / Recall（人工标注集） | ≥ 0.8 / 0.75（Level-B） |
| 布局准确率 | 父子关系正确率 | ≥ 0.85 |
| 延迟 | 单图端到端（use_llm=false） | < 500ms |
| 内存 | 峰值 | < 512MB（不含模型） |
| 确定性 | 同图多次运行 diff | 0（完全一致） |
| 兼容性 | 现有 M1–M8 测试 | 全绿 |

度量脚本放 `scripts/ui-benchmark.ts`，对齐现有 `scripts/benchmark.ts` 风格。

---

## 10. 风险与决策点

| # | 风险/决策 | 说明 | 倾向决策 |
|---|----------|------|----------|
| R1 | OpenCV 依赖选型 | `sharp`（已批准）能力有限；`opencv-js` 体积大 | 先用 `sharp` 做基础；复杂轮廓用纯 TS 几何算法补 |
| R2 | 是否引入需训练的 YOLO | 增加部署复杂度与模型下载 | v1 走 Level-B（无训练）；UI-6 再引入，可选 |
| R3 | IR 是否破坏现有 `uiLayout` 契约 | 现有调用方依赖 `result.parse.uiLayout` | 新 IR 与旧字段并存，旧字段标注 deprecated 但保留 |
| R4 | 是否拆分独立 MCP 工具 | 设计沟通设想 `vision.detect_objects` 等多工具 | v1 不拆，保持单工具 `vision.analyze` + options；Spec 阶段再拆 |
| R5 | LLM 增强的默认值 | 影响延迟/成本 | 默认 `use_llm:false`，显式开启 |
| R6 | Codegen IR 范围 | 是否真生成代码 | 只产 IR，不生成可运行代码（避免幻觉风险） |

---

## 11. 与现有文档体系的关系

- 本方案落地后，应在 [`Docs/`](../Docs/) 下新增：
  - `01-architecture/14-ui-analysis-engine.md`（架构详述）
  - `02-contracts/` 下补充四层 IR 的契约文档
  - `05-roadmap/01-roadmap.md` 增补 UI-1~UI-7 子线
- ADR 记录 R1–R6 的关键决策（`Docs/04-decisions/`）
- 术语遵守 [`Docs/02-contracts/01-domain-model.md`](../Docs/02-contracts/01-domain-model.md)

---

## 12. 执行优先级与下一步

按设计沟通的「先跑通 > 完整」原则，立即启动：

```
1. UI-1  IR 类型与 Schema            （半天，无依赖，先对齐数据契约）
2. UI-2  CV 预处理 + 几何检测器       （核心，打通 Level-B 闭环）
3. UI-3  接入 OCR + Theme             （复用现有 ppu-paddle-ocr）
4. UI-4  接入 Skill Pipeline          （最小可交付：vision.analyze 出 UI AST）
───── 以上为 v1 最小闭环 ─────
5. UI-5  导出器                       （按需）
6. UI-6  YOLO 检测模型（可选）        （GPU 可用时）
7. UI-7  Spec / SDK（远期）           （稳定后）
```

**第一步行动**：完成 UI-1，产出 `src/ui-analysis/ir/` 四层 IR 类型与 JSON Schema，并在本目录补一份 `ir-schema.md` 索引。
