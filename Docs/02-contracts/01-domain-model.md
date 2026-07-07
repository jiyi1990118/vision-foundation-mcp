# 01 - 领域模型与术语表（Domain Model & Vocabulary）

> 统一术语是工程一致性的根基。本文档定义项目所有核心概念，**全项目必须使用本文档的术语，禁止同义混用**。

---

## 1. 为什么需要统一术语

没有统一术语，项目会越来越乱：
- 今天叫 `Task`，明天叫 `Job`，后天叫 `Action`
- 今天叫 `Provider`，明天叫 `Backend`，后天叫 `Engine`

本文档是**唯一权威**术语来源。代码命名、文档表述、变量命名都必须遵守。

---

## 2. 核心术语表

### 2.1 流程术语（Pipeline Vocabulary）

| 术语 | 含义 | 禁止同义词 |
|------|------|-----------|
| **Skill** | 一种视觉分析能力（如 ocr、ui） | ❌ Job / Action / Task（注：Task 仅用于 SkillTask） |
| **Provider** | 模型抽象（如 smolvlm2、gguf、minicpm） | ❌ Backend / Engine / Model |
| **Runtime** | 推理引擎抽象（如 onnx、mlx） | ❌ Backend / Executor / Runner |
| **Pipeline** | Skill 编排执行器 | ❌ Workflow / Chain |
| **Policy** | 配置化策略规则 | ❌ Rule / Constraint |
| **ExecutionPlan** | 执行计划（Planner 产出） | ❌ Job / Schedule |
| **SkillTask** | Plan 中单个 Skill 的执行单元 | ❌ Job / Action / Step |
| **VisionResult** | 最终返回的结构化结果 | ❌ Output / Response（注：Response 用于 HTTP/MCP 层） |

### 2.2 数据术语（Data Vocabulary）

| 术语 | 含义 | 禁止同义词 |
|------|------|-----------|
| **ImageInput** | 归一化后的图片输入 | ❌ Image / Picture / Img |
| **ImageMetadata** | 图片元信息（尺寸/复杂度等） | ❌ ImageInfo / Meta |
| **NormalizedRequest** | 归一化后的完整请求 | ❌ ParsedRequest |
| **InferenceRequest** | Provider 推理输入 | ❌ InferInput |
| **InferenceResponse** | Provider 推理输出（原始文本） | ❌ InferOutput |
| **VisionResult** | 最终结果 | （同上） |
| **MachineResources** | 机器资源信息 | ❌ SystemInfo / EnvInfo |

### 2.3 组件术语（Component Vocabulary）

| 术语 | 含义 | 禁止同义词 |
|------|------|-----------|
| **ExecutionPlanner** | 执行规划器 | ❌ Scheduler / Router |
| **PolicyEngine** | 策略引擎 | ❌ RuleEngine |
| **SkillPipeline** | Skill 编排器 | ❌ SkillRunner / SkillExecutor |
| **RequestNormalizer** | 请求归一化器 | ❌ InputParser |
| **MetadataExtractor** | 元数据提取器 | ❌ MetaParser |
| **PromptRegistry** | Prompt 注册表 | ❌ PromptStore / PromptManager |
| **SchemaRegistry** | Schema 注册表 | ❌ SchemaStore |
| **ResponseValidator** | 响应校验器 | ❌ Checker / Verifier |
| **ResultComposer** | 结果组合器 | ❌ Merger / Aggregator |
| **ModelManager** | 模型管理器 | ❌ ModelStore |
| **LifecycleManager** | 生命周期管理器 | ❌ ModelLoader / ResourceManager |
| **CacheManager** | 缓存管理器 | ❌ CacheStore |

---

## 3. 领域模型（核心实体关系）

```
┌──────────────┐    包含    ┌──────────────┐
│NormalizedReq │───────────►│  ImageInput  │
└──────┬───────┘            └──────┬───────┘
       │                           │
       │ 包含                      │ 输入
       ▼                           │
┌──────────────┐                   │
│ImageMetadata │                   │
└──────────────┘                   │
                                   │
       ┌───────────────────────────┘
       ▼
┌──────────────┐    产出    ┌──────────────┐
│ExecutionPlan │◄──────────│   Planner    │
└──────┬───────┘           └──────────────┘
       │
       │ 含多个
       ▼
┌──────────────┐
│  SkillTask   │ ×N
└──────┬───────┘
       │ 执行
       ▼
┌──────────────┐    调用    ┌──────────────┐
│SkillPipeline │───────────►│   Provider   │
└──────┬───────┘            └──────┬───────┘
       │                           │ 调用
       │                           ▼
       │                    ┌──────────────┐
       │                    │   Runtime    │
       │                    └──────┬───────┘
       │                           │ 执行
       │                           ▼
       │                    ┌──────────────┐
       │                    │    Model     │
       │                    └──────────────┘
       │
       │ 产出
       ▼
┌──────────────┐    组合    ┌──────────────┐
│VisionResult  │◄──────────│   Composer   │
└──────────────┘            └──────────────┘
```

---

## 4. 核心实体定义

### 4.1 ImageInput
```typescript
interface ImageInput {
  buffer: Buffer;
  mimeType: string;      // "image/png" | "image/jpeg" | "image/webp"
  source: string;        // 原始来源标记
  size: number;          // 字节数
}
```

### 4.2 ImageMetadata
```typescript
interface ImageMetadata {
  width: number;
  height: number;
  aspectRatio: number;
  format: string;
  hasAlpha: boolean;
  colorCount: number;
  fileSize: number;
  complexity: "low" | "medium" | "high";
  estimatedType?: string;
}
```

### 4.3 ExecutionPlan
```typescript
interface ExecutionPlan {
  provider: string;
  runtime: string;
  preprocess: string[];
  skills: SkillTask[];
  postprocess: string[];
  cacheKey: string;
  timeout: number;
  retry: { max: number; strategy: "none" | "reprompt" | "fallback" };
}
```

### 4.4 SkillTask
```typescript
interface SkillTask {
  skill: string;
  prompt: string;
  schema: object;
  priority: number;
  dependsOn?: string[];
  condition?: { field: string; equals: string };
}
```

### 4.5 InferenceRequest / InferenceResponse
```typescript
interface InferenceRequest {
  image: ImageInput;
  prompt: string;
  maxTokens: number;
  temperature: number;
}

interface InferenceResponse {
  text: string;
  raw?: any;
  duration: number;
}
```

### 4.6 VisionResult
```typescript
interface VisionResult {
  category: string;
  confidence: number;
  summary: string;
  skills: string[];
  result: { [skillName: string]: any };
  metadata: {
    provider: string;
    duration: number;
    cached: boolean;
  };
}
```

### 4.7 MachineResources
```typescript
interface MachineResources {
  cpuCores: number;
  memoryAvailable: number;   // MB
  hasGPU: boolean;
  gpuMemory?: number;        // MB
  availableRuntimes: string[];
}
```

---

## 5. 术语使用规则

### 5.1 命名规则
- 变量名、函数名、类名**必须**使用本文档术语
- 文件名使用 kebab-case（如 `execution-planner.ts`）
- 类名使用 PascalCase（如 `ExecutionPlanner`）
- 接口名使用 PascalCase（如 `VisionProvider`）

### 5.2 禁止清单
以下词在项目中**禁止使用**作为概念命名：
```
❌ Job        → 用 SkillTask
❌ Action     → 用 SkillTask
❌ Worker     → 用 Runtime
❌ Executor   → 用 Pipeline / Runtime
❌ Backend    → 用 Provider
❌ Engine     → 用 Runtime（Engine 保留给 Skill Engine / Policy Engine 复合词）
❌ Task       → 用 SkillTask（Task 单独使用易混淆）
❌ Step       → 用 SkillTask
❌ Rule       → 用 Policy
❌ Output     → 用 VisionResult / InferenceResponse
```

### 5.3 例外
- `SkillTask` 中的 `Task` 是复合词的一部分，允许
- `SkillEngine` / `PolicyEngine` 中的 `Engine` 是复合词，允许

---

## 6. 状态枚举定义

全项目统一的状态枚举：

```typescript
// Provider 生命周期状态（完整版见 01-architecture/08-lifecycle-manager.md）
type ProviderState =
  | "unloaded"   // 未加载（零内存）
  | "loading"    // 加载中
  | "loaded"     // 已加载就绪（refCount > 0）
  | "idle"       // 空闲待卸载（refCount == 0）
  | "unloading"  // 卸载中
  | "error";     // 加载失败

// Skill 执行状态
type SkillState = "pending" | "running" | "success" | "failed" | "skipped";

// 推理结果状态
type ResultState = "fresh" | "cached" | "partial" | "error";
```

---

## 7. 错误码命名

错误码使用 `模块_原因` 格式，全大写下划线：

```
NORMALIZE_INVALID_INPUT       归一化：输入无效
MODEL_DOWNLOAD_FAILED         模型下载失败
MODEL_CORRUPTED               模型校验失败
PROVIDER_UNAVAILABLE          Provider 不可用
RUNTIME_NOT_FOUND             Runtime 不可用
POLICY_DENIED                 策略拒绝
SKILL_VALIDATION_FAILED       Skill 校验失败
SKILL_RETRY_EXHAUSTED         Skill 重试耗尽
RESOURCE_INSUFFICIENT         资源不足
TIMEOUT                       超时
```

---

## 8. 本文小结

统一术语是工程一致性的根基：

1. **唯一权威** —— 本文档是术语唯一来源
2. **禁止混用** —— Job/Action/Worker/Backend 等全部禁用
3. **实体明确** —— 7 个核心实体：ImageInput / Metadata / ExecutionPlan / SkillTask / InferenceRequest/Response / VisionResult
4. **状态统一** —— Provider/Skill/Result 三类状态枚举
5. **错误码规范** —— `模块_原因` 格式

> 下一篇：[02 - API 契约](./02-api-contract.md)
