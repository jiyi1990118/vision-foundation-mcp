# 01 - 系统架构（System Architecture）

> 本文档定义整个系统的分层结构、模块职责与依赖关系。是所有架构文档的总纲。

---

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                        MCP Client                             │
│           Claude / Cursor / ChatGPT / Codex                   │
└──────────────────────────┬───────────────────────────────────┘
                           │ vision.analyze(image, intent)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  L0  Tool Layer                                               │
│      tools/vision-analyze.ts  (MCP 唯一入口)                   │
└──────────────────────────┬───────────────────────────────────┘
                           │ ImageInput + Intent
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  L1  Request Layer                                            │
│      Request Normalizer    统一输入格式                         │
│      Metadata Extractor    尺寸/格式/复杂度估算                  │
└──────────────────────────┬───────────────────────────────────┘
                           │ NormalizedRequest
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  L2  Decision Layer                                           │
│      Execution Planner     制定执行策略（大脑）                  │
│      Policy Engine         配置化策略校验/选择                   │
└──────────────────────────┬───────────────────────────────────┘
                           │ ExecutionPlan
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  L3  Skill Layer                                              │
│      Skill Pipeline        按 Plan 串联执行 Skill              │
│      Prompt Registry       取优化后的 Prompt                    │
│      Schema Registry       取输出 Schema                        │
│      校验/组合内联于 SkillPipeline（无独立模块）              │
└──────────────────────────┬───────────────────────────────────┘
                           │ InferenceRequest
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  L4  Provider Layer                                           │
│      VisionProvider        统一模型接口                         │
│      (gguf-smolvlm2 / minicpm-v / smolvlm / ppu-paddle-ocr 等)│
└──────────────────────────┬───────────────────────────────────┘
                           │ RuntimeCall
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  L5  Runtime Layer                                            │
│      LlamaServerProcess    GGUF 子进程（无 RuntimeAdapter）   │
│      (llama.cpp via BaseLlamaCppProvider)                     │
└──────────────────────────┬───────────────────────────────────┘
                           │ 推理执行
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  L6  Infrastructure                                           │
│      Model Manager         下载/缓存/校验/版本                  │
│      生命周期/缓存/图像优化  内嵌于 BaseLlamaCppProvider      │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. 分层职责

### L0 - Tool Layer（工具层）
| 项 | 说明 |
|----|------|
| 职责 | MCP 协议入口，接收请求，返回结果 |
| 模块 | `vision.analyze`（唯一 Tool） |
| 输入 | MCP 请求（image + intent + options） |
| 输出 | MCP 响应（content + structuredContent） |
| 禁止 | 业务逻辑、模型调用、策略决策 |

> 为什么只有一个 Tool？详见 [ADR-001](../04-decisions/ADR-001-single-tool.md)

### L1 - Request Layer（请求层）
| 项 | 说明 |
|----|------|
| 职责 | 输入归一化 + 元数据提取 |
| 模块 | Request Normalizer、Metadata Extractor |
| 输入 | 多种格式（file/base64/buffer/http/data-uri） |
| 输出 | `NormalizedRequest`（统一 ImageInput + Metadata） |
| 关键 | 复杂度估算用 pixels + fileSize 启发式（sharp），不调用大模型 |

### L2 - Decision Layer（决策层）
| 项 | 说明 |
|----|------|
| 职责 | 制定执行策略（不执行） |
| 模块 | Execution Planner、Policy Engine |
| 输入 | NormalizedRequest（意图 + 图片元信息 + 机器资源） |
| 输出 | `ExecutionPlan`（provider + preprocess + skills + postprocess） |
| 关键 | Planner 是整个系统的大脑，但只产出计划，不执行 |

### L3 - Skill Layer（技能层）
| 项 | 说明 |
|----|------|
| 职责 | 按 Plan 执行 Skill，保障输出质量 |
| 模块 | Skill Pipeline（内联校验/修复/重试 + composeResult）、Prompt Registry、Schema Registry |
| 输入 | ExecutionPlan + NormalizedRequest |
| 输出 | `VisionResult`（结构化结果） |
| 关键 | 三层质量保障：Prompt Compiler → 内联校验/修复/重试 → composeResult |

### L4 - Provider Layer（模型层）
| 项 | 说明 |
|----|------|
| 职责 | 模型抽象，统一接口 |
| 模块 | gguf-smolvlm2 / gguf-smolvlm / minicpm-v / smolvlm / ppu-paddle-ocr |
| 输入 | `InferenceRequest`（图片 + prompt + schema） |
| 输出 | `InferenceResponse`（原始输出） |
| 关键 | Provider 不知道业务语义，只负责调用模型 |

### L5 - Runtime Layer（运行时层）
| 项 | 说明 |
|----|------|
| 职责 | 推理引擎执行（GGUF via llama.cpp 子进程；ONNX 内嵌于 SmolVLMProvider） |
| 模块 | `LlamaServerProcess`（共享）、`BaseLlamaCppProvider`（GGUF 基类） |
| 输入 | 模型路径 + 图片/Prompt + 推理参数 |
| 输出 | 推理结果（文本） |
| 关键 | **无独立 `RuntimeAdapter` 抽象**；GGUF Provider 经 `BaseLlamaCppProvider` 直接委托 `LlamaServerProcess`，ONNX Provider 内部直接调用 onnxruntime |

### L6 - Infrastructure（基础设施层）
| 项 | 说明 |
|----|------|
| 职责 | 模型下载/校验 + 进程生命周期（加载/卸载/空闲回收）+ 推理缓存 |
| 模块 | Model Manager（`core/model-manager.ts`）；生命周期/缓存/图像优化内嵌于 `BaseLlamaCppProvider`（引用计数 + 10min idle 卸载 + 低内存告警 + 推理缓存 LRU/TTL） |
| 特点 | 被上层调用，不反向依赖上层；无独立 Cache Manager 模块 |

---

## 3. 依赖关系图

### 3.1 允许的依赖（单向向下）
```
L0 Tool ──► L1 Request ──► L2 Decision ──► L3 Skill ──► L4 Provider ──► L5 Runtime
                                                                │
                                                                ▼
                                                            L6 Infrastructure
（L6 被 L4/L5 调用，但 L6 不反向依赖任何上层）
```

### 3.2 禁止的依赖（跨层/反向）
```
❌ Skill ──► Runtime          （跨层，必须经 Provider）
❌ Tool  ──► Provider         （跨层，必须经 Decision→Skill）
❌ Runtime ──► Skill          （反向依赖）
❌ Provider ──► Planner       （反向依赖）
```

> 完整分层规则见 [02-contracts/03-layer-rules.md](../02-contracts/03-layer-rules.md)

---

## 4. 数据流（一次调用的完整路径）

```
[1] Client 调用 vision.analyze(image, intent)
        │
[2] Tool Layer 接收，转交 Request Layer
        │
[3] Request Normalizer 归一化输入 → ImageInput
        │
[4] Metadata Extractor 提取尺寸/格式，估算复杂度
        │
[5] Execution Planner 综合意图+元信息+资源 → 草稿 Plan
        │
[6] Policy Engine 按硬编码规则校验/调整 → 最终 ExecutionPlan（仅告警/拒绝，不覆盖 Provider）
        │
[7] Skill Pipeline 按 Plan 串联执行各 Skill：
        ├── 取 Prompt（Prompt Registry）
        ├── 取 Schema（Schema Registry）
        ├── 调 Provider.infer()
        │       └── Provider 调 Runtime.infer()
        │              └── Runtime 执行模型推理
        ├── 内联校验输出（修复/重试，无独立 Validator 模块）
        └── 暂存 Skill 结果
        │
[8] composeResult（skill-pipeline.ts）合并多 Skill 结果 + 场景提取器/Universal Parser 增强
        │
[9] Tool Layer 包装为 MCP 响应返回
        │
[10] （未实现）请求级结果缓存；仅 Provider 层有推理缓存（BaseLlamaCppProvider）
```

> 详细版见 [02-request-lifecycle.md](./02-request-lifecycle.md)

---

## 5. 扩展点（三轴扩展）

```
                    新增视觉能力
                         │
                         ▼
                   skills/xxx/
                   （Skill 插件）

   新增模型                    新增推理引擎
       │                          │
       ▼                          ▼
  providers/xxx/             runtime/xxx/
  （Provider 插件）            （Runtime 插件）
```

| 扩展轴 | 接口 | 目录 | 示例 |
|--------|------|------|------|
| Skill | skill.json + prompt.md + schema.json | `skills/xxx/` | table、moderation、layout |
| Provider | 实现 `VisionProvider` | `providers/xxx/` | gguf-smolvlm2、minicpm-v、smolvlm |
| Runtime | 共享 `BaseLlamaCppProvider` / 内嵌 onnxruntime | `providers/llama-server/` | llama.cpp、onnx |

**核心不变量**：新增任一插件，不需要修改 Engine 核心代码。

---

## 6. 配置体系

> 现状：YAML 配置文件（`policy.yaml` / `providers.yaml` / `runtime.yaml` / `lifecycle.yaml` / `prompts.yaml`）为**规划目标，尚未实现**。当前为 JSON 配置 + 环境变量覆盖 + 硬编码策略规则。

```
config/
└── default.json.example   运行参数示例（maxConcurrent / requestTimeoutMs / maxImageSizeBytes / gguf.port / endpoint）
```

- `src/core/config.ts`：JSON-based 配置，读取 `config/default.json`（可选）+ 环境变量（`VISION_*`）覆盖。默认值：maxConcurrent=4、requestTimeoutMs=30000、maxImageSizeBytes=10MB、gguf.port=18082、endpoint=`https://hf-mirror.com`。
- `src/core/policy-engine.ts`：策略规则硬编码为 `DEFAULT_RULES`（**非 policy.yaml**）：
  - `large-image-resize`：width>3000 -> 追加 resize 预处理
  - `memory-guard`：可用内存<1024MB -> **仅告警，不覆盖 Provider**
  - `reject-huge`：size>50MB -> 拒绝
- Provider 选择由路由（`provider-router.ts` 的 `selectProvider`）决定，非配置文件。

### 目标形态（policy.yaml，尚未实现）
```yaml
policies:
  - name: high-quality
    when:
      complexity: high
      quality: high
    provider: minicpm-v
```

---

## 7. 推荐项目结构

```
vision-foundation-mcp/
├── src/
│   ├── index.ts               MCP 入口，Provider 注册
│   ├── core/                  L1-L2 核心引擎
│   │   ├── config.ts                 JSON 配置（非 YAML）
│   │   ├── request-normalizer.ts
│   │   ├── metadata-extractor.ts      宽高/格式/hasAlpha/fileSize + 复杂度启发式
│   │   ├── execution-planner.ts       INTENT_MAPPINGS、Skill 选择
│   │   ├── policy-engine.ts           硬编码 DEFAULT_RULES（非 policy.yaml）
│   │   ├── skill-pipeline.ts         SkillPipeline + composeResult（内联校验/修复/重试）
│   │   ├── prompt-compiler.ts
│   │   ├── provider-router.ts         M5 路由：selectProvider / chooseProvider
│   │   ├── runtime-detector.ts
│   │   ├── scenario-resolver.ts      detectScenario：requirement/chart/diagram/invoice/code/form/general
│   │   ├── scene-taxonomy.ts         14 个 ParseScene、refineScene、nextActionTemplates
│   │   ├── universal-parser.ts       buildUniversalParse / runReasoning（result.parse）
│   │   ├── key-content-extractor.ts  需求场景关键内容提取
│   │   ├── annotation-detector.ts    多色（5 色）标注检测
│   │   ├── model-manager.ts          GGUF 下载 / SHA-256 / Range 断点续传
│   │   └── extractors/               场景提取器
│   │       ├── scenario-dispatcher.ts
│   │       ├── chart-extractor.ts
│   │       ├── diagram-extractor.ts
│   │       ├── document-extractor.ts
│   │       ├── code-extractor.ts
│   │       └── form-extractor.ts
│   ├── skills/                L3 Skill 插件（8 个：classify/summary/ocr/table/document/poster/moderation/layout）
│   │   └── <name>/{skill.json, prompt.md, schema.json}
│   ├── providers/             L4 Provider 插件
│   │   ├── types.ts                   VisionProvider 接口（含 runtime 字段）
│   │   ├── smolvlm2/         （默认，SmolVLM2-500M-Video，name=gguf-smolvlm2）
│   │   ├── gguf/             （SmolVLM-500M-Instruct fast 候选，name=gguf-smolvlm）
│   │   ├── minicpm/          （高质量，MiniCPM-V，name=minicpm-v）
│   │   ├── smolvlm/          （遗留，ONNX，name=smolvlm）
│   │   ├── ppu-paddle-ocr/   （OCR-only，name=ppu-paddle-ocr）
│   │   └── llama-server/     （共享 GGUF 基础设施）
│   │       ├── base-provider.ts       BaseLlamaCppProvider（生命周期/缓存/图像优化）
│   │       ├── process.ts             LlamaServerProcess
│   │       ├── process-registry.ts
│   │       ├── downloader.ts          自动安装 llama-server（GitHub releases + 镜像降级）
│   │       ├── platform-detector.ts
│   │       └── resolver.ts            检测顺序：LLAMA_SERVER_PATH → <pkg>/bin → ~/.vision-mcp/bin → 系统 → PATH
│   ├── tools/                 L0 MCP Tool
│   │   └── vision-analyze.ts         （单一 MCP Tool，非 vision.analyze.ts）
│   └── utils/
│       ├── logger.ts                  写 stderr（MCP stdio，不写 stdout）
│       └── concurrency.ts            Semaphore / withAbortableTimeout
├── config/                    config/default.json(.example)（JSON，非 YAML）
├── tests/
└── Docs/
```

---

## 8. 关键设计决策索引

| 决策 | 文档 |
|------|------|
| 为什么只有一个 Tool | [ADR-001](../04-decisions/ADR-001-single-tool.md) |
| 为什么 Skill 不是 Tool | [ADR-002](../04-decisions/ADR-002-skill-not-tool.md) |
| 为什么需要 Policy Engine | [ADR-003](../04-decisions/ADR-003-policy-engine.md) |
| 为什么 Provider 不直接调 Runtime | [ADR-004](../04-decisions/ADR-004-provider-runtime-split.md) |

---

## 9. 本文小结

系统架构核心是 **7 层单向依赖 + 3 轴插件扩展**：

- **7 层**：Tool → Request → Decision → Skill → Provider → Runtime → Infrastructure
- **3 轴**：Skill（能力）/ Provider（模型）/ Runtime（引擎）皆可插件化扩展
- **不变量**：新增能力 = 新增插件目录，不改核心引擎
- **大脑**：Execution Planner + Policy Engine 负责决策，但不执行

> 下一份文档：[02 - 请求生命周期](./02-request-lifecycle.md) —— 详细展开一次请求的每一步。
