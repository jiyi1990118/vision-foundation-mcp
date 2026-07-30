<!--
  Implementation Status (2026-07-30 audit):
  PromptRegistry and SchemaRegistry NOT implemented as described. Prompts
  and schemas are inlined in each skill directory (prompt.md, schema.json)
  and loaded by src/skills/registry.ts. The prompts/ + schemas/ directory
  structure, _shared/ partials, few-shot.json, version management, and
  A/B testing described here are NOT implemented. This document is a vision.
-->
# 09 - Prompt Registry 与 Schema Registry（提示词与模式注册表）

> 沟通记录原话：「本地模型准确率 90% 都是 Prompt」。SmolVLM-500M 作为小模型，输出不稳定的根源在于 Prompt 质量。Prompt Registry 和 Schema Registry 是决定项目成败的核心基础设施。

---

## 1. 为什么这两个注册表是项目成败关键

### 1.1 小模型的现实

SmolVLM-500M Q4_K_M 不是大模型，它的能力边界明显：

```
大模型（GPT-4V / Qwen2.5-VL-72B）：
  随便给个 Prompt → 稳定输出合法 JSON → 准确率高

小模型（SmolVLM-500M Q4_K_M）：
  随便给个 Prompt → 输出可能带 Markdown → JSON 不完整 → 字段缺失 → 幻觉
  精心设计的 Prompt → 输出稳定 → 准确率可接受
```

### 1.2 核心论点

> **Prompt 不是让 LLM 写的，而是由 Prompt Registry 统一维护、针对 SmolVLM 优化的。**

```
不维护 Prompt Registry：
  每次 Skill 调用临时拼 Prompt → 输出质量随机 → 无法迭代优化 → 无法测试

维护 Prompt Registry：
  Prompt 版本化 → 可 Benchmark → 可 A/B 测试 → 持续优化 → 输出稳定
```

### 1.3 Schema Registry 的作用

```
没有 Schema：
  模型返回什么就用什么 → 字段名漂移 → 类型不一致 → 下游无法消费

有 Schema：
  模型输出必须过 Schema 校验 → 不合规则重试/修复 → 下游消费可靠
```

---

## 2. 两者关系

Prompt Registry 和 Schema Registry 是**成对**的，每个 Skill 对应一份 Prompt + 一份 Schema：

```
Skill: ui
  ├── Prompt Registry → ui/prompt.md     告诉模型「怎么输出」
  └── Schema Registry → ui/schema.json   约束模型「输出什么结构」
```

```
┌──────────────┐         ┌──────────────┐
│Prompt Registry│         │Schema Registry│
│  (怎么输出)   │         │ (输出什么)    │
└──────┬───────┘         └──────┬───────┘
       │                        │
       │  Skill 执行时成对取出    │
       └───────────┬────────────┘
                   │
                   ▼
          ┌──────────────┐
          │Prompt Compiler│  模板 → 最终 Prompt
          └──────┬───────┘
                 │
                 ▼
          ┌──────────────┐
          │   Provider    │  推理
          └──────┬───────┘
                 │ rawOutput
                 ▼
          ┌──────────────┐
          │  Validator    │  按 Schema 校验
          └──────────────┘
```

---

## Part A: Prompt Registry

---

## 3. Prompt Registry 架构

### 3.1 目录结构

```
prompts/
├── _shared/                    跨 Skill 共享的 Prompt 片段
│   ├── json-output-rule.md     「只输出 JSON」通用规则
│   ├── no-markdown-rule.md     「不要 Markdown」通用规则
│   └── few-shot-header.md      Few-shot 示例头
│
├── classify/
│   ├── prompt.md               主 Prompt 模板
│   ├── few-shot.json           Few-shot 示例
│   └── variations/             Prompt 变体（A/B 测试）
│       ├── v1.md
│       └── v2.md
│
├── ui/
│   ├── prompt.md
│   └── few-shot.json
│
├── ocr/
│   ├── prompt.md
│   └── few-shot.json
│
└── ... (每个 Skill 一个目录)
```

### 3.2 设计原则

| 原则 | 说明 |
|------|------|
| 模板化 | Prompt 是带变量的模板，运行时填充 |
| 版本化 | 每次修改有版本号，可回滚 |
| 可测试 | 每个 Prompt 有对应的 Benchmark 测试集 |
| 共享片段 | 通用规则抽取为 _shared/，避免重复 |
| SmolVLM 优化 | Prompt 针对小模型特性优化，不是通用 Prompt |

---

## 4. Prompt 模板规范

### 4.1 模板语法

采用 Mustache 风格模板（`{{variable}}`）：

```markdown
{{> _shared/json-output-rule}}

You are a UI design expert.

Analyze the screenshot.

Return ONLY valid JSON with the following fields:
- layout: grid structure description
- components: array of UI components found
- theme: color theme
- typography: font characteristics

{{#if focus}}
Focus on: {{focus}}
{{/if}}

{{> _shared/no-markdown-rule}}

{{#each examples}}
Example {{@index}}:
Input: {{this.description}}
Output: {{this.output}}
{{/each}}
```

### 4.2 可用变量

| 变量 | 来源 | 说明 |
|------|------|------|
| `{{intent}}` | 用户输入 | 用户自然语言意图 |
| `{{focus}}` | Skill 参数 | 分析焦点（可选） |
| `{{metadata.width}}` | 元数据 | 图片宽度 |
| `{{metadata.height}}` | 元数据 | 图片高度 |
| `{{metadata.estimatedType}}` | 元数据 | 估算类型 |
| `{{metadata.complexity}}` | 元数据 | 复杂度 |
| `{{examples}}` | few-shot.json | Few-shot 示例 |
| `{{provider}}` | 运行时 | 当前 Provider 名 |

### 4.3 共享片段（Partial）

`_shared/json-output-rule.md`:
```markdown
IMPORTANT: Return ONLY valid JSON. Do not include any explanation, markdown formatting, or code blocks. Output raw JSON only.
```

`_shared/no-markdown-rule.md`:
```markdown
Do NOT wrap your response in markdown code blocks. Do NOT use ```json markers. Output the JSON directly.
```

> 这两个规则针对 SmolVLM 最常见的问题：输出带 ` ```json ` 标记或多余解释。

---

## 5. Prompt 编译流程（Prompt Compiler）

### 5.1 编译步骤

```
SkillTask（含 skill 名 + 参数）
        │
        ▼
┌──────────────────────┐
│ 1. 加载 Prompt 模板   │  prompts/<skill>/prompt.md
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ 2. 加载共享片段       │  _shared/*.md 注入
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ 3. 加载 Few-shot 示例 │  few-shot.json
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ 4. 填充变量           │  intent/metadata/focus
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ 5. 最终 Prompt        │  字符串
└──────────────────────┘
```

### 5.2 编译器接口

```typescript
interface PromptCompiler {
  /**
   * 编译 Skill 的 Prompt
   * @param skill Skill 名称
   * @param vars 模板变量
   * @returns 编译后的完整 Prompt 字符串
   */
  compile(skill: string, vars: PromptVars): Promise<string>;
}

interface PromptVars {
  intent: string;
  focus?: string;
  metadata: ImageMetadata;
  examples?: FewShotExample[];
}
```

### 5.3 编译示例

**输入**：
```typescript
compiler.compile("ui", {
  intent: "这个页面是什么风格",
  metadata: { width: 1920, height: 1080, estimatedType: "ui", complexity: "medium" },
});
```

**输出（最终 Prompt）**：
```
IMPORTANT: Return ONLY valid JSON. Do not include any explanation, markdown formatting, or code blocks. Output raw JSON only.

You are a UI design expert.

Analyze the screenshot.

Return ONLY valid JSON with the following fields:
- layout: grid structure description
- components: array of UI components found
- theme: color theme
- typography: font characteristics

Do NOT wrap your response in markdown code blocks. Do NOT use ```json markers. Output the JSON directly.

Example 1:
Input: Dashboard with sidebar
Output: {"layout":"sidebar+main","components":[{"type":"sidebar"},{"type":"chart"}],"theme":"dark","typography":"sans-serif"}
```

---

## 6. Few-shot 示例规范

### 6.1 为什么需要 Few-shot

SmolVLM-500M 是小模型，Zero-shot 输出不稳定的概率高。注入 1-3 个示例可显著提升输出格式稳定性。

### 6.2 few-shot.json 格式

```json
[
  {
    "description": "Dashboard with sidebar and charts",
    "image": "examples/dashboard.png",
    "output": {
      "layout": "sidebar + main content area",
      "components": [
        { "type": "sidebar", "position": "left" },
        { "type": "navbar", "position": "top" },
        { "type": "chart", "position": "center" }
      ],
      "theme": "dark",
      "typography": "sans-serif, medium weight"
    }
  },
  {
    "description": "Simple login form",
    "image": "examples/login.png",
    "output": {
      "layout": "centered card",
      "components": [
        { "type": "input", "position": "center" },
        { "type": "button", "position": "center" }
      ],
      "theme": "light",
      "typography": "sans-serif"
    }
  }
]
```

### 6.3 Few-shot 数量策略

```
简单 Skill（classify）：   1-2 个示例足够
复杂 Skill（ui / chart）：  2-3 个示例
不使用 Few-shot：          moderation（审核不需要示例，避免偏见）
```

> Few-shot 会占用 token 预算。SmolVLM 上下文有限，示例不宜过多。

---

## 7. Prompt 版本管理

### 7.1 版本号

```json
// prompts/ui/prompt.md 头部
{
  "version": "1.2.0",
  "changelog": [
    { "version": "1.0.0", "date": "2025-06-01", "change": "初始版本" },
    { "version": "1.1.0", "date": "2025-06-15", "change": "增加 no-markdown 规则" },
    { "version": "1.2.0", "date": "2025-06-30", "change": "优化 Few-shot 示例" }
  ]
}
```

### 7.2 变体与 A/B 测试

```
prompts/ui/variations/
├── v1.md     原始版本
└── v2.md     实验版本（如调整字段顺序）
```

```yaml
# config/prompts.yaml
prompts:
  ui:
    active: v1              # 当前使用版本
    benchmark: true         # 纳入 Benchmark 对比
```

### 7.3 Prompt Benchmark

每个 Prompt 版本需在固定测试集上评估：

```
benchmark/
├── fixtures/                固定测试图片
│   ├── ui/
│   │   ├── dashboard.png
│   │   ├── login.png
│   │   └── ...
│   └── ...
├── expected/                预期输出
│   ├── ui/
│   │   ├── dashboard.json
│   │   └── ...
│   └── ...
└── run-benchmark.ts         Benchmark 脚本
```

```typescript
// Benchmark 输出
Prompt: ui/prompt.md (v1.2.0)
  Fixtures: 20 images
  Schema Pass Rate: 95%     (19/20 输出通过 Schema 校验)
  Field Accuracy: 87%       (字段值与预期匹配率)
  Avg Latency: 1.2s
  
Prompt: ui/variations/v2.md
  Schema Pass Rate: 98%     (提升 3%)
  Field Accuracy: 91%       (提升 4%)
  Avg Latency: 1.3s
  
Decision: v2 可考虑替换 v1
```

---

## 8. SmolVLM 专用 Prompt 优化技巧

针对 SmolVLM-500M Q4_K_M 的特性，Prompt 设计遵循以下技巧：

### 8.1 明确输出格式

```markdown
✅ 好的 Prompt：
Return ONLY valid JSON with these fields:
- layout: string
- components: array

✅ 好的 Prompt：
Output format: {"layout": "...", "components": [...]}

❌ 差的 Prompt：
Please analyze the UI and tell me what you see.
（太模糊，小模型不知道输出什么格式）
```

### 8.2 禁止性规则前置

SmolVLM 最常见的输出问题：

```markdown
✅ 前置禁止规则：
Do NOT output markdown. Do NOT use ```json blocks. Do NOT explain.
Return raw JSON only.

❌ 后置禁止规则：
... (长 Prompt) ...
Oh and by the way, don't use markdown.
（小模型可能忽略后面的指令）
```

### 8.3 字段名简短明确

```markdown
✅ 短字段名：
- layout, theme, type, position

❌ 长字段名：
- layoutStructureDescription, colorThemeConfiguration
（浪费 token，小模型容易截断）
```

### 8.4 枚举值约束

```markdown
✅ 约束枚举：
theme must be one of: "dark", "light", "colorful"

❌ 开放式：
theme: describe the color theme
（小模型可能输出任意字符串）
```

### 8.5 Few-shot 示例覆盖边界情况

```
不只给「典型」示例，还要给：
- 空图片 / 纯色图片
- 极简 UI
- 复杂密集 UI
→ 让小模型学会处理各种输入
```

---

## Part B: Schema Registry

---

## 9. Schema Registry 架构

### 9.1 目录结构

```
schemas/
├── _shared/                    共享 Schema 定义
│   ├── bounding-box.json       通用边界框定义
│   ├── confidence.json         通用置信度定义
│   └── position.json           通用位置定义
│
├── classify.schema.json
├── ocr.schema.json
├── ui.schema.json
├── chart.schema.json
├── color.schema.json
├── object.schema.json
├── summary.schema.json
├── moderation.schema.json
└── ...
```

### 9.2 Schema 规范

- 标准：JSON Schema Draft-07
- 每个 Skill 必须有 schema.json
- 模型输出必须通过 Schema 校验
- Schema 变更走版本号

---

## 10. 各 Skill 的 Schema 定义

### 10.1 classify.schema.json

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "classify",
  "version": "1.0.0",
  "type": "object",
  "required": ["category", "confidence"],
  "additionalProperties": false,
  "properties": {
    "category": {
      "type": "string",
      "enum": ["dashboard", "chart", "diagram", "document", "poster",
               "ui", "photo", "logo", "icon", "map", "comic", "meme", "other"]
    },
    "confidence": {
    "type": "number",
      "minimum": 0,
      "maximum": 1
    },
    "subcategory": {
      "type": "string"
    }
  }
}
```

### 10.2 ocr.schema.json

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "ocr",
  "version": "1.0.0",
  "type": "object",
  "required": ["texts"],
  "properties": {
    "texts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["text"],
        "properties": {
          "text": { "type": "string" },
          "position": {
            "type": "string",
            "enum": ["top-left", "top", "top-right", "left", "center",
                     "right", "bottom-left", "bottom", "bottom-right"]
          },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
        }
      }
    },
    "language": { "type": "string" }
  }
}
```

### 10.3 ui.schema.json

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "ui",
  "version": "1.0.0",
  "type": "object",
  "required": ["layout", "components"],
  "properties": {
    "layout": { "type": "string" },
    "components": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["type"],
        "properties": {
          "type": {
            "type": "string",
            "enum": ["navbar", "sidebar", "header", "footer", "button",
                     "input", "card", "chart", "table", "image", "text",
                     "icon", "modal", "tab", "menu", "breadcrumb", "other"]
          },
          "position": { "type": "string" },
          "count": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "theme": { "type": "string", "enum": ["dark", "light", "colorful"] },
    "typography": { "type": "string" },
    "spacing": { "type": "string" }
  }
}
```

### 10.4 chart.schema.json

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "chart",
  "version": "1.0.0",
  "type": "object",
  "required": ["type"],
  "properties": {
    "type": {
      "type": "string",
      "enum": ["bar", "line", "pie", "scatter", "area", "radar",
               "heatmap", "tree", "gauge", "combo", "other"]
    },
    "title": { "type": "string" },
    "axes": {
      "type": "object",
      "properties": {
        "x": { "type": "string" },
        "y": { "type": "string" }
      }
    },
    "series": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "dataPoints": { "type": "integer" }
        }
      }
    },
    "legend": { "type": "boolean" }
  }
}
```

### 10.5 color.schema.json

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "color",
  "version": "1.0.0",
  "type": "object",
  "required": ["palette"],
  "properties": {
    "palette": {
      "type": "array",
      "minItems": 1,
      "maxItems": 10,
      "items": {
        "type": "object",
        "required": ["hex"],
        "properties": {
          "hex": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
          "role": {
            "type": "string",
            "enum": ["primary", "secondary", "accent", "background",
                     "text", "border", "success", "warning", "error"]
          },
          "name": { "type": "string" }
        }
      }
    },
    "scheme": { "type": "string", "enum": ["monochrome", "analogous", "complementary", "triadic", "other"] }
  }
}
```

---

## 11. Schema 校验流程

### 11.1 校验链条

```
模型原始输出 (string)
      │
      ▼
┌─────────────┐
│ JSON Parse  │  解析为对象
└──────┬──────┘
       │ 失败 → 修复（去 Markdown / 提取 JSON 片段）
       │       → 仍失败 → 重试
       ▼
parsed (object)
      │
      ▼
┌──────────────┐
│Schema Validate│  对照 schema.json
└──────┬───────┘
       │ 失败：
       │   必填缺失 → 重试（强化 Prompt）
       │   可选缺失 → 默认值填充
       │   类型错误 → 尝试转换
       │   枚举不匹配 → 取最接近的
       ▼
validated (object)
      │
      ▼
┌──────────────┐
│Custom Validator│  Skill 专属校验（可选）
└──────┬───────┘
       │
       ▼
finalResult
```

### 11.2 自动修复策略

| 问题 | 修复策略 |
|------|---------|
| 输出含 ` ```json ` 标记 | 正则去除 Markdown 代码块标记 |
| 输出前后有多余文本 | 提取第一个 `{...}` JSON 片段 |
| JSON 缺少闭合括号 | 补全 `}` |
| 必填字段缺失 | 重试（Prompt 追加「上次缺少字段 X」） |
| 可选字段缺失 | 填充默认值（如 `confidence: 0.5`） |
| 类型错误（string→number） | 尝试类型转换 |
| 枚举值不匹配 | 取编辑距离最近的合法枚举值 |

### 11.3 校验器接口

```typescript
interface ResponseValidator {
  /**
   * 校验模型输出
   * @returns 校验结果（含是否通过、修复后数据、是否需重试）
   */
  validate(
    rawOutput: string,
    schema: object,
    options?: ValidatorOptions
  ): ValidationResult;
}

interface ValidationResult {
  valid: boolean;
  data?: any;              // 修复后的数据
  shouldRetry: boolean;    // 是否需要重试
  retryHint?: string;      // 重试时的 Prompt 提示（如「上次缺少 layout 字段」）
  repairs?: string[];      // 执行了哪些修复
}

interface ValidatorOptions {
  maxRetries: number;
  enableAutoRepair: boolean;
}
```

---

## 12. Schema 版本管理

### 12.1 版本字段

每个 Schema 包含 `version` 字段：

```json
{
  "$id": "ui",
  "version": "1.2.0",
  ...
}
```

### 12.2 变更规则

| 变更类型 | 版本影响 | 向后兼容 |
|----------|---------|---------|
| 新增可选字段 | minor | ✅ 兼容 |
| 新增枚举值 | minor | ✅ 兼容 |
| 新增必填字段 | major | ❌ 破坏性 |
| 删除字段 | major | ❌ 破坏性 |
| 修改字段类型 | major | ❌ 破坏性 |

### 12.3 版本协商

```typescript
// 结果中记录 Schema 版本
{
  "structuredContent": {
    ...,
    "result": {
      "ui": {
        "_schemaVersion": "1.2.0",
        "layout": "...",
        ...
      }
    }
  }
}
```

Client 可据此判断结果结构版本。

---

## 13. 共享 Schema 片段

### 13.1 _shared/bounding-box.json

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "bounding-box",
  "type": "object",
  "properties": {
    "x": { "type": "number", "minimum": 0 },
    "y": { "type": "number", "minimum": 0 },
    "width": { "type": "number", "minimum": 0 },
    "height": { "type": "number", "minimum": 0 }
  }
}
```

### 13.2 引用共享片段

```json
{
  "$ref": "bounding-box#/properties"
}
```

---

## 14. 接口定义

### PromptRegistry
```typescript
interface PromptRegistry {
  /** 获取 Skill 的 Prompt 模板 */
  get(skill: string, version?: string): Promise<PromptTemplate>;

  /** 列出所有 Prompt */
  list(): PromptInfo[];

  /** 注册新 Prompt 版本 */
  register(skill: string, template: string): Promise<void>;
}

interface PromptTemplate {
  skill: string;
  version: string;
  template: string;         // 模板内容
  sharedPartials: string[]; // 引用的共享片段
}
```

### SchemaRegistry
```typescript
interface SchemaRegistry {
  /** 获取 Skill 的 Schema */
  get(skill: string, version?: string): Promise<object>;

  /** 列出所有 Schema */
  list(): SchemaInfo[];

  /** 注册新 Schema */
  register(skill: string, schema: object): Promise<void>;
}

interface SchemaInfo {
  skill: string;
  version: string;
  requiredFields: string[];
}
```

---

## 15. 测试要点

### Prompt 测试
| 场景 | 预期 |
|------|------|
| Prompt 模板变量填充 | 变量正确替换 |
| 共享片段注入 | _shared/ 内容出现在最终 Prompt |
| Few-shot 示例注入 | 示例正确格式化 |
| Prompt 版本切换 | 不同版本产出不同 Prompt |
| Benchmark 运行 | 输出 Schema Pass Rate 和 Field Accuracy |

### Schema 测试
| 场景 | 预期 |
|------|------|
| 合法 JSON 输出 | 校验通过 |
| 含 Markdown 标记 | 修复后通过 |
| 必填字段缺失 | shouldRetry = true |
| 可选字段缺失 | 默认值填充，valid = true |
| 枚举值不匹配 | 取最近合法值 |
| 类型错误 | 转换后通过 |
| 重试耗尽 | valid = false，返回错误 |

---

## 16. 本文小结

Prompt Registry 与 Schema Registry 是 SmolVLM 输出质量的核心保障：

1. **Prompt 不是临时拼的** —— 模板化、版本化、可 Benchmark
2. **共享片段复用** —— 「只输出 JSON」「不要 Markdown」等规则统一管理
3. **Few-shot 提升稳定性** —— 1-3 个示例显著改善小模型输出格式
4. **SmolVLM 专用优化** —— 禁止规则前置、短字段名、枚举约束
5. **Schema 强制约束** —— 模型输出必须过校验
6. **自动修复** —— Markdown 去除、JSON 片段提取、类型转换、枚举匹配
7. **版本管理** —— Schema 变更走语义化版本
8. **Benchmark 驱动** —— Prompt 优化以数据说话，不靠猜

> 下一篇：[10 - 错误处理](./10-error-handling.md)
