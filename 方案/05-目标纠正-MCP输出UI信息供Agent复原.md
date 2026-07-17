# 目标纠正：MCP 输出 UI 信息供 Agent 复原（不输出代码）

> 本文件纠正 [`04-UI转代码目标分析与实现度评估.md`](./04-UI转代码目标分析与实现度评估.md) 的目标定位。
>
> **纠正后的目标**：MCP 的职责是**根据 UI 图输出足够完整的 UI 信息**，交给下游 agent（Claude Code / Cursor 等）去**复原原 UI**。**MCP 本身不生成代码**。
> 因此 04 中"代码发射器/组件库映射/use_llm 代码增强"列为 P0 是**目标错配**--那些是 agent 的活，不是 MCP 的活。

---

## 1. 纠正后的目标与职责边界

```
┌──────────────────────────────────────────────────────┐
│  MCP（本工具）                                        │
│  UI 图 -> 结构化 UI 信息（完整到可复原）               │
│  产出：SemanticAST + 样式 + 排版 + 语义 + 图片描述     │
│  不做：生成框架代码 / 库映射 / 业务推理（那是 agent）  │
└──────────────────────┬───────────────────────────────┘
                       │ 完整的 UI 复原信息（结构化 JSON）
                       ▼
┌──────────────────────────────────────────────────────┐
│  下游 Agent（Claude Code / Cursor）                   │
│  消费 MCP 输出 -> 选框架/选库/命名/写事件/复原 UI      │
└──────────────────────────────────────────────────────┘
```

**设计沟通契合点**：设计沟通原话"CV 负责**看见**，LLM 负责**理解**"。MCP 把"看见"做到极致并结构化输出；"理解与生成"交给 agent。CodegenIR 在此目标下**不再是"代码生成桥梁"，而是"结构化复原指令"**--供 agent 读取布局约束。

---

## 2. Agent 复原 UI 需要哪些信息（复原清单）

| # | 信息维度 | 用途 | 当前是否输出 |
|---|---------|------|------------|
| 1 | 组件树（类型+嵌套） | 还原结构 | ✅ SemanticAST.root |
| 2 | 组件 bbox（位置/尺寸） | 还原布局坐标 | ✅ ASTNode.bbox |
| 3 | 文本内容 + 归属 | 还原文案 | ✅ node.text + 子 text 节点 |
| 4 | 布局约束（flex/grid/gap/align） | 还原排列 | ✅ CodegenIR.constraints / uiSemantics |
| 5 | **每组件视觉样式**（bg/border/radius/shadow） | 还原视觉 | 🔴 **丢失**（见 §3 实测） |
| 6 | **每文本排版**（fontSize/weight/color/lineHeight） | 还原字体 | 🔴 **丢失**（见 §3 实测） |
| 7 | 主题/令牌（调色板/主色/暗色/对比度） | 还原配色基调 | ✅ LayoutIR.theme / result.parse.design |
| 8 | 页面语义（类型/摘要/变体） | 还原意图 | ✅ result.uiSemantics |
| 9 | **图片/图标内容**（ depicted 什么） | 还原图像 | 🔴 **缺失**（仅 bbox，无描述） |
| 10 | 组件状态/变体 | 还原交互态 | 🟡 部分（variant-engine 基础） |
| 11 | 响应式提示 | 适配多端 | 🔴 缺失（responsive omit） |

---

## 3. 实测：当前输出丢了什么（真实差距验证）

构造含 `card.bgColor='#ffffff'` + button(primary) + 标题(estimatedLevel='title') 的 fixture，跑 pipeline 检查 AST 实际携带：

```
card 节点 props: {"regionId":"r0","relativeArea":0.6}
  -> bgColor 是否带入? false  ← VisualRegion.bgColor 已提取但被 ast-builder 丢弃
button 节点 props: {"score":1,"sourceType":"button"}
  -> 有 color/fill? false     ← UiComponent 本就无颜色字段
title 文本节点 props: {"confidence":1}
  -> 有 fontSize/fontWeight? false  ← estimatedLevel 在 extractor 有，但未带入 AST 文本节点
```

**根因定位**：
- `ui-layout-extractor.ts` 提取了 `VisualRegion.bgColor` 与 `TextEntry.estimatedLevel`，但 `ast/ast-builder.ts` 构建 ASTNode.props 时**只取 regionId/relativeArea/score/confidence**，样式与排版信息被丢弃。
- `UiComponent`（存量类型）本就**不含颜色/border/radius**--组件级视觉信息从未被提取。

---

## 4. 实现度评估（按"复原所需信息"维度）

| 维度 | 现状 | 复原充分度 |
|------|------|-----------|
| 结构骨架（1–4） | SemanticAST + constraints，完整层级化 | 🟢 **~95%**（结构复原足够） |
| 视觉样式（5） | 仅全局 theme；**每组件/区域样式丢失**（bgColor 已提取被弃，组件无样式） | 🔴 **~15%**（agent 无法还原配色到具体组件） |
| 排版（6） | 全局 typography scale；**每文本 fontSize/weight/color 丢失** | 🔴 **~20%** |
| 图像内容（9） | 仅 bbox + nearbyText；**无 VLM 描述/裁剪** | 🔴 **~10%** |
| 语义（8） | pageType + summary + variant，算法版 | 🟢 **~85%** |
| 主题令牌（7） | palette + primary + dark mode + 对比度 | 🟢 **~90%** |
| **整体"供 agent 复原"充分度** | 结构/语义/主题好，**视觉与排版细节丢失** | 🟡 **~55%** |

> 与 04 的差异：04 把 ~55% 归因于"缺代码生成"；**纠正后归因于"输出信息未补齐到视觉复原粒度"**。地基（结构）扎实，缺的是"看见"的最后一层--每个组件/文本长什么样。

---

## 5. 真实差距（按优先级，全部是"信息补全"而非"代码生成"）

### P0 - 视觉复原必需（agent 没这些无法还原外观）

**G1 每组件/区域样式提取并带入 AST**
- 现状：`bgColor` 已提取被弃；组件无颜色/border/radius。
- 需要：新增 `style-extractor.ts`（sharp 采样每个 bbox 区域的主色/边框色/圆角/阴影），写入 `ASTNode.props.style`。
- 同时修复 ast-builder：把 `VisualRegion.bgColor` 带入 region 节点 props。

**G2 每文本排版提取并带入 AST**
- 现状：`estimatedLevel` 提取被弃；无 fontSize/weight/color。
- 需要：扩展 `typography-engine` 或新增 `text-style-extractor`，对每个 OCR 文本 bbox 采样字号（已有 height 估算）、字重（笔画密度）、颜色（采样文字像素），写入文本节点 props。

**G3 图片/图标内容描述**
- 现状：mediaAreas 仅 bbox。
- 需要：对 image/icon 区域做 VLM 描述（"蓝色登录按钮图标"/"用户头像占位图"）或输出裁剪区域供 agent 自取。`use_llm=true` 触发；默认输出裁剪坐标 + nearbyText。

### P1 - 复原完整性

**G4 输出整合为单一"复原规格"**
- 现状：信息散落 `result.ui`/`uiSemantics`/`codegenIr`/`figmaJson`/`uiMarkdown`/`parse.design`。
- 需要：一个 `result.uiReconstruction` 汇总字段（树+样式+排版+约束+语义+图片描述），agent 一次读完。

**G5 组件状态/变体增强**
- 现状：variant-engine 基础。
- 需要：读源 `UiComponent.variant/state` 字段（当前未读）+ 视觉信号（禁用态灰度）。

**G6 响应式提示**
- 现状：responsive omit。
- 需要：基于布局推断断点（sidebar 可折叠 -> mobile 隐藏等）写入 CodegenIR.responsive。

### P2 - 精度（可选）
- G7 YOLO 检测（S6 论证 GPU-gated 默认关）。

---

## 6. 下一步路线（信息补全导向，非代码生成）

```
Wave 6  视觉与排版信息补全（P0，解锁"可复原"）
  ├─ S11 style-extractor：每 bbox 采样主色/边框/圆角/阴影 -> ASTNode.props.style
  ├─ S12 修复 ast-builder：带入 bgColor + 每文本 fontSize/weight/color（estimatedLevel + 像素采样）
  └─ S13 image-content：image/icon 区域 VLM 描述（use_llm=true）或裁剪坐标（默认）
        验收：同一 UI 图 -> AST 每节点带 style + 每文本带排版 -> agent 据此可视觉复原

Wave 7  输出整合与增强（P1）
  ├─ S14 result.uiReconstruction 汇总字段（agent 一次消费）
  ├─ S15 组件 variant/state 增强读源字段
  └─ S16 响应式提示

Wave 8  复原度验收（P1）
  └─ S17 基准：N 张 UI 图 -> MCP 输出 -> agent(Claude Code) 复原 -> 对比原图评分
        指标：结构正确率 / 视觉相似度 / 文案完整率
```

### 关键判断
- **MCP 不写代码**，所以 04 的"代码发射器/库映射"全部移出 MCP 范围，交给 agent。
- `use_llm` 的语义从"生成代码"纠正为"**补全图片内容描述**"（VLM 看 icon/image 是什么），这才是 MCP 内 LLM 的合理用途。
- **Wave 6 是"可复原"的分水岭**：补齐每组件样式 + 每文本排版后，agent 拿到的就是一份完整的 UI 复原规格。

---

## 7. 结论

- 目标纠正：**MCP 输出 UI 复原信息，不输出代码**。04 的代码生成 P0 作废。
- 当前实现度 **~55%**，但缺口从"代码生成"变为"**视觉/排版信息未下沉到每节点**"：
  - 结构骨架、语义、主题 ✅ 充分
  - 每组件样式 🔴（bgColor 已提取被弃、组件无样式）
  - 每文本排版 🔴（estimatedLevel 已提取被弃）
  - 图片内容 🔴（仅 bbox）
- **根因**：`ui-layout-extractor` 提取了 bgColor/estimatedLevel，但 `ast-builder` 构树时丢弃；组件级样式从未提取。
- **下一步**：Wave 6 补全视觉与排版信息（style-extractor + 修复 ast-builder + image-content），完成后输出即达"可复原"粒度。
- `use_llm` 纠正为"图片内容 VLM 描述"，而非代码生成。

> 本文件为目标的权威定位，后续按 Wave 6–8 推进，进度记入 [`进度-log.md`](./进度-log.md)。
