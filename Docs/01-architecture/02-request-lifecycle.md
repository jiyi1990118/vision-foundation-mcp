# 02 - 请求生命周期（Request Lifecycle）

> 本文档详述一张图片从 `vision.analyze()` 进入到 `structuredContent` 返回的完整过程。是开发时对齐各模块行为的标准参照。

---

## 1. 生命周期总览

```
Request 接收
    │  阶段 1：image / intent / scene / skills / options
    ▼
Normalize 归一化
    │  阶段 2：file/base64/buffer/http/data-uri → ImageInput
    ▼
Metadata 提取
    │  阶段 3：宽高/格式/hasAlpha/fileSize + 复杂度启发式（不调大模型）
    ▼
硬件检测 + Provider 路由
    │  阶段 4：detectHardware + selectProvider（M5 路由，Provider 选择唯一权威）
    ▼
Planner 决策
    │  阶段 5：ExecutionPlan（provider/skills/preprocess/retry/maxTokens?/cache?）
    ▼
Policy 策略校验
    │  阶段 6：硬编码 DEFAULT_RULES（large-image-resize / memory-guard 仅告警 / reject-huge）
    ▼
Cache 命中检查（未实现）
    │  阶段 7：cached 硬编码 false；仅 Provider 层推理缓存
    ▼
Skill Pipeline 执行
    │  阶段 8：取 Prompt/Schema → infer → 内联校验/修复/重试（abort signal）
    ▼
后置增强
    │  阶段 9：标注检测(5色) / 关键内容提取 / 场景提取器 / VLM reasoning
    ▼
Compose 组合
    │  阶段 10：composeResult → VisionResult + result.parse（UniversalParse）
    ▼
Return 返回
    │  阶段 11：MCP 响应（content + structuredContent）
    ▼
Cache 写入（未实现）
       阶段 12：请求级结果缓存
```

---

## 2. 阶段详解

### 阶段 1：Request 接收

**位置**：L0 Tool Layer（`src/tools/vision-analyze.ts`）

**输入**（MCP 请求）：
```typescript
{
  image: string | Buffer | Uint8Array,  // 图片输入
  intent?: string,                       // 用户意图（自然语言）
  scene?: string,                        // 场景提示（requirement/chart/diagram/invoice/code/form/...）
  skills?: string[],                     // 指定 Skill（可选）
  options?: {
    quality?: "fast" | "high",           // 质量模式
    provider?: string,                   // 指定 Provider（可选）
    cache?: boolean,                     // 是否使用缓存
    maxTokens?: number,
    target?: {                           // 目标区域提示（红框/高亮/指定区域）
      color?: string,
      position?: string,
      description?: string,
    },
  }
}
```

**职责**：
- 校验请求基本合法性（image 非空）
- 不做业务逻辑，直接转交 Request Layer

**输出**：原始请求对象

---

### 阶段 2：Normalize 归一化

**位置**：L1 Request Layer - Request Normalizer（`normalizeImageInput`）

**职责**：将多种输入格式统一为 `ImageInput`

**支持输入格式**：
```
file:///path/to/image.png
base64 字符串
Buffer / Uint8Array
http(s)://url/to/image.png
data:image/png;base64,xxxx
```

**统一输出**：
```typescript
interface ImageInput {
  buffer: Buffer;          // 统一的二进制
  mimeType: string;        // image/png | image/jpeg | image/webp
  source: string;          // 原始来源标记
  size: number;            // 字节大小
}
```

**边界**：
- 格式转换、解码
- 大小校验（防 OOM，见安全设计）
- 不做内容理解（那是后面的事）

---

### 阶段 3：Metadata 提取

**位置**：L1 Request Layer - Metadata Extractor（`extractMetadata`）

**职责**：用轻量算法（不调大模型）提取图片元信息与复杂度估算

**提取内容**：
```typescript
interface ImageMetadata {
  width: number;
  height: number;
  aspectRatio: number;
  format: string;            // png/jpeg/webp
  hasAlpha: boolean;
  fileSize: number;
  complexity: "low" | "medium" | "high";  // 像素数 + fileSize 启发式
  estimatedType?: string;    // UI/document/photo/chart（可选估算）
}
```

**复杂度估算方法**（无需大模型）：
| 指标 | 方法 | 用途 |
|------|------|------|
| 像素数 + 文件大小 | 直接读取 + 启发式 | 综合估算复杂度（low/medium/high） |
| 尺寸/比例 | 直接读取 | 判断是否 UI 截图 |

> 注意：当前**不包含** colorCount、边缘检测、颜色直方图、文本区域形态学等指标；复杂度仅为 pixels + fileSize 的轻量启发式，这一步**绝不调用大模型**。

---

### 阶段 4：硬件检测与 Provider 路由

**位置**：L1/L2 - `runtime-detector.ts` + `provider-router.ts`

**职责**：
- `detectHardware()`：检测 CPU / 内存 / GPU / 可用 Runtime
- `selectProvider()`（M5 路由）：根据请求的 `quality` / `provider` 选项、检测到的硬件资源、所需 Skill，从已注册 Provider 中选出最合适的实例

**路由规则**：
- 默认 / 活动 Provider 为 `gguf-smolvlm2`
- `VISION_HIGH_QUALITY=1` 时注册 `minicpm-v`，`quality=high` 请求可路由到它（首次懒加载，约 2GB 下载）
- `VISION_OCR_PROVIDER=ppu-paddle-ocr` 可注册专用 OCR-only Provider，混合请求中 `ocr` skill 由其执行
- **路由是 Provider 选择的唯一权威**：Planner 不再硬编码改写 Provider，`memory-guard` 规则仅告警不覆盖

**输出**：选定的 Provider 实例（供后续 Pipeline 调用 `infer()`）

---

### 阶段 5：Planner 决策

**位置**：L2 Decision Layer - Execution Planner（`planExecution`）

**输入**：
```
NormalizedRequest = ImageInput + ImageMetadata + Intent + Scene + Options + MachineResources + 选定 Provider
```

**职责**：综合以下因素，生成 `ExecutionPlan`
- **用户意图 / 场景**：意图 → Skill 映射（`INTENT_MAPPINGS`）
- **图片信息**：尺寸/复杂度/估计类型
- **机器资源 + 选定 Provider**

**输出**（ExecutionPlan）：
```typescript
interface ExecutionPlan {
  provider: string;              // gguf-smolvlm2 / gguf-smolvlm / minicpm-v / smolvlm / ppu-paddle-ocr
  runtime: string;               // llama-cpp / onnx
  preprocess: string[];          // ["resize", "normalize"]
  skills: SkillTask[];           // 要执行的 Skill 列表
  postprocess: string[];         // ["merge"]
  cacheKey: string;              // 缓存键
  timeout: number;               // 超时(ms)
  retry: { max: number; strategy: string };
  maxTokens?: number;            // 推理 token 上限（可选）
  cache?: boolean;               // 是否使用推理缓存（可选）
}

interface SkillTask {
  skill: string;                 // classify / ocr / table ...
  prompt: string;                // 从 Prompt Registry 取
  schema: object;                // 从 Schema Registry 取
  priority: number;
  dependsOn?: string[];          // 依赖的前置 Skill
  condition?: (ctx) => boolean;  // 执行条件（可选，按上下文跳过）
}
```

> Planner 详见 [03-execution-planner.md](./03-execution-planner.md)

**关键原则**：Planner **只产出计划，不执行**。

---

### 阶段 6：Policy 策略校验

**位置**：L2 Decision Layer - Policy Engine（`evaluatePolicy`）

**职责**：按**硬编码** `DEFAULT_RULES`（`src/core/policy-engine.ts`，**非 policy.yaml**）校验/调整草稿 Plan

**规则清单**：
| 规则 | 触发 | 动作 |
|------|------|------|
| `large-image-resize` | width > 3000 | 追加 resize 预处理 |
| `memory-guard` | 可用内存 < 1024MB | **仅告警，不覆盖 Provider** |
| `reject-huge` | size > 50MB | 拒绝 |

**输出**：最终 `ExecutionPlan`（可能被策略追加预处理或拒绝；不覆盖 Provider）

> Policy 详见 [04-policy-engine.md](./04-policy-engine.md)

---

### 阶段 7：Cache 命中检查（未实现）

**位置**：L6 Infrastructure

**现状**：**未实现**。`cached` 硬编码为 `false`，无请求级结果缓存（无独立 Cache Manager 模块）。仅 Provider 层（`BaseLlamaCppProvider`）有推理缓存（Map，TTL 1h，LRU 100，key = imgHash:promptHash:paramsHash）。

```
规划形态：命中 → 直接返回缓存的 structuredContent（跳过阶段 8-10）
         未命中 → 继续执行
```

---

### 阶段 8：Skill Pipeline 执行

**位置**：L3 Skill Layer - Skill Pipeline（`pipeline.execute`）

**职责**：按 Plan.skills 依次（或并行）执行每个 Skill，带 retry 与 abort signal

**单个 Skill 执行流程**：
```
SkillTask
   │
   ├──[8a] Prompt Compiler
   │        从 Prompt Registry 取 prompt template
   │        填充变量（intent、metadata、scene）
   │        生成最终 prompt
   │
   ├──[8b] Schema 取出
   │        从 Schema Registry 取该 Skill 的 schema.json
   │
   ├──[8c] 调用 Provider.infer()
   │        │
   │        └── Provider 委托 LlamaServerProcess / onnxruntime
   │               │
   │               └── 执行模型推理
   │                      （模型由 BaseLlamaCppProvider 引用计数 + idle 保留）
   │
   └──[8d] 内联校验/修复/重试
            JSON Parse → 失败则修复（提取 JSON 片段 / 去 Markdown）
            → Schema 校验 → 失败则轻量重试（最多 retry.max 次，调整 prompt）
            → 暂存 InferenceResponse
```

**多 Skill 编排**：
- 独立 Skill：可并行
- 有依赖的 Skill：串行（如先 classify 再 layout）
- 混合 OCR 分析：`ocr` 和 `classify` 可并行，`summary` 同时等待 `ocr` + `classify`
- `condition?` 命中时跳过该 Skill
- OCR Provider override：混合请求中若注册了 `ppu-paddle-ocr`，`ocr` skill 可由专用 OCR Provider 执行，其他 skill 仍由 VLM Provider 执行
- 由 Pipeline 按依赖图调度

> 说明：**无独立 ResponseValidator 模块**，校验/修复/重试内联于 SkillPipeline。

---

### 阶段 9：后置增强（Post-pipeline Enrichment）

**位置**：`vision-analyze.ts` 在 Pipeline 完成后、Compose 之前执行的一组增强步骤

**职责**：基于 Pipeline 产出（尤其 OCR 文本）做确定性结构化增强与一次聚焦 VLM reasoning

| 步骤 | 模块 | 触发条件 | 产出 |
|------|------|----------|------|
| a. 标注检测 | `annotation-detector.ts` | OCR 成功且命中 target / 标注 intent | `result.annotations`（多色，最多 5 色） |
| b. 关键内容提取 | `key-content-extractor.ts` | requirement 场景 | `result.targetExtraction`（结合全图 + 局部裁剪 OCR） |
| c. 场景提取 | `src/core/extractors/`（`scenario-dispatcher` 路由） | chart / diagram / invoice / code / form 场景 | 对应场景的结构化抽取结果 |
| d. VLM reasoning | `universal-parser.ts`（`runReasoning`） | 存在可用上下文 | insights / risks / next_actions（**无上下文则跳过**） |

**关键原则**：
- 标注检测支持多色（5 色）红框/高亮/目标区域
- `targetExtraction` 结合全图 OCR 与局部裁剪 OCR，输出 `textLines`、表格列/行、warnings，避免邻近框外文本混入
- VLM reasoning 是**一次聚焦调用**，产出 insights / risks / next_actions；若无可用上下文则跳过该调用

---

### 阶段 10：Compose 组合

**位置**：L3 Skill Layer - `composeResult`（`src/core/skill-pipeline.ts`）

**职责**：将多个 Skill 结果与后置增强产出合并为统一的 `structuredContent`，并构造 Universal Vision Parser

OCR 成功时，Composer 会额外构造：

- 顶层 `ocrText`：完整 OCR 文本，方便调用方或 LLM 直接消费
- `result.ui`：面向后台/UI 截图的结构化摘要，如导航、动作、字段、表头和值（算法化构造，非独立 Skill）
- `result.layout`：基于 OCR 坐标的左侧栏、主内容、底部按钮等布局结构（算法化构造，非独立 Skill）

**输出结构**：
```typescript
interface VisionResult {
  category: string;          // 图片类别
  confidence: number;        // 置信度
  summary: string;           // 文本摘要
  skills: string[];          // 执行了哪些 Skill
  result: {                  // 各 Skill 的结构化结果
    [skillName: string]: any;
    ui?: object;
    layout?: object;
    annotations?: object;
    targetExtraction?: object;
    parse?: object;          // UniversalParse：insights / risks / next_actions
  };
  ocrText?: string;
  metadata: {
    provider: string;
    runtime: string;          // 推理 Runtime（如 llama-cpp / onnx）
    duration: number;        // 耗时
    cached: boolean;          // 当前恒为 false（请求级缓存未实现）
  };
}
```

> `result.parse`（UniversalParse）由 `universal-parser.ts` 的 `buildUniversalParse` 生成，聚合阶段 9 的 reasoning 与各 Skill 要点。

---

### 阶段 11：Return 返回

**位置**：L0 Tool Layer

**职责**：包装为 MCP 标准响应

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
    "confidence": 0.98,
    "summary": "销售仪表盘，含柱状图与KPI卡片",
    "skills": ["classify", "ocr", "summary"],
    "result": {
      "parse": { "insights": [], "risks": [], "next_actions": [] }
    },
    "ocrText": "菜单中心\nPOS分类管理\n保存",
    "metadata": {
      "provider": "gguf-smolvlm2",
      "runtime": "llama-cpp",
      "duration": 1200,
      "cached": false
    }
  }
}
```

---

### 阶段 12：Cache 写入（未实现）

**位置**：L6 Infrastructure

**现状**：**未实现**。无请求级结果缓存写入。仅 Provider 层推理缓存（见阶段 7）。

```
规划形态：写入策略 = TTL 过期 + LRU 淘汰 + 写入不阻塞返回（key = SHA256(image) + intent + skills）
```

---

## 3. 异常路径

### 3.1 归一化失败
```
输入格式不支持 / 文件损坏
  → 抛出 NormalizeError（错误码 INVALID_INPUT）
  → 直接返回错误，不进入后续流程
```

### 3.2 模型未加载
```
首次调用 / 模型未缓存
  → Model Manager 自动下载 + 校验（SHA-256，VISION_VERIFY_CHECKSUMS=1）
  → BaseLlamaCppProvider 加载（引用计数 + idle 保留）
  → 期间请求等待或返回「正在准备」
```

### 3.3 推理超时
```
Provider.infer() 超过 plan.timeout
  → 中断推理（abort signal）
  → 按 retry.strategy 决定是否重试
  → 重试耗尽 → 返回 TimeoutError
```

### 3.4 校验失败
```
重试 retry.max 次仍无法通过 Schema 校验
  → 返回 PartialResult（已成功的 Skill）+ 错误标记
  → 不返回完全空结果（尽力而为）
```

### 3.5 内存不足
```
检测到可用内存低于阈值
  → BaseLlamaCppProvider 卸载空闲模型（memory-guard 仅告警）
  → 拒绝新的大图请求（reject-huge）
  → 返回 ResourceError
```

---

## 4. 关键时序图

```
Client   Tool    Normalizer   Router    Planner   Policy   Pipeline   Provider   Runtime
  │        │         │          │         │         │         │          │          │
  │─analyze──────────│          │         │         │         │          │          │
  │        │─req────►│          │         │         │         │          │          │
  │        │         │─ImageInput        │         │         │          │          │
  │        │         │─Metadata─►│      │         │         │          │          │
  │        │         │          │─select►│        │         │          │          │
  │        │         │          │ ◄─provider       │         │          │          │
  │        │         │          │         │─draft──►│        │          │          │
  │        │         │          │         │         │─plan───►│         │          │
  │        │         │          │         │         │         │─infer──►│         │
  │        │         │          │         │         │         │          │─infer──►│
  │        │         │          │         │         │         │          │◄─result─│
  │        │         │          │         │         │         │◄─response│         │
  │        │         │          │         │         │         │─enrich（标注/提取/reasoning）│
  │        │         │          │         │         │         │─compose──────────│
  │        │◄─result─│          │         │         │         │          │          │
  │◄─response       │          │         │         │         │          │          │
```

> 说明：请求级 Cache 检查 / 写入（阶段 7、12）未实现，未在上图中标注；Provider 层推理缓存由 `BaseLlamaCppProvider` 内部处理。

---

## 5. 生命周期开发对齐清单

开发每个模块时，对照以下清单确认其在生命周期中的位置：

- [ ] 明确该模块属于哪个阶段（1-12）
- [ ] 明确输入类型与来源
- [ ] 明确输出类型与去向
- [ ] 失败时的行为是否符合「异常路径」定义
- [ ] 不跨层调用（见分层规则）
- [ ] 不阻塞返回路径的操作放异步（如规划中的 Cache 写入）

---

## 6. 本文小结

请求生命周期是整个系统的「主轴」，所有模块都挂在这条轴上：

```
接收 → 归一化 → 元数据 → 硬件检测+路由 → 决策 → 策略 → (缓存检查,未实现)
  → Skill执行(取Prompt/Schema → 推理 → 内联校验) → 后置增强(标注/提取/reasoning)
  → 组合 → 返回 → (缓存写入,未实现)
```

核心要点：
1. **路由是 Provider 选择的唯一权威**，Planner 只决策不执行，Policy 只校验不执行
2. **Metadata 用轻量启发式**（pixels + fileSize），绝不调用大模型
3. **每个 Skill 都过内联三层质量保障**：Prompt → 推理 → Schema 校验/修复/重试
4. **后置增强**：标注检测 / 关键内容 / 场景提取器 / 一次 VLM reasoning
5. **缓存未实现**：`cached` 恒 false，仅 Provider 层推理缓存
6. **异常时尽力而为**（PartialResult），不返回空结果

> 下一篇：[03 - Execution Planner](./03-execution-planner.md)
