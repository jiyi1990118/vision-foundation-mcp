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
│      tools/vision.analyze.ts  (MCP 唯一入口)                   │
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
│      Validator + Composer  校验 + 组合结果                      │
└──────────────────────────┬───────────────────────────────────┘
                           │ InferenceRequest
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  L4  Provider Layer                                           │
│      VisionProvider        统一模型接口                         │
│      (smolvlm2 / gguf / minicpm / onnx)                        │
└──────────────────────────┬───────────────────────────────────┘
                           │ RuntimeCall
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  L5  Runtime Layer                                            │
│      Runtime Adapter       统一推理引擎接口                     │
│      (llama-cpp / onnx)                                         │
└──────────────────────────┬───────────────────────────────────┘
                           │ 推理执行
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  L6  Infrastructure                                           │
│      Model Manager         下载/缓存/校验/版本                  │
│      Lifecycle Manager     加载/卸载/空闲回收                   │
│      Cache Manager         结果缓存(SHA256)                     │
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
| 关键 | 复杂度估算用轻量算法（Sharp/OpenCV），不调用大模型 |

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
| 模块 | Skill Pipeline、Prompt Registry、Schema Registry、Validator、Composer |
| 输入 | ExecutionPlan + NormalizedRequest |
| 输出 | `VisionResult`（结构化结果） |
| 关键 | 三层质量保障：Prompt Compiler → Validator → Composer |

### L4 - Provider Layer（模型层）
| 项 | 说明 |
|----|------|
| 职责 | 模型抽象，统一接口 |
| 模块 | smolvlm2 / gguf / minicpm 等 Provider |
| 输入 | `InferenceRequest`（图片 + prompt + schema） |
| 输出 | `InferenceResponse`（原始输出） |
| 关键 | Provider 不知道业务语义，只负责调用模型 |

### L5 - Runtime Layer（运行时层）
| 项 | 说明 |
|----|------|
| 职责 | 推理引擎抽象，隔离具体引擎差异 |
| 模块 | llama-cpp / onnx |
| 输入 | RuntimeCall（模型路径 + 输入张量/文本） |
| 输出 | 推理结果 |
| 关键 | Provider 永远不直接调 ONNX，必须经过 Runtime Adapter |

### L6 - Infrastructure（基础设施层）
| 项 | 说明 |
|----|------|
| 职责 | 模型管理、生命周期、缓存 |
| 模块 | Model Manager、Lifecycle Manager、Cache Manager |
| 特点 | 被上层调用，不反向依赖上层 |

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
[6] Policy Engine 按配置校验/调整 → 最终 ExecutionPlan
        │
[7] Skill Pipeline 按 Plan 串联执行各 Skill：
        ├── 取 Prompt（Prompt Registry）
        ├── 取 Schema（Schema Registry）
        ├── 调 Provider.infer()
        │       └── Provider 调 Runtime.infer()
        │              └── Runtime 执行模型推理
        ├── Validator 校验输出（必要时修复/重试）
        └── 暂存 Skill 结果
        │
[8] Result Composer 合并多 Skill 结果 → unified structuredContent
        │
[9] Tool Layer 包装为 MCP 响应返回
        │
[10] Cache Manager 异步缓存结果（key = SHA256(image) + intent）
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
| Skill | 实现 Skill 定义 | `skills/xxx/` | chart、table、moderation |
| Provider | 实现 `VisionProvider` | `providers/xxx/` | gguf、minicpm、smolvlm2 |
| Runtime | 实现 `RuntimeAdapter` | `providers/llama-server/` | llama-cpp、onnx |

**核心不变量**：新增任一插件，不需要修改 Engine 核心代码。

---

## 6. 配置体系

```
config/
├── policy.yaml        策略配置（模型选择规则）
├── providers.yaml     Provider 注册表
├── runtime.yaml       Runtime 检测与选择
├── lifecycle.yaml     生命周期参数（idle timeout 等）
└── prompts.yaml       Prompt 版本与默认值
```

所有配置热加载（或重启生效），不硬编码在代码中。

### policy.yaml 示例
```yaml
policies:
  - name: fast-local
    when:
      image.size < 2MB
      complexity: low
    provider: smolvlm2

  - name: ui-large
    when:
      image.width > 3000
    preprocess:
      - resize
    provider: smolvlm2

  - name: high-quality
    when:
      complexity: high
      quality: high
    provider: minicpm
```

---

## 7. 推荐项目结构

```
vision-foundation-mcp/
├── src/
│   ├── core/                  L1-L2 核心引擎
│   │   ├── request-normalizer.ts
│   │   ├── metadata-extractor.ts
│   │   ├── execution-planner.ts
│   │   ├── policy-engine.ts
│   │   ├── skill-pipeline.ts
│   │   ├── response-validator.ts
│   │   ├── result-composer.ts
│   │   ├── lifecycle-manager.ts
│   │   └── cache-manager.ts
│   ├── skills/                L3 Skill 插件
│   │   ├── classify/
│   │   ├── ocr/
│   │   ├── ui/
│   │   └── ...
│   ├── providers/             L4 Provider 插件
│   │   ├── smolvlm2/         （默认，SmolVLM2-500M-Video）
│   │   ├── gguf/             （SmolVLM-500M-Instruct fast 候选）
│   │   ├── minicpm/          （高质量，MiniCPM-V 2.6）
│   │   ├── smolvlm/          （遗留，ONNX/Transformers.js）
│   │   └── llama-server/     （共享的 LlamaServerProcess）
│   ├── runtime/               L5 Runtime（当前无独立抽象，由 llama-server 统一）
│   │   └── (规划中: mlx)
│   ├── models/                L6 模型管理
│   │   ├── manager.ts
│   │   ├── registry.ts
│   │   └── downloader.ts
│   ├── tools/                 L0 MCP Tool
│   │   └── vision.analyze.ts
│   ├── types/                 类型定义（契约）
│   └── utils/                 工具函数
├── prompts/                   Prompt Registry
├── schemas/                   Schema Registry
├── config/                    配置文件
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
