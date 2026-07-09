# 05 - Skill Engine（技能引擎）

> Skill 是视觉能力的抽象。每个 Skill 定义一种「分析能力」，由 Skill Pipeline 按 Plan 编排执行。新增能力 = 新增 Skill 目录，不动引擎。

---

## 1. 设计目标

| 目标 | 说明 |
|------|------|
| 能力插件化 | 新增视觉能力 = 加目录，不改引擎 |
| 质量内建 | 每个 Skill 自带 Prompt + Schema + Validator |
| 可组合 | 多 Skill 可串联/并联完成复杂分析 |
| 模型无关 | Skill 不关心用哪个模型，由 Plan 决定 |

---

## 2. 什么是 Skill

Skill = **一种独立的视觉分析能力**。

```
classify    分类         识别图片整体类别
object      目标检测     检测图中物体及位置
ocr         文字识别     提取图中文字
ui          UI分析       分析界面布局/组件/风格
layout      布局分析     分析视觉布局结构
chart       图表分析     识别图表类型与数据
table       表格分析     还原表格结构
document    文档分析     文档类型与结构
color       配色分析     提取主色调/配色方案
poster      海报分析     海报主题/元素
moderation  内容审核     安全性判断
summary     摘要         生成图片描述
```

**Skill 不是 Tool**：Tool 是 MCP 对外接口（只有一个 `vision.analyze`），Skill 是内部能力。详见 [ADR-002](../04-decisions/ADR-002-skill-not-tool.md)。

---

## 3. Skill 目录结构

每个 Skill 是一个独立目录：

```
skills/
└── ui/
    ├── skill.json          Skill 元信息（声明式）
    ├── prompt.md           Prompt 模板
    ├── schema.json         输出 Schema
    ├── validator.ts        自定义校验逻辑（可选）
    ├── postprocess.ts      后处理逻辑（可选）
    └── examples/           Few-shot 示例
        ├── example1.png
        └── example1.json
```

### 3.1 skill.json（Skill 声明）
```json
{
  "name": "ui",
  "description": "分析 UI 界面的布局、组件、风格",
  "version": "1.0.0",
  "inputs": {
    "required": ["image"],
    "optional": ["focus"]
  },
  "outputs": ["layout", "components", "theme", "typography"],
  "supportedProviders": ["smolvlm2", "gguf", "minicpm"],
  "defaultTimeout": 8000,
  "defaultRetry": { "max": 1, "strategy": "reprompt" }
}
```

### 3.2 prompt.md（Prompt 模板）
```markdown
Analyze this UI screenshot.

Return ONLY valid JSON. Do not explain. Do not output Markdown.

Fields:
- layout: grid structure
- components: list of UI components
- theme: color theme
- typography: font characteristics
- spacing: spacing pattern

{{#if focus}}
Focus on: {{focus}}
{{/if}}
```

### 3.3 schema.json（输出 Schema）
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["layout", "components"],
  "properties": {
    "layout": { "type": "string" },
    "components": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": { "type": "string" },
          "position": { "type": "string" }
        }
      }
    },
    "theme": { "type": "string" },
    "typography": { "type": "string" }
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
│    模型推理       │    └─ Provider 调 Runtime
└────────┬─────────┘
         │ rawResponse
         ▼
┌──────────────────┐
│ 4. Parse         │  JSON 解析
│    （容错修复）   │    失败时尝试修复
└────────┬─────────┘
         │ parsed
         ▼
┌──────────────────┐
│ 5. Validate      │  Schema 校验
│    （重试控制）   │    失败时按策略重试
└────────┬─────────┘
         │ validated
         ▼
┌──────────────────┐
│ 6. Postprocess   │  自定义后处理（可选）
│    （Skill 专属） │    如表格结构化还原
└────────┬─────────┘
         │ finalResult
         ▼
   暂存到 Pipeline 结果集
```

---

## 5. Skill Pipeline（编排引擎）

Pipeline 负责按 ExecutionPlan 编排多个 Skill：

### 5.1 编排模式

```
模式 A：串行（有依赖）
  classify → chart → summary

模式 B：并行（独立）
  ocr  ┐
  color┼── 并行 → 合并
  ui   ┘

模式 C：分支（条件）
  classify → ┬─ chart（若是图表）
             ├─ ui（若是UI）
             └─ document（若是文档）
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
Plan: [classify, chart, ui, summary]

Step 1: 执行 classify → result: { category: "dashboard" }
Step 2: chart 依赖 classify.category=="chart"? 
        → "dashboard" 不等于 "chart" → 跳过 chart
Step 3: ui 无条件 → 执行
Step 4: summary 依赖所有完成 → 执行
```

混合 OCR 截图分析示例：

```
Plan: [classify, ocr, summary]

Step 1: classify 与 ocr 并行启动
        - classify 使用当前 VLM Provider
        - ocr 若有专用 Provider override，则使用 ppu-paddle-ocr
Step 2: summary 等待 classify + ocr 全部完成
Step 3: summary prompt 注入裁剪后的 OCR context（避免小上下文模型溢出）
Step 4: Composer 合并 classify / ocr / summary，并生成 ocrText、ui、layout
```

目标区域/红框提取不是独立 Skill，而是 OCR 成功后的后处理增强：

```
result.ocr → annotation-detector → key-content-extractor → result.targetExtraction
```

该路径只在请求包含 `options.target` 或 intent 明确要求红框/标注/关键区域内容时运行。

---

## 6. 三层质量保障

### 6.1 Prompt Compiler（提示词编译器）

**问题**：用户原始问题直接喂小模型，输出不稳定。

**方案**：把用户意图编译成针对模型优化的 Prompt。

```
用户：「这个页面是什么风格？」
         │
         ▼ Prompt Compiler
取 ui/prompt.md 模板
填充变量（intent, focus）
         │
         ▼
最终 Prompt：
"You are a UI design expert.
Analyze the screenshot.
Return ONLY valid JSON.
Fields: design_style, color_theme, layout...
Do not explain. Do not output Markdown."
```

**Few-shot**：从 `examples/` 取示例注入 prompt，提升小模型稳定性。

### 6.2 Response Validator（响应校验器）

**问题**：小模型输出可能 JSON 不完整、字段缺失、带 Markdown。

**方案**：四步校验 + 容错。

```
rawResponse
    │
    ▼ JSON Parse
    │ 失败 → 尝试修复：
    │         - 去除 Markdown 代码块标记
    │         - 提取第一个 {...} 片段
    │         - 补全缺失的闭合括号
    │ 仍失败 → 触发重试
    ▼
parsed
    │
    ▼ Schema Validate
    │ 失败 → 字段缺失/类型错误
    │         - 必填缺失 → 重试（强化 prompt）
    │         - 可选缺失 → 用默认值填充
    │         - 类型错误 → 尝试类型转换
    ▼
validated
    │
    ▼ Custom Validator（skill.json 指定）
    │ Skill 专属逻辑校验
    ▼
finalResult
```

**重试策略**：
- 最多 `retry.max` 次
- `reprompt`：重试时在 prompt 末尾追加「上次输出不符合 Schema，请严格按格式输出」
- 重试耗尽 → 该 Skill 标记为失败，不阻断其他 Skill

### 6.3 Result Composer（结果组合器）

**问题**：多个 Skill 各自返回，格式不统一。

**方案**：Composer 合并为统一的 `structuredContent`。

```typescript
// 输入：各 Skill 的结果
{
  classify: { category: "dashboard", confidence: 0.95 },
  ocr: { texts: ["销售额", "Q1", "Q2"] },
  chart: { type: "bar", data: [...] },
  summary: { description: "销售仪表盘" }
}

// 输出：统一的 VisionResult
{
  category: "dashboard",
  confidence: 0.95,
  summary: "销售仪表盘",
  skills: ["classify", "ocr", "chart", "summary"],
  result: {
    classify: { ... },
    ocr: { ... },
    chart: { ... },
    summary: { ... }
  }
}
```

**冲突处理**：
- 多 Skill 的 `category` 不一致 → 取 confidence 最高者
- 部分 Skill 失败 → 成功的照样返回，失败的标记 `error`

当前 Composer 还包含 OCR-driven deterministic enrichment：

- 从 OCR texts 生成顶层 `ocrText`。
- 对中文后台/UI 截图生成 `result.ui` 和 `result.layout`。
- 使用 OCR UI 信号修正弱分类结果，如 `document` → `ui`。
- 接收 `annotations` 与 `keyContentExtraction`，输出 `result.annotations` 和 `result.targetExtraction`。
- 对红框内价格表执行表头单位合并和金额符号归一化。

对于密集中文后台截图，Composer 优先使用 OCR 结构化证据生成确定性摘要，避免小 VLM 仅回显 OCR 片段或遗漏字段。

---

## 7. Skill 注册与发现

### 7.1 自动注册
启动时扫描 `skills/` 目录，读取每个 `skill.json` 自动注册：

```typescript
// 伪代码
const skills = scanDir("skills/").map(dir => loadSkillManifest(dir));
skillRegistry.register(skills);
```

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
2. 编写 skill.json + prompt.md + schema.json
3. （可选）编写 validator.ts + postprocess.ts
4. 重启服务（或热加载）→ 自动注册
5. 在 config/intents.yaml 添加意图映射（可选）
```

**不需要**修改：SkillEngine、Pipeline、Planner、Provider。

---

## 8. Skill 与 Provider 的能力匹配

并非所有 Skill 都被所有 Provider 支持：

```json
// skill.json
{
  "supportedProviders": ["smolvlm2", "gguf", "minicpm"]
}
```

Planner 决策时检查：所选 Provider 是否支持该 Skill。若不支持：
- 切换到支持的 Provider
- 或降级到近似 Skill
- 或返回「该能力在当前模型下不可用」

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
  defaultRetry: { max: number; strategy: string };
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
   */
  execute(
    plan: ExecutionPlan,
    image: ImageInput
  ): Promise<SkillResultSet>;
}
```

---

## 10. 测试要点

| 测试场景 | 预期 |
|----------|------|
| 新增 Skill 目录 | 自动注册，可被调用 |
| 模型输出合法 JSON | 正常校验通过 |
| 模型输出带 Markdown | 修复后解析成功 |
| 模型输出字段缺失（必填） | 重试 |
| 模型输出字段缺失（可选） | 默认值填充 |
| 重试耗尽 | 该 Skill 失败，不阻断其他 |
| 两个并行 Skill | 同时执行 |
| 有依赖的 Skill | 前置完成后才执行 |
| 条件不满足的 Skill | 跳过 |

---

## 11. 本文小结

Skill Engine 核心要点：

1. **能力即插件** —— 每个 Skill 是独立目录，新增不改引擎
2. **声明式定义** —— skill.json + prompt.md + schema.json
3. **三层质量保障** —— Prompt Compiler + Validator + Composer
4. **Pipeline 编排** —— 串行/并行/条件分支
5. **模型无关** —— Skill 声明支持哪些 Provider，但不绑定具体模型
6. **容错优先** —— 小模型不可靠是常态，校验+修复+重试+降级

> 下一篇：[06 - Provider 与 Runtime](./06-provider-runtime.md)
