# 02 - 请求生命周期（Request Lifecycle）

> 本文档详述一张图片从 `vision.analyze()` 进入到 `structuredContent` 返回的完整过程。是开发时对齐各模块行为的标准参照。

---

## 1. 生命周期总览

```
 ┌─────────┐   ┌──────────┐   ┌─────────┐   ┌──────────┐
 │ Request │──►│Normalize │──►│Metadata │──►│ Planner  │
 │  接收   │   │  归一化   │   │  提取   │   │  决策    │
 └─────────┘   └──────────┘   └─────────┘   └────┬─────┘
                                                  │
 ┌──────────┐   ┌──────────┐   ┌─────────┐       │
 │  Return  │◄──│ Compose  │◄──│Validate │◄──┐   │
 │  返回    │   │  组合    │   │  校验   │   │   │
 └──────────┘   └──────────┘   └─────────┘   │   │
                                              │   │
                    ┌──────────┐              │   │
                    │  Policy  │◄─────────────┘   │
                    │  策略    │                  │
                    └────┬─────┘                  │
                         │                        │
                         ▼                        │
                ┌──────────────┐                  │
                │ Skill Pipeline│─────────────────┘
                │  技能执行     │
                └──────┬───────┘
                       │
                       ▼
                ┌──────────────┐
                │  Provider    │
                │  模型调用     │
                └──────┬───────┘
                       │
                       ▼
                ┌──────────────┐
                │   Runtime    │
                │  推理执行     │
                └──────────────┘
```

---

## 2. 阶段详解

### 阶段 1：Request 接收

**位置**：L0 Tool Layer

**输入**（MCP 请求）：
```typescript
{
  image: string | Buffer | Uint8Array,  // 图片输入
  intent?: string,                       // 用户意图（自然语言）
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

**位置**：L1 Request Layer — Request Normalizer

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
- ✅ 格式转换、解码
- ✅ 大小校验（防 OOM，见安全设计）
- ❌ 不做内容理解（那是后面的事）

---

### 阶段 3：Metadata 提取

**位置**：L1 Request Layer — Metadata Extractor

**职责**：用轻量算法（不调大模型）提取图片元信息与复杂度估算

**提取内容**：
```typescript
interface ImageMetadata {
  width: number;
  height: number;
  aspectRatio: number;
  format: string;            // png/jpeg/webp
  hasAlpha: boolean;
  colorCount: number;        // 颜色丰富度
  fileSize: number;
  complexity: "low" | "medium" | "high";  // 综合估算
  estimatedType?: string;    // UI/document/photo/chart（可选估算）
}
```

**复杂度估算方法**（无需大模型）：
| 指标 | 方法 | 用途 |
|------|------|------|
| 边缘密度 | OpenCV/Sharp 边缘检测 | 判断细节丰富度 |
| 颜色直方图 | 色彩分布统计 | 区分照片/图表/UI |
| 文本区域估计 | 简单形态学 | 判断是否文本密集 |
| 尺寸/比例 | 直接读取 | 判断是否 UI 截图 |

**关键原则**：这一步**绝不调用大模型**，只用毫秒级轻量算法。

---

### 阶段 4：Planner 决策

**位置**：L2 Decision Layer — Execution Planner

**输入**：
```
NormalizedRequest = ImageInput + ImageMetadata + Intent + Options + MachineResources
```

**职责**：综合以下因素，生成草稿 `ExecutionPlan`
- **用户意图**：意图 → Skill 映射（如「有没有兔子」→ object detection）
- **图片信息**：尺寸/复杂度/估计类型
- **机器资源**：CPU/内存/GPU/可用 Runtime

**输出**（草稿 Plan）：
```typescript
interface ExecutionPlan {
  provider: string;              // smolvlm2 / gguf / minicpm / onnx
  runtime: string;               // llama-cpp / onnx
  preprocess: string[];          // ["resize", "normalize"]
  skills: SkillTask[];           // 要执行的 Skill 列表
  postprocess: string[];         // ["merge"]
  cacheKey: string;              // 缓存键
  timeout: number;               // 超时(ms)
  retry: { max: number; strategy: string };
}

interface SkillTask {
  skill: string;                 // classify / ocr / ui ...
  prompt: string;                // 从 Prompt Registry 取
  schema: object;                // 从 Schema Registry 取
  priority: number;
  dependsOn?: string[];          // 依赖的前置 Skill
}
```

> Planner 详见 [03-execution-planner.md](./03-execution-planner.md)

**关键原则**：Planner **只产出计划，不执行**。

---

### 阶段 5：Policy 策略校验

**位置**：L2 Decision Layer — Policy Engine

**职责**：按 `config/policy.yaml` 校验/调整草稿 Plan

**策略匹配示例**：
```yaml
- name: high-quality
  when:
    complexity: high
    quality: high
  override:
    provider: minicpm

- name: safety-moderation
  when:
    skill: moderation
  override:
    provider: smolvlm2    # 审核固定用本地，不外发
```

**输出**：最终 `ExecutionPlan`（可能被策略覆盖调整）

> Policy 详见 [04-policy-engine.md](./04-policy-engine.md)

---

### 阶段 6：Cache 命中检查

**位置**：L6 Infrastructure — Cache Manager

**职责**：以 `SHA256(image) + intent + skills` 为 key 查缓存

```
命中 ──► 直接返回缓存的 structuredContent（跳过阶段 7-9）
未命中 ──► 继续执行
```

---

### 阶段 7：Skill Pipeline 执行

**位置**：L3 Skill Layer — Skill Pipeline

**职责**：按 Plan.skills 依次（或并行）执行每个 Skill

**单个 Skill 执行流程**：
```
SkillTask
   │
   ├──[7a] Prompt Compiler
   │        从 Prompt Registry 取 prompt template
   │        填充变量（intent、metadata）
   │        生成最终 prompt
   │
   ├──[7b] Schema 取出
   │        从 Schema Registry 取该 Skill 的 schema.json
   │
   ├──[7c] 调用 Provider.infer()
   │        │
   │        └── Provider 调 Runtime.infer()
   │               │
   │               └── Runtime 执行模型推理
   │                      （模型由 Lifecycle Manager 确保已加载）
   │
   └── 暂存 InferenceResponse
```

**多 Skill 编排**：
- 独立 Skill：可并行
- 有依赖的 Skill：串行（如先 classify 再 ui）
- 混合 OCR 分析：`ocr` 和 `classify` 可并行，`summary` 同时等待 `ocr` + `classify`
- OCR Provider override：混合请求中若注册了 `ppu-paddle-ocr`，`ocr` skill 可由专用 OCR Provider 执行，其他 skill 仍由 VLM Provider 执行
- 由 Pipeline 按依赖图调度

---

### 阶段 8：Validate 校验

**位置**：L3 Skill Layer — Response Validator

**职责**：校验每个 Skill 的输出，必要时修复或重试

**校验流程**：
```
InferenceResponse（模型原始输出）
        │
        ▼
   JSON Parse         ← 小模型可能输出非合法 JSON
        │ 失败 ──► 尝试修复（提取 JSON 片段 / 去 Markdown）
        ▼
   Schema Validate   ← 对照 schema.json
        │ 失败 ──► 轻量重试（最多 retry.max 次，调整 prompt）
        ▼
   Standard Output
```

**关键原则**：小模型输出不可靠是常态，Validator 是必需品。

---

### 阶段 9：Compose 组合

**位置**：L3 Skill Layer — Result Composer

**职责**：将多个 Skill 的结果合并为统一的 `structuredContent`

OCR 成功时，Composer 会额外构造：

- 顶层 `ocrText`：完整 OCR 文本，方便调用方或 LLM 直接消费。
- `result.ui`：面向后台/UI 截图的结构化摘要，如导航、动作、字段、表头和值。
- `result.layout`：基于 OCR 坐标的左侧栏、主内容、底部按钮等布局结构。

当请求包含 `options.target` 或 intent 命中红框/标注/关键区域语义时，Stage 8/9 之间还会执行：

```
OCR 结果 → detectAnnotations(red boxes) → extractKeyContent(target region)
        → result.annotations + result.targetExtraction
```

`targetExtraction` 会结合全图 OCR 与局部裁剪 OCR，输出目标区域内的 `textLines`、表格列/行、warnings 等，避免邻近框外文本混入。

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
  };
  ocrText?: string;
  metadata: {
    provider: string;
    runtime: string;
    duration: number;        // 耗时
    cached: boolean;
  };
}
```

---

### 阶段 10：Return 返回

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
    "skills": ["classify", "ocr", "chart"],
    "result": { ... },
    "ocrText": "菜单中心\nPOS分类管理\n保存",
    "metadata": {
      "provider": "smolvlm2",
      "runtime": "llama-cpp",
      "duration": 1200,
      "cached": false
    }
  }
}
```

---

### 阶段 11：Cache 写入（异步）

**位置**：L6 Infrastructure — Cache Manager

**职责**：将结果写入缓存（key = SHA256(image) + intent + skills）

```
写入策略：
- TTL 过期自动失效
- 容量上限 LRU 淘汰
- 写入不阻塞返回
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
  → Model Manager 自动下载 + 校验
  → Lifecycle Manager 加载
  → 期间请求等待或返回「正在准备」
```

### 3.3 推理超时
```
Runtime.infer() 超过 plan.timeout
  → 中断推理
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
  → Lifecycle Manager 卸载空闲模型
  → 拒绝新的大图请求
  → 返回 ResourceError
```

---

## 4. 关键时序图

```
Client     Tool    Normalizer   Planner    Policy    Pipeline    Provider   Runtime    Cache
  │          │         │           │          │         │           │          │         │
  │─analyze─►│         │           │          │         │           │          │         │
  │          │─req────►│           │          │         │           │          │         │
  │          │         │─ImageInput│          │         │           │          │         │
  │          │         │─Metadata─►│          │         │           │          │         │
  │          │         │           │─draft───►│         │           │          │         │
  │          │         │           │          │─plan───►│           │          │         │
  │          │         │           │          │         │─check cache────────────────────►│
  │          │         │           │          │         │◄─miss───────────────────────────│
  │          │         │           │          │         │           │          │         │
  │          │         │           │          │         │─infer────►│          │         │
  │          │         │           │          │         │           │─infer───►│         │
  │          │         │           │          │         │           │◄─result──│         │
  │          │         │           │          │         │◄─response─│          │         │
  │          │         │           │          │         │─validate──│          │         │
  │          │         │           │          │         │─compose───│          │         │
  │          │         │           │          │         │─write cache────────────────────►│
  │          │◄─result─│           │          │         │           │          │         │
  │◄─response│         │           │          │         │           │          │         │
```

---

## 5. 生命周期开发对齐清单

开发每个模块时，对照以下清单确认其在生命周期中的位置：

- [ ] 明确该模块属于哪个阶段（1-11）
- [ ] 明确输入类型与来源
- [ ] 明确输出类型与去向
- [ ] 失败时的行为是否符合「异常路径」定义
- [ ] 不跨层调用（见分层规则）
- [ ] 不阻塞返回路径的操作放异步（如 Cache 写入）

---

## 6. 本文小结

请求生命周期是整个系统的「主轴」，所有模块都挂在这条轴上：

```
接收 → 归一化 → 元数据 → 决策 → 策略 → 缓存检查
  → Skill执行(取Prompt/Schema → 推理 → 校验) → 组合 → 返回 → 缓存写入
```

核心要点：
1. **Planner 只决策不执行**，Policy 只校验不执行
2. **Metadata 用轻量算法**，绝不调用大模型
3. **每个 Skill 都过三层质量保障**：Prompt → 推理 → Schema 校验
4. **缓存读写不阻塞主路径**
5. **异常时尽力而为**（PartialResult），不返回空结果

> 下一篇：[03 - Execution Planner](./03-execution-planner.md)
