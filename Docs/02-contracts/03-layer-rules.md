# 03 - 分层规则（Layer Rules）

> 本文档定义各层的调用边界。违反分层规则 = 架构腐化的开始。代码评审必须以此为准绳。

---

## 1. 分层总览

```
L0  Tool          MCP 入口
L1  Request       请求归一化 + 元数据
L2  Decision      Planner + Policy（决策层）
L3  Skill         Skill Pipeline + 质量保障
L4  Provider      模型抽象
L5  Runtime       推理引擎抽象
L6  Infrastructure 模型管理/生命周期/缓存
```

---

## 2. 允许的依赖（白名单）

**核心原则：单向向下依赖，同层可调用。**

```
L0 Tool
  └─► L1 Request
        └─► L2 Decision
              └─► L3 Skill
                    └─► L4 Provider
                          └─► L5 Runtime
                                └─► L6 Infrastructure

  L3 Skill ──► L6 Infrastructure（可直接调用 Cache/Lifecycle，跳过 L4/L5）
  L4 Provider ──► L6 Infrastructure（调用 ModelManager 取路径）
  L0 Tool ──► L6 Infrastructure（调用 Cache 检查）
```

### 依赖矩阵

| 调用方 ↓ \ 被调方 → | L0 | L1 | L2 | L3 | L4 | L5 | L6 |
|---------------------|----|----|----|----|----|----|----|
| L0 Tool | - | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| L1 Request | ❌ | - | ✅ | ❌ | ❌ | ❌ | ❌ |
| L2 Decision | ❌ | ❌ | - | ❌ | ❌ | ❌ | ❌ |
| L3 Skill | ❌ | ❌ | ✅ | - | ✅ | ❌ | ✅ |
| L4 Provider | ❌ | ❌ | ❌ | ❌ | - | ✅ | ✅ |
| L5 Runtime | ❌ | ❌ | ❌ | ❌ | ❌ | - | ✅ |
| L6 Infra | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | - |

> ✅ 允许 ❌ 禁止

> **例外**：L0 Tool 在 Pipeline 执行后、组合结果前，直接调用 L3 后处理抽取模块（`detectAnnotations` / `extractKeyContent` / `extractForScenario` / `runReasoning`），用于标注检测、关键内容提取、场景抽取与通用解析。这是有意为之的 L0→L3 耦合（post-pipeline enrichment 阶段），见 §7。

---

## 3. 禁止的依赖（黑名单）

以下调用**绝对禁止**，代码评审必须拦截：

### 3.1 跨层调用
```
❌ L3 Skill ──► L5 Runtime      （必须经 L4 Provider）
❌ L0 Tool ──► L4 Provider      （必须经 L2->L3->L4）
❌ L0 Tool ──► L3 Skill         （必须经 L2 Decision）
❌ L1 Request ──► L3 Skill      （必须经 L2）
```

> 例外：Pipeline 执行后、组合结果前的后处理抽取阶段，L0 直接调用 L3 抽取模块（`detectAnnotations` / `extractKeyContent` / `extractForScenario` / `runReasoning`）。这不替代 Skill Pipeline 本身（Pipeline 仍经 L2 Plan 编排），仅做 post-pipeline enrichment，见 §7。

### 3.2 反向依赖
```
❌ L5 Runtime ──► L3 Skill      （下层不知道上层）
❌ L5 Runtime ──► L4 Provider
❌ L4 Provider ──► L3 Skill
❌ L4 Provider ──► L2 Decision
❌ L6 Infra ──► 任何上层
```

### 3.3 同层越权
```
❌ L2 Planner ──► L2 Policy     （Planner 产出草稿，Policy 评估；Planner 不调 Policy）
❌ L3 Validator ──► L3 Composer （各自独立，由 Pipeline 编排）
```

> 注：`Validator`/`Composer` 在当前代码库并非独立模块。校验内联于 `SkillPipeline.parseAndValidate`（`src/core/skill-pipeline.ts`）；组合是 `composeResult` 函数（同文件），非独立类。此处的「同层越权」规则仍作为概念约束保留。

---

## 4. 各层职责边界

### L0 - Tool Layer
```
✅ 做：接收 MCP 请求、转交下层、包装返回、调用 Cache 检查
✅ 做（M5）：在 Planner 之前执行 Provider 路由（selectProvider），决定实际执行 Provider；Planner 信任 PlannerInput.activeProvider/activeRuntime
✅ 做（enrichment）：Pipeline 执行后直接调用 L3 抽取模块（detectAnnotations / extractKeyContent / extractForScenario / runReasoning）
❌ 不做：业务逻辑、模型调用、策略决策、意图分析
```

> **M5 路由说明**：Provider 选择发生在 L0（`vision-analyze.ts` 的 `selectProvider`），而非 L2。Router 是 Provider 选择的唯一权威；PolicyEngine 的 `memory-guard` 仅 warn，不再 override Provider。

### L1 - Request Layer
```
✅ 做：输入归一化、格式转换、元数据提取、复杂度估算
❌ 不做：模型调用、策略决策、缓存读写
```

### L2 - Decision Layer
```
✅ 做：意图分析、Skill 选择、生成 Plan
❌ 不做：执行推理、调用 Provider/Runtime、缓存读写、Provider 选择（已上移至 L0）
```

**注意**：Planner 和 Policy 都在 L2，但 Planner 产出草稿，Policy 评估。二者是「顺序协作」而非「互相调用」——由上层（Pipeline 或 Tool）串联。

**M5 路由**：Provider 选择已在 L0 完成（`selectProvider`），Planner 不再「建议 Provider」。`ExecutionPlan.provider/runtime` 取自 `PlannerInput.activeProvider/activeRuntime`（由 L0 注入），保持 Plan 与实际执行 Runtime 一致。Policy 的 `memory-guard` 仅 warn，不 override Provider。

### L3 - Skill Layer
```
✅ 做：Prompt 编译、Schema 取出、调 Provider、校验、组合
❌ 不做：直接调 Runtime、做策略决策
```

> 注：「校验」内联于 `SkillPipeline.parseAndValidate`，无独立 `ResponseValidator` 模块；「组合」是 `composeResult` 函数，均位于 `src/core/skill-pipeline.ts`。`result.ui` / `result.layout` / `result.parse` 等算法式结果也在组合阶段产出。

### L4 - Provider Layer
```
✅ 做：模型加载/卸载、输入预处理、调 Runtime、输出解析
❌ 不做：业务语义、Skill 逻辑、直接读模型文件
```

### L5 - Runtime Layer
```
✅ 做：加载模型文件、执行推理计算、资源管理
❌ 不做：业务语义、Prompt、Skill
```

### L6 - Infrastructure Layer
```
✅ 做：模型下载/缓存/校验、生命周期管理、结果缓存
❌ 不做：任何业务逻辑、不知道上层存在
```

---

## 5. 数据流经各层的类型

每层有自己的输入/输出类型，**不允许跨层传递原始类型**：

```
L0:  MCPRequest ──► MCPResponse
L1:  RawInput ──► NormalizedRequest (ImageInput + Metadata)
L2:  NormalizedRequest ──► ExecutionPlan
L3:  ExecutionPlan ──► VisionResult
L4:  InferenceRequest ──► InferenceResponse
L5:  RuntimeInput ──► RuntimeOutput
L6:  (被调用，无主数据流)
```

**规则**：上层传给下层的必须是该层期望的输入类型，不允许把 L0 的原始请求直接透传到 L3。

---

## 6. 依赖注入规则

为避免分层穿透，使用依赖注入而非直接 import：

```typescript
// ❌ 错误：Skill 直接 import Runtime
import { ONNXRuntime } from "../../runtime/onnx";  // 跨层！

// ✅ 正确：Skill 通过 Provider 间接获得 Runtime
class SkillPipeline {
  constructor(private provider: VisionProvider) {}  // 注入
  async execute() {
    const response = await this.provider.infer(req);  // 通过 Provider
  }
}
```

```typescript
// ❌ 错误：Provider 直接 import Planner
import { ExecutionPlanner } from "../../core/planner";

// ✅ 正确：Provider 不知道 Planner 存在
// Planner 的产出（ExecutionPlan）由上层传入 Skill 层
```

---

## 7. 例外与豁免

以下情况允许跨层，但必须有明确理由：

| 例外 | 理由 | 限制 |
|------|------|------|
| L0 -> L6 Cache | Tool 层直接查缓存，避免无谓推理 | 仅读，不写 |
| L0 -> L3 抽取模块 | post-pipeline enrichment：`detectAnnotations` / `extractKeyContent` / `extractForScenario` / `runReasoning` | 仅在 Pipeline 执行后、组合前调用；不替代 Pipeline 本身 |
| L3 -> L6 Cache | Skill 层写缓存（推理后） | 仅写 |
| L4 -> L6 ModelManager | Provider 取模型路径 | 仅读路径 |

**任何其他跨层调用都需要 ADR 记录理由。**

---

## 8. 代码评审检查清单

评审任何 PR 时，检查：

- [ ] 是否有跨层 import？（检查 import 路径）
- [ ] Skill 是否直接调了 Runtime？
- [ ] Tool 是否直接调了 Provider/Skill？
- [ ] Runtime 是否 import 了上层模块？
- [ ] Planner 是否直接调了 Provider？
- [ ] 数据类型是否按层传递（非跨层透传原始请求）？
- [ ] 依赖是否通过注入而非硬编码 import？

---

## 9. 分层违规示例

### 违规 1：Skill 直接调 ONNX
```typescript
// skills/ocr/postprocess.ts
import * as ort from "onnxruntime-node";  // ❌ 跨层 import

export async function runOCR(image) {
  const session = await ort.InferenceSession.create("model.onnx");  // ❌
  // ...
}
```
**正确**：Skill 调 `provider.infer()`，Provider 调 `runtime.infer()`。

### 违规 2：Tool 跳过决策层
```typescript
// tools/vision.analyze.ts
const result = await smolvlmProvider.infer(req);  // ❌ 跳过 L2/L3
```
**正确**：Tool → Request → Planner → Policy → Pipeline → Provider。

### 违规 3：Runtime 知道 Skill
```typescript
// runtime/onnx/index.ts
import { ocrSchema } from "../../skills/ocr/schema";  // ❌ 反向依赖
```
**正确**：Runtime 不知道任何 Skill 的存在。

---

## 10. 本文小结

分层规则核心要点：

1. **单向向下** —— 上层调下层，下层不知道上层
2. **白名单制** —— 只有依赖矩阵中 ✅ 的调用允许
3. **类型隔离** —— 每层有专属输入/输出类型，不透传
4. **依赖注入** —— 通过构造注入，不硬编码跨层 import
5. **例外需 ADR** —— 任何跨层调用需架构决策记录
6. **评审必查** —— 分层违规是 PR review 的必查项

> 契约部分完结。下一篇：[03-development/01-coding-standard.md](../03-development/01-coding-standard.md)
