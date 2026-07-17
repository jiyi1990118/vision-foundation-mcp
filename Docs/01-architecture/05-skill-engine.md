# 05 - Skill Engine（技能引擎）

> Skill 是视觉能力的抽象。每个 Skill 定义一种「分析能力」，由 Skill Pipeline 按 Plan 编排执行。新增能力 = 新增 Skill 目录，不动引擎。

---

## 1. 设计目标

| 目标 | 说明 |
|------|------|
| 能力插件化 | 新增视觉能力 = 加目录，不改引擎 |
| 质量内建 | 每个 Skill 自带 Prompt + Schema，校验内建于 Pipeline |
| 可组合 | 多 Skill 可串联/并联完成复杂分析 |
| 模型无关 | Skill 不关心用哪个模型，由 Plan 决定 |

---

## 2. 什么是 Skill

Skill = **一种独立的视觉分析能力**。

当前磁盘上共 8 个 Skill（`src/skills/`，各含 `skill.json + prompt.md + schema.json`）：

```
classify    分类         识别图片整体类别
ocr         文字识别     提取图中文字
summary     摘要         生成图片描述
table       表格分析     还原表格结构
document    文档分析     文档类型与结构
poster      海报分析     海报主题/元素
moderation  内容审核     安全性判断
layout      布局分析     分析视觉布局结构
```

> 图表（chart/diagram）、UI、配色等能力**不以独立 Skill 形式存在**：chart/diagram 由 Universal Parser 的场景抽取器（`src/core/extractors/`）覆盖，UI 布局由 Composer 基于 OCR 算法化生成（见 §6.3）。

**Skill 不是 Tool**：Tool 是 MCP 对外接口（只有一个 `vision.analyze`），Skill 是内部能力。详见 [ADR-002](../04-decisions/ADR-002-skill-not-tool.md)。

---

## 3. Skill 目录结构

每个 Skill 是一个独立目录，**仅含三个文件**：

```
skills/
└── classify/
    ├── skill.json          Skill 元信息（声明式）
    ├── prompt.md           Prompt 模板
    └── schema.json         输出 Schema
```

> 没有 `validator.ts`、没有 `postprocess.ts`、没有 `examples/`。校验与后处理逻辑内建于 `SkillPipeline`（见 §6）。

### 3.1 skill.json（Skill 声明）
```json
{
  "name": "classify",
  "description": "识别图片整体类别",
  "version": "1.0.0",
  "inputs": {
    "required": ["image"],
    "optional": ["focus"]
  },
  "outputs": ["category", "confidence"],
  "supportedProviders": ["smolvlm", "gguf-smolvlm", "gguf-smolvlm2", "minicpm-v"],
  "defaultTimeout": 8000,
  "defaultRetry": { "max": 1, "strategy": "reprompt" }
}
```

### 3.2 prompt.md（Prompt 模板）
```markdown
Classify this image.

Return ONLY valid JSON. Do not explain. Do not output Markdown.

Fields:
- category: image category
- confidence: 0-1 confidence score

{{#if focus}}
Focus on: {{focus}}
{{/if}}
```

### 3.3 schema.json（输出 Schema）
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["category", "confidence"],
  "properties": {
    "category": { "type": "string" },
    "confidence": { "type": "number" }
  }
}
```

---

## 4. Skill 生命周期

单个 Skill 在 Pipeline 中的执行流程：

```
SkillTask（来自 ExecutionPlan）
        │
        ▼
┌──────────────────┐
│ 1. Prompt Compile │  从 Prompt Registry 取模板
│    填充变量       │  填入 intent/metadata/focus
└────────┬─────────┘
         │ finalPrompt
         ▼
┌──────────────────┐
│ 2. Schema Load   │  从 Schema Registry 取 schema.json
└────────┬─────────┘
         │ schema
         ▼
┌──────────────────┐
│ 3. Inference     │  调用 Provider.infer()
│    模型推理       │    └─ signal 透传至 Runtime
└────────┬─────────┘
         │ rawResponse
         ▼
┌──────────────────┐
│ 4. Parse         │  parseAndValidate（内建于 SkillPipeline）
│   （容错修复）    │   - 去 Markdown 代码块
│                  │   - 提取 {...} JSON 片段
│                  │   - 语法修复（尾逗号/单引号/补全闭合括号）
│                  │   - wrapAsJson：自然语言包装成 JSON
└────────┬─────────┘
         │ parsed
         ▼
┌──────────────────┐
│ 5. Validate      │  必填字段校验 + 默认值填充
│   （重试控制）    │   - 必填缺失 -> 重试（强化 prompt）
│                  │   - 可选缺失 -> 默认值
│                  │     (classify.confidence=0.5,
│                  │      ocr.language='unknown')
└────────┬─────────┘
         │ validated
         ▼
   暂存到 Pipeline 结果集
```

> 自定义后处理（`postprocess.ts`）与自定义 Validator 钩子（`skill.json` 指定）**未实现**。当前所有解析/校验/默认填充都在 `SkillPipeline.parseAndValidate` 内联完成。

---

## 5. Skill Pipeline（编排引擎）

Pipeline 负责按 ExecutionPlan 编排多个 Skill：

### 5.1 编排模式

```
模式 A：串行（有依赖）
  classify -> table -> summary

模式 B：并行（独立）
  ocr      ┐
  classify ├── 并行 -> 合并
  layout   ┘

模式 C：分支（条件）
  classify -> ┬─ table（若是表格）
             ├─ document（若是文档）
             └─ poster（若是海报）
```

### 5.2 依赖图
```typescript
interface SkillTask {
  skill: string;
  prompt: string;
  schema: object;
  priority: number;
  dependsOn?: string[];      // 依赖的前置 Skill
  condition?: {               // 条件执行
    field: string;            // 前置 Skill 的输出字段
    equals: string;
  };
}
```

### 5.3 执行示例
```
Plan: [classify, table, document, summary]

Step 1: 执行 classify -> result: { category: "dashboard" }
Step 2: table 依赖 classify.category=="table"?
        -> "dashboard" 不等于 "table" -> 跳过 table
Step 3: document 无条件 -> 执行
Step 4: summary 依赖所有完成 -> 执行
```

混合 OCR 截图分析示例：

```
Plan: [classify, ocr, summary]

Step 1: classify 与 ocr 并行启动
        - classify 使用当前 VLM Provider
        - ocr 若有专用 Provider override，则使用 ppu-paddle-ocr
Step 2: summary 等待 classify + ocr 全部完成
Step 3: summary prompt 注入裁剪后的 OCR context（避免小上下文模型溢出）
Step 4: Composer 合并 classify / ocr / summary，并生成 ocrText、ui、layout、parse
```

目标区域/多色标注提取不是独立 Skill，而是 OCR 成功后的后处理增强：

```
result.ocr -> annotation-detector（5色：red/blue/green/yellow/magenta）
            -> key-content-extractor
            -> result.annotations / result.targetExtraction
```

该路径只在请求包含 `options.target` 或 intent 明确要求标注/关键区域内容时运行。

---

## 6. 三层质量保障

### 6.1 Prompt Compiler（提示词编译器）

**问题**：用户原始问题直接喂小模型，输出不稳定。

**方案**：把用户意图编译成针对模型优化的 Prompt。

```
用户：「这是什么类型的图片？」
         │
         ▼ Prompt Compiler
取 classify/prompt.md 模板
填充变量（intent, focus）
         │
         ▼
最终 Prompt：
"You are an image classification expert.
Return ONLY valid JSON.
Fields: category, confidence
Do not explain. Do not output Markdown."
```

> **Few-shot**：当前实现**未使用** `examples/` 目录，Prompt 为零样本模板。Skill 目录仅含 `skill.json + prompt.md + schema.json`。

### 6.2 Response Validator（响应校验器）

**问题**：小模型输出可能 JSON 不完整、字段缺失、带 Markdown，甚至直接输出自然语言。

**方案**：内联于 `SkillPipeline.parseAndValidate`，四步校验 + 容错。

```
rawResponse
    │
    ▼ JSON Parse
    │  1. 去除 Markdown 代码块标记
    │  2. 提取第一个 {...} 片段
    │  3. 直接 JSON.parse
    │ 失败 -> 尝试修复：
    │         - 尾逗号 / 单引号->双引号 / 补全缺失闭合括号
    │         - 仍失败 -> wrapAsJson：把自然语言包装成该 Skill
    │           期望字段结构的 JSON
    ▼
parsed
    │
    ▼ Schema Validate（必填字段检查）
    │         - 必填缺失 -> 重试（强化 prompt）
    │         - 可选缺失 -> 默认值填充
    │           (classify.confidence=0.5, ocr.language='unknown')
    ▼
validated -> finalResult
```

#### wrapAsJson（自然语言兜底）

当模型不返回 JSON 而返回自然语言（SmolVLM-500M 不总是可靠输出 JSON）时，`wrapAsJson` 按 Skill 专属逻辑包装成合法 JSON：

- **classify**：匹配已知类别词（dashboard/chart/.../illustration/...），命中给 0.7 置信度，未命中 0.3 + `other`。
- **summary**：原文作为 `description`。
- **ocr**：按行拆分为 `texts`，CJK 检测 `language`。
- 其他 Skill：通用包装为 `{ result: text }`。

> **Custom Validator（`skill.json` 指定）**：**未实现**。当前无 Skill 专属校验钩子，所有逻辑在 `parseAndValidate` 内联。

**重试策略**：
- 最多 `retry.max` 次
- `reprompt`：重试时在 prompt 末尾追加「上次输出不符合 Schema，请严格按格式输出」
- 重试耗尽 -> 该 Skill 标记为失败，不阻断其他 Skill

### 6.3 Result Composer（结果组合器）

**问题**：多个 Skill 各自返回，格式不统一。

**方案**：`composeResult`（**函数，非类**，`src/core/skill-pipeline.ts`）合并为统一的 `VisionResult`。

```typescript
// 输入：各 Skill 的结果
{
  classify: { category: "dashboard", confidence: 0.95 },
  ocr: { texts: ["销售额", "Q1", "Q2"] },
  table: { headers: [...], rows: [...] },
  summary: { description: "销售仪表盘" }
}

// 输出：统一的 VisionResult
{
  category: "dashboard",
  confidence: 0.95,
  summary: "销售仪表盘",
  skills: ["classify", "ocr", "table", "summary"],
  result: {
    classify: { ... },
    ocr: { ... },
    table: { ... },
    summary: { ... },
    parse: { ... }            // UniversalParse（见 §6.3.3）
  }
}
```

**冲突处理**：
- 多 Skill 的 `category` 不一致 -> 取 confidence 最高者
- 部分 Skill 失败 -> 成功的照样返回，失败的标记 `error`

#### 6.3.1 算法化富化（基于 OCR）

Composer 还从 OCR 结果**算法化**生成确定性证据，避免小 VLM 仅回显 OCR 片段或遗漏字段：

- 从 OCR texts 生成顶层 `ocrText`。
- 构建 `UiEvidence`：`likelyPageType` / `navigation` / `actions` / `fields` / `tableHeaders` / `values` / `modules` / `rawTextCount` / `title?`。
- 构建 `UiLayout`：从 OCR item 框坐标推断 `leftSidebar` / `mainContent` / `footerActions`。
- `buildOcrDrivenUiSummary`：当 VLM 摘要幻觉或过短时，用 OCR 证据替换之。
- 接收 `annotations` 与 `keyContentExtraction`，输出 `result.annotations` 和 `result.targetExtraction`。

#### 6.3.2 后分类启发式修正（media-first）

分类结果在 Composer 内经过一轮后处理修正（`skill-pipeline.ts`）：

- **媒介优先原则**：AI 生成/绘制的图片优先判为 `illustration`（Prompt 层引导 + 逻辑层补充）。
- `CATEGORY_EXCLUSION_RULES`：基于次级 artwork 信号与 dashboard/截图反向排除规则修正分类。
- `inferCategoryFromSummary`：当分类置信度低时，从 summary 文本推断更准确的类别。

#### 6.3.3 UniversalParse（result.parse）

`buildUniversalParse`（`src/core/universal-parser.ts`）构建结构化的 `result.parse`，跨场景统一输出：

- `scene`：14 类场景（`document / requirement / ui / prototype / photo / code / table / chart / flowchart / mindmap / ppt / chat / error / other`），定义于 `src/core/scene-taxonomy.ts`。
- `quality`：`clarity` / `ocr_confidence` / `issues`。
- `layout`、`ocr.corrected`。
- `entities`、`relationships`、`logic`。
- `summary`、`insights`、`risks`、`next_actions`、`confidence`。
- **场景抽取器**：`src/core/extractors/`（`chart` / `diagram` / `document` / `code` / `form` + `scenario-dispatcher`）按场景提取专属结构。
- **VLM reasoning pass**：`runReasoning`（temp=0，256 tokens，无上下文时跳过，模板兜底）补强小模型推理与洞察。

---

## 7. Skill 注册与发现

### 7.1 自动注册
启动时扫描 `skills/` 目录（编译后为 `dist/skills/`），读取每个 `skill.json + prompt.md + schema.json` 自动注册：

```typescript
// 伪代码
const skills = scanDir("skills/").map(dir => loadSkillManifest(dir));
skillRegistry.register(skills);
```

> Skill 资产由构建脚本（`pnpm build`）从 `src/skills/` 复制到 `dist/skills/`；`registry.ts` 相对编译输出加载，`dist/skills` 缺失会导致运行时失败（即使 `tsc` 通过）。

### 7.2 注册表
```typescript
interface SkillRegistry {
  get(name: string): SkillManifest;
  list(): SkillManifest[];
  has(name: string): boolean;
}
```

### 7.3 新增 Skill 流程
```
1. 创建 skills/my-skill/ 目录
2. 编写 skill.json + prompt.md + schema.json（仅此三文件）
3. 重新构建（pnpm build，复制 skill 资产到 dist/skills/）
4. 重启服务 -> 自动注册
5. 在 config/intents.yaml 添加意图映射（可选）
```

**不需要**修改：SkillEngine、Pipeline、Planner、Provider。

---

## 8. Skill 与 Provider 的能力匹配

并非所有 Skill 都被所有 Provider 支持：

```json
// skill.json
{
  "supportedProviders": ["smolvlm", "gguf-smolvlm", "gguf-smolvlm2", "minicpm-v"]
}
```

Planner 决策时检查：所选 Provider 是否支持该 Skill。若不支持：
- 切换到支持的 Provider
- 或降级到近似 Skill
- 或返回「该能力在当前模型下不可用」

> 实际 Provider 名见 [06 - Provider 与 Runtime](./06-provider-runtime.md)。`ppu-paddle-ocr` 仅支持 `ocr`；`smolvlm`（ONNX）仅支持 `classify/ocr/summary/moderation`。

---

## 9. 接口定义

### SkillManifest（Skill 声明）
```typescript
interface SkillManifest {
  name: string;
  description: string;
  version: string;
  inputs: { required: string[]; optional: string[] };
  outputs: string[];
  supportedProviders: string[];
  defaultTimeout: number;
  defaultRetry: { max: number; strategy: 'none' | 'reprompt' | 'fallback' };
  promptTemplate: string;   // prompt.md 内容
  schema: object;            // schema.json 内容
}
```

### SkillPipeline（编排器）
```typescript
interface SkillPipeline {
  /**
   * 按 Plan 执行所有 Skill
   * 返回各 Skill 的结果集
   * signal 可透传至 Provider.infer 以取消在途推理
   */
  execute(
    plan: ExecutionPlan,
    image: ImageInput,
    signal?: AbortSignal,
  ): Promise<SkillResultSet>;
}
```

> `AbortSignal` 从 `vision.analyze` 入口贯穿 Pipeline -> `Provider.infer`（`InferenceRequest.signal`），在途推理可被取消。

---

## 10. 测试要点

| 测试场景 | 预期 |
|----------|------|
| 新增 Skill 目录 | 自动注册，可被调用 |
| 模型输出合法 JSON | 正常校验通过 |
| 模型输出带 Markdown | 修复后解析成功 |
| 模型输出自然语言（非 JSON） | wrapAsJson 包装后解析成功 |
| 模型输出字段缺失（必填） | 重试 |
| 模型输出字段缺失（可选） | 默认值填充 |
| 重试耗尽 | 该 Skill 失败，不阻断其他 |
| 两个并行 Skill | 同时执行 |
| 有依赖的 Skill | 前置完成后才执行 |
| 条件不满足的 Skill | 跳过 |

---

## 11. 本文小结

Skill Engine 核心要点：

1. **能力即插件** -- 每个 Skill 是独立目录，新增不改引擎
2. **声明式定义** -- skill.json + prompt.md + schema.json（仅三文件）
3. **校验内建** -- Prompt Compiler + 内联 Validator + Composer，无自定义钩子
4. **Pipeline 编排** -- 串行/并行/条件分支，AbortSignal 贯穿
5. **模型无关** -- Skill 声明支持哪些 Provider，但不绑定具体模型
6. **容错优先** -- 小模型不可靠是常态，校验+修复+wrapAsJson+重试+降级

> 下一篇：[06 - Provider 与 Runtime](./06-provider-runtime.md)
