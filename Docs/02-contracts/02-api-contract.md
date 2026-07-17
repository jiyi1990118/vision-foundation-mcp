# 02 - API 契约（API Contract）

> 本文档定义对外的稳定契约。一旦发布，不轻易破坏性变更。新增字段允许，删除/重命名禁止。

---

## 1. MCP Tool 定义

整个服务只暴露**一个** MCP Tool：

```json
{
  "name": "vision.analyze",
  "description": "Analyze an image and return structured vision understanding result.",
  "inputSchema": { ... },
  "outputFormat": "content + structuredContent"
}
```

> 为什么只有一个 Tool？见 [ADR-001](../04-decisions/ADR-001-single-tool.md)

---

## 2. 请求契约（inputSchema）

### 2.1 完整 Schema
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["image"],
  "properties": {
    "image": {
      "description": "Image to analyze. Supports file path, base64, URL, data URI, Buffer.",
      "oneOf": [
        { "type": "string", "minLength": 1 }
      ]
    },
    "intent": {
      "type": "string",
      "description": "Natural language intent. e.g. 'extract text', 'analyze UI'. Empty or 'auto' for automatic analysis.",
      "default": "auto"
    },
    "scene": {
      "type": "string",
      "description": "Scene hint to guide parsing (e.g. requirement, ui, code, chart). Guides but does not override image evidence.",
      "default": ""
    },
    "skills": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Explicitly specify skills to run. Overrides intent inference."
    },
    "options": {
      "type": "object",
      "properties": {
        "quality": {
          "type": "string",
          "enum": ["fast", "high"],
          "default": "fast"
        },
        "provider": {
          "type": "string",
          "description": "Force a specific provider. e.g. 'smolvlm2'."
        },
        "cache": {
          "type": "boolean",
          "default": true
        },
        "maxTokens": {
          "type": "number",
          "default": 1024
        },
        "target": {
          "type": "object",
          "description": "Optional target-region hint for annotated screenshots.",
          "properties": {
            "color": { "type": "string", "description": "e.g. red / 红色" },
            "position": { "type": "string", "description": "e.g. right / left / top / bottom / 右侧" },
            "description": { "type": "string", "description": "Natural language description of the target region." }
          }
        }
      }
    }
  }
}
```

### 2.2 请求示例

**基础分析**：
```json
{
  "image": "/path/to/screenshot.png",
  "intent": "analyze this UI"
}
```

**自动分析**：
```json
{
  "image": "data:image/png;base64,iVBOR...",
  "intent": "auto"
}
```

**指定 Skill + 高质量**：
```json
{
  "image": "https://example.com/dashboard.png",
  "skills": ["classify", "table", "summary"],
  "options": { "quality": "high" }
}
```

> 注：`chart` 不是 Skill 而是场景抽取器（scenario extractor）。可用 Skill 见 §5。`scene` 参数（见 §2.1）可引导 `result.parse` 的场景判定，如 `"scene": "requirement"`。

**不使用缓存**：
```json
{
  "image": "/path/to/image.jpg",
  "intent": "extract text",
  "options": { "cache": false }
}
```

**提取红框/目标区域内容**：
```json
{
  "image": "/path/to/admin-ui.png",
  "intent": "提取红色虚线框中的内容",
  "options": {
    "target": {
      "color": "red",
      "position": "right",
      "description": "红色虚线框中的表格内容"
    }
  }
}
```

说明：`options.target` 会在未显式指定 `skills` 时自动补充 `ocr`。若用户显式传入 `skills`，显式 skills 仍保持权威，不会被自动增补。`options.target.color` 支持 5 色：`red` / `blue` / `green` / `yellow` / `magenta`（含中文别名如 红色 / 蓝框 / 紫框）。

### 2.3 输入格式支持

| 格式 | 示例 | 说明 |
|------|------|------|
| 文件路径 | `/path/to/img.png` | 本地文件 |
| base64 | `iVBORw0KGgo...` | 纯 base64 字符串 |
| data URI | `data:image/png;base64,...` | 带 MIME 的 data URI |
| HTTP URL | `https://example.com/img.png` | 远程图片（会下载） |

---

## 3. 响应契约

### 3.1 成功响应结构
```json
{
  "content": [
    {
      "type": "text",
      "text": "Vision analysis completed."
    }
  ],
  "structuredContent": {
    "category": "dashboard",
    "confidence": 0.95,
    "summary": "销售仪表盘，包含柱状图和KPI卡片",
    "skills": ["classify", "ocr", "summary"],
    "result": {
      "classify": { ... },
      "ocr": { ... },
      "summary": { ... }
    },
    "metadata": {
      "provider": "smolvlm2",
      "runtime": "onnx",
      "duration": 1200,
      "cached": false
    }
  }
}
```

### 3.2 structuredContent 字段定义

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `category` | string | 是 | 图片整体类别 |
| `confidence` | number | 是 | 置信度 0-1 |
| `summary` | string | 是 | 文本摘要 |
| `skills` | string[] | 是 | 执行的 Skill 列表 |
| `result` | object | 是 | 各 Skill 的结构化结果 |
| `result.<skill>` | object | 否 | 单个 Skill 的输出（按其 schema）。8 个 Skill：classify / summary / ocr / table / document / poster / moderation / layout |
| `result.ui` | object | 否 | **非 Skill**，算法式产出 `UiEvidence`：`{ likelyPageType, navigation, actions, fields, tableHeaders, values, modules, rawTextCount, title? }` |
| `result.layout` | object | 否 | 算法式产出的布局结构（基于 OCR 坐标，如左侧菜单、主内容表头、底部操作） |
| `result.parse` | object | 否 | 通用解析（UniversalParse）：`scene` / `quality` / `layout` / `ocr.corrected` / `entities` / `relationships` / `logic` / `summary` / `insights` / `risks` / `next_actions` / `confidence`，类型见 [01-domain-model §4.9](./01-domain-model.md) |
| `result.annotations` | object | 否 | 检测到的彩色标注框。支持 5 色：`red` / `blue` / `green` / `yellow` / `magenta`，含 `coloredBoxes` 与 `redBoxes`（向后兼容） |
| `result.targetExtraction` | object | 否 | 目标区域/红框关键内容提取（KeyContentExtraction）：`query` / `matchedRegion{type,box,confidence,color?}` / `textLines` / `table?` / `fields?` / `summary` / `warnings` / `allExtractions?`（多框时每框一项） |
| `ocrText` | string | 否 | 顶层完整 OCR 文本，方便 LLM 直接消费 |
| `metadata` | object | 是 | 元信息 |
| `metadata.provider` | string | 是 | 使用的 Provider |
| `metadata.runtime` | string | 是 | 使用的 Runtime |
| `metadata.duration` | number | 是 | 总耗时(ms) |
| `metadata.cached` | boolean | 是 | 是否命中缓存 |

### 3.3 目标区域提取示例

```json
{
  "result": {
    "targetExtraction": {
      "query": { "color": "red", "position": "right", "description": "红色虚线框中的表格内容" },
      "matchedRegion": {
        "type": "redBox",
        "box": "1450,500,1918,1090",
        "confidence": 0.75,
        "color": "red"
      },
      "textLines": ["默认基础价-半份（元）", "默认附加价-半份（元）"],
      "table": {
        "columns": ["默认基础价-半份（元）", "默认附加价-半份（元）"],
        "rows": [
          ["0.00 ¥", "0.00 ¥"],
          ["0.00 ¥", "0.00 ¥"]
        ]
      },
      "fields": [{ "label": "默认基础价-半份", "value": "0.00 ¥" }],
      "summary": "关键区域包含：默认基础价-半份（元）；默认附加价-半份（元）。",
      "warnings": ["局部 OCR 将金额符号候选“夫”按金额上下文归一化为“¥”"]
    }
  }
}
```

> 多个标注框同时存在时，每个框各产生一次提取，汇总在 `allExtractions`（数组）；顶层字段为首个框的结果（向后兼容）。

### 3.4 部分成功响应
某些 Skill 失败时，仍返回成功的部分：
```json
{
  "structuredContent": {
    "category": "document",
    "confidence": 0.88,
    "summary": "文档图片",
    "skills": ["classify", "ocr", "document"],
    "result": {
      "classify": { "category": "document", "confidence": 0.88 },
      "ocr": { "error": "skill_inference_failed", "partial": true },
      "document": { "type": "invoice", "fields": { ... } }
    },
    "metadata": { "provider": "smolvlm2", "runtime": "gguf", "duration": 8500, "cached": false }
  }
}
```

---

## 4. 错误响应契约

### 4.1 错误结构
```json
{
  "content": [
    {
      "type": "text",
      "text": "Vision analysis failed: MODEL_DOWNLOAD_FAILED"
    }
  ],
  "isError": true,
  "structuredContent": {
    "error": {
      "code": "MODEL_DOWNLOAD_FAILED",
      "message": "Failed to download smolvlm2 model",
      "retryable": true
    }
  }
}
```

### 4.2 错误码

**当前已实现**（`classifyVisionError` 实际抛出）：

| 错误码 | 含义 | 可重试 |
|--------|------|--------|
| `NORMALIZE_INVALID_INPUT` | 输入格式不支持/文件损坏 | 否 |
| `POLICY_DENIED` | 策略拒绝（如超大图） | 否 |
| `TIMEOUT` | 推理超时 | 是 |
| `RUNTIME_NOT_FOUND` | 无可用 Runtime / llama-server 未找到 | 否 |
| `MODEL_DOWNLOAD_FAILED` | 模型下载失败 | 是 |
| `MODEL_CORRUPTED` | 模型校验失败（checksum） | 是 |
| `INTERNAL_ERROR` | 未知内部错误 | 是 |

**Aspirational（规划中，当前未抛出）**：`PROVIDER_UNAVAILABLE`、`RESOURCE_INSUFFICIENT`、`SKILL_VALIDATION_FAILED`、`SKILL_RETRY_EXHAUSTED`。这些错误码在术语表保留，但 `classifyVisionError` 尚未产生。

---

## 5. Skill 输出 Schema 示例

每个 Skill 有独立 schema，以下是几个典型示例：

### 5.1 classify.schema.json
```json
{
  "type": "object",
  "required": ["category", "confidence"],
  "properties": {
    "category": {
      "type": "string",
      "enum": ["dashboard","chart","diagram","document","poster","ui","screenshot","photo","illustration","logo","icon","map","comic","meme","other"]
    },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "subcategory": { "type": "string" },
    "reasoning": { "type": "string", "description": "Brief chain-of-thought: what you see, then why you chose this category." }
  }
}
```

> 枚举共 15 个值（含 `screenshot` / `illustration` / `other`）。

### 5.2 ocr.schema.json
```json
{
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
          "position": { "type": "string", "description": "粗粒度区域（如 center/top-left）或坐标框字符串 x1,y1,x2,y2（专用 OCR provider）" },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
        }
      }
    },
    "language": { "type": "string" }
  }
}
```

### 5.3 ui —— 非 Skill（算法式 UiEvidence）

`ui` **不是** Skill，`src/skills/` 下没有 `ui` 目录。`result.ui` 由 `composeResult` 基于 OCR 文本算法式产出（`buildUiEvidence`），无需 VLM 调用。其结构 `UiEvidence`（定义于 `src/core/skill-pipeline.ts`）：

```typescript
interface UiEvidence {
  likelyPageType: "admin-ui" | "mobile-ui";
  navigation: string[];
  actions: string[];
  fields: string[];
  tableHeaders: string[];
  values: string[];
  modules: string[];
  rawTextCount: number;
  title?: string;
}
```

> 同理 `result.layout` 也是算法式产出，非 Skill。

---

## 6. 契约版本管理

### 6.1 版本号
```json
{
  "structuredContent": {
    ...,
    "metadata": {
      ...,
      "schemaVersion": "1.0.0"
    }
  }
}
```

### 6.2 变更规则
| 变更类型 | 是否破坏性 | 处理方式 |
|----------|-----------|---------|
| 新增可选字段 | 否 | 直接加，版本号 patch |
| 新增 Skill | 否 | 直接加 |
| 新增错误码 | 否 | 直接加 |
| 删除字段 | 是 | 禁止，需走 v2 + 废弃周期 |
| 重命名字段 | 是 | 禁止，需走 v2 + 废弃周期 |
| 修改字段类型 | 是 | 禁止，需走 v2 |

### 6.3 废弃周期
```
v1.0 字段 A → v1.1 标记 deprecated（仍可用，日志警告）→ v2.0 删除
```

---

## 7. 本文小结

API 契约核心要点：

1. **单 Tool** —— 只有 `vision.analyze` 一个入口
2. **输入灵活** —— 文件/base64/URL/data URI 全支持
3. **输出统一** —— content + structuredContent
4. **部分成功** —— 单 Skill 失败不阻断整体返回
5. **错误规范** —— 统一错误码 + 可重试标记
6. **契约稳定** —— 只增不删，破坏性变更走版本号

> 下一篇：[03 - 分层规则](./03-layer-rules.md)
