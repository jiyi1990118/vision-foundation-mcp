# 01 - 项目定位与边界（Project Overview）

> 本文档是整个仓库的「第一上下文」。后续所有架构设计、模块开发都以本文档为基础，不推翻重来。

---

## 1. 项目是什么

**Vision Foundation MCP** 是一个专注于**视觉理解（Vision Understanding）**的 MCP 服务。

它的唯一职责是：

> **把图片转换成 AI 可消费的结构化信息。**

它不是一个通用工具箱，不负责数据获取，不做浏览器自动化。它是 MCP 生态中「视觉能力」的单一职责提供者，可以被 Claude / Cursor / ChatGPT / Codex 等任意 MCP Client 调用。

---

## 2. 解决什么问题

当前 MCP 生态中，视觉理解能力分散且耦合：

- 浏览器 MCP 把截图和视觉分析混在一起
- 文件 MCP 不具备图像理解
- 云端视觉 API 依赖网络、有成本、有隐私顾虑
- 本地视觉模型（SmolVLM、SmolVLM2、MiniCPM-V）没有统一的 MCP 接入方式

Vision Foundation MCP 解决的问题：

| 痛点 | 本项目方案 |
|------|-----------|
| 视觉能力与数据获取耦合 | 只做视觉分析，不碰数据获取 |
| 本地模型接入碎片化 | 统一 Provider + Runtime 抽象 |
| 小模型输出不稳定 | Prompt Registry + Schema Registry + 三层质量保障 |
| 密集中文 UI / 需求截图难以准确理解 | 专用 OCR Provider + OCR-driven UI Composer + 目标区域提取 |
| 模型选择靠人工 | Execution Planner 自动决策 |
| 策略硬编码 | Policy Engine 配置化驱动 |
| 能力扩展需改引擎 | Skill 插件化，新增能力不动引擎 |

---

## 3. 项目定位

```
可扩展的本地视觉推理平台（Vision Intelligence Engine）

为 MCP 生态提供统一、可插拔、高性能、CPU 友好的视觉能力。
```

核心定位关键词：

- **本地优先（Local First）**：默认 SmolVLM2-500M-Video-Instruct（GGUF via llama.cpp），Metal/CUDA 加速，约 500MB
- **单一职责**：只做图片 → 结构化信息，不做数据获取
- **可插拔**：Skill / Provider / Runtime 三层皆可扩展
- **配置驱动**：策略、模型选择走配置，不改代码
- **OCR 增强**：可启用 `ppu-paddle-ocr` 作为 OCR-only Provider，用于密集中文 UI 截图、红框/标注区域提取
- **AI 友好**：文档与上下文为 AI 协同开发而设计

---

## 4. 边界定义

### 4.1 负责什么（In Scope）

**输入**：

```
Image / Screenshot / Base64 / File / data:image / http(s)://
```

**输出**：

```
Structured JSON + Text Summary
（符合 MCP 规范的 content + structuredContent）
```

除各 Skill 结果外，输出还包含：

- **Universal Vision Parser（`result.parse`）**：统一视觉解析结构，由 `universal-parser` 生成，提供 insights / risks / next_actions 等推理摘要。
- **`result.ui` / `result.layout`**：OCR 成功后由 Composer 算法化构造（非独立 Skill），面向后台/UI 截图的结构化摘要与布局结构。
- **场景提取器**：针对 chart / diagram / invoice / code / form 等场景，`src/core/extractors/` 下有专用确定性提取器做结构化抽取。

**能力**（通过 Skill 提供，共 8 个）：

```
classify      分类       summary      摘要
ocr           文字识别   table        表格
document      文档       poster       海报
moderation    内容审核   layout       布局分析
```

> 说明：`ui`、`layout` 不是独立 Skill，而是 OCR 成功后算法化构造的输出。

### 4.2 不负责什么（Out of Scope）

以下能力**明确不纳入**本项目，交给生态中其他 MCP：

| 能力 | 归属 |
|------|------|
| Browser 自动化 / Playwright | Browser MCP |
| HTML 解析 | Browser MCP / Fetch MCP |
| Search 搜索 | Search MCP |
| URL 抓取 | Fetch MCP |
| PDF 下载 | Filesystem MCP |
| Office 文档读取 | Filesystem MCP |
| 文件扫描 | Filesystem MCP |

> 原则：**Vision MCP 不产生输入，只消费输入。** 输入来源由调用方（或其他 MCP）负责。

### 4.3 边界示意图

```
┌──────────────────────────────────────────────────┐
│  其他 MCP（数据来源，不是本项目的职责）              │
│  Browser MCP · Search MCP · Filesystem MCP · ... │
└───────────────────────┬──────────────────────────┘
                        │ Image / Base64 / File
                        ▼
┌──────────────────────────────────────────────────┐
│            Vision Foundation MCP                  │
│                                                   │
│   输入归一化 → 路由 → Planner → Policy → Pipeline │
│              → Provider(llama.cpp) → 推理           │
│              → 提取器 → Universal Parser → 输出    │
└───────────────────────┬──────────────────────────┘
                        │ Structured JSON
                        ▼
┌──────────────────────────────────────────────────┐
│  MCP Client（Claude / Cursor / ChatGPT / Codex）  │
└──────────────────────────────────────────────────┘
```

---

## 5. SmolVLM2-500M 的定位

SmolVLM2-500M-Video-Instruct 是**默认本地执行引擎**，不是万能模型。

**它负责**：分类、简单 OCR、配色、UI 分析、文档、Object、Summary、Moderation 等常规视觉任务。

**它的约束**：
- via llama.cpp（Metal/CUDA/CPU），约 500MB 内存
- Q8_0 量化，精度与体积平衡
- 小模型，输出不稳定 → 需 Prompt Registry + Schema Validator 兜底

**它不负责**：复杂推理、高精度 OCR、细粒度表格还原等 → 高质量视觉理解交给 `quality=high` 模式接入的 MiniCPM-V；密集 OCR 和红框内表格还原优先交给可选 `ppu-paddle-ocr` + deterministic composer。

### 5.1 v0.2 OCR-driven key-content extraction

v0.2 新增了针对中文后台/需求截图的确定性增强路径：

- `VISION_OCR_PROVIDER=ppu-paddle-ocr` 注册专用 OCR-only Provider。
- OCR-only 请求路由到 `ppu-paddle-ocr`；`classify + ocr + summary` 混合请求仍由 VLM 负责视觉理解，并通过 per-skill override 让 OCR 由专用 Provider 执行。
- 当 `options.target` 或 intent 命中红框/标注/关键区域语义时，系统检测红色虚线/实线框，结合全图 OCR 与局部裁剪 OCR 构造 `result.targetExtraction`。
- 对红框内金额表格执行表头单位合并、行列重建和货币符号归一化，避免相邻框外文本泄漏。

> 关键认知：**决定项目成败的不是某个模型，而是 Planner、Policy、Prompt Compiler、Skill Engine 这套工程体系。** 模型可替换，体系是根基。

### 5.2 M5 多模型路由（Provider Router）

M5 引入了基于路由的 Provider 选择机制（`src/core/provider-router.ts`）：

- `selectProvider()` 根据请求的 `quality` / `provider` 选项、检测到的硬件资源、所需 Skill，从已注册 Provider 中选出最合适的实例。
- 默认 / 活动 Provider 为 `gguf-smolvlm2`；`VISION_HIGH_QUALITY=1` 时注册 `minicpm-v`，`quality=high` 请求可路由到它（首次使用懒加载，约 2GB 下载）。
- 路由是 Provider 选择的唯一权威；Planner 不再硬编码改写 Provider，`memory-guard` 规则仅告警不覆盖。
- `VISION_OCR_PROVIDER=ppu-paddle-ocr` 可注册专用 OCR-only Provider，混合请求中 `ocr` skill 由其执行，其余 skill 仍由 VLM Provider 执行。

---

## 6. 与生态的关系

Vision Foundation MCP 是 MCP 生态中的「视觉专家节点」：

```
                   ┌─────────────┐
                   │  MCP Client  │
                   └──────┬───────┘
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
   │ Browser MCP │ │ Filesystem  │ │   Vision    │
   │ (数据获取)   │ │ MCP(文件)    │ │ Foundation  │
   │             │ │             │ │ MCP(视觉)    │
   └─────────────┘ └─────────────┘ └─────────────┘
```

- Browser MCP 截图后，把图片交给 Vision MCP 分析
- Filesystem MCP 读取图片后，交给 Vision MCP 理解
- Vision MCP **不反向调用**这些 MCP，保持单向依赖

---

## 7. 设计理念（Design Philosophy）

### 7.1 单一职责（Single Responsibility）
一个 MCP 只做一件事，做到极致。视觉分析就是视觉分析，不做别的。

### 7.2 本地优先（Local First）
默认本地模型，离线可用，隐私安全，零成本。云端模型作为可选升级。

### 7.3 配置驱动（Configuration Driven）
策略、模型选择、预处理流程全部配置化。新增模型或调整行为，改配置不改代码。

### 7.4 插件优先（Plugin First）
Skill、Provider、Runtime 都是插件。新增能力 = 新增插件，不动核心引擎。

### 7.5 质量内建（Quality Built-in）
小模型不可靠是常态，所以 Prompt Compiler、Schema Validator、Result Composer 是必需品，不是可选项。

### 7.6 AI 协同（AI Native）
文档和工程上下文为 AI 协同开发而设计，让 Claude Code / OpenCode / Codex 能稳定按统一架构产出代码。

---

## 8. 非目标（Non-Goals）

明确以下事项**不在本项目目标内**，避免范围蔓延：

- ❌ 不做通用 AI Foundation Framework（先做好 Vision，架构预留扩展即可）
- ❌ 不做视频理解（V1 范围外，未来路线图）
- ❌ 不做图像生成（只做理解，不做生成）
- ❌ 不做数据获取（Browser/Search/File 等交给其他 MCP）
- ❌ 不做自有模型训练（只做推理服务，用现成模型）
- ❌ 不追求一次性产出 80+ 文档（聚焦核心，按需演进）

---

## 9. 未来愿景（Future Vision）

```
V1  SmolVLM2 本地视觉理解（已完成 M5 多模型扩展）
V1.1 OCR-driven key-content extraction（已完成 v0.2，支持红框/目标区域结构化提取）
V2  接入 MiniCPM-V 2.6 高质量模式（已完成），支持 video 视频理解
V3  Video 视频理解
V4  Multi-Agent 多模型协作（复杂任务拆分给不同模型）
```

架构上为 V2-V4 预留扩展点（Provider/Runtime 插件化），但 V1 聚焦交付。

---

## 10. 本文小结

| 维度 | 定位 |
|------|------|
| 是什么 | 专注视觉理解的 MCP 服务 |
| 核心职责 | 图片 → 结构化信息 |
| 默认引擎 | SmolVLM2-500M-Video-Instruct（GGUF via llama.cpp，约 500MB） |
| 架构核心 | Planner + Policy + Skill + Provider + Runtime 五层解耦 |
| 质量保障 | Prompt Registry + Schema Registry + Validator/Composer |
| 不做什么 | 数据获取、图像生成、视频（V1）、模型训练 |

> 下一份文档：[02 - 设计原则](./02-design-principles.md) —— 把上述理念落实为可执行的工程原则。
