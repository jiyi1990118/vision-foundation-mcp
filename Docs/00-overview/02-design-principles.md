# 02 - 设计原则（Design Principles）

> 原则不是口号，是代码评审和架构决策的裁判标准。当遇到「这样也行、那样也行」时，用这些原则裁决。

---

## 原则总览

```
┌─────────────────────────────────────────────┐
│  1. 单一职责     Single Responsibility      │
│  2. 本地优先     Local First                │
│  3. 配置驱动     Configuration Driven       │
│  4. 插件优先     Plugin First               │
│  5. 分层解耦     Layered Decoupling         │
│  6. 质量内建     Quality Built-in           │
│  7. 契约稳定     Stable Contract            │
│  8. 渐进增强     Progressive Enhancement    │
└─────────────────────────────────────────────┘
```

---

## 原则 1：单一职责（Single Responsibility）

**每个模块、每个类、每个函数，只做一件事。**

### 落实点
- Vision MCP 整体只做视觉理解，不做数据获取
- Execution Planner 只做「决策」，不做「执行」
- Skill 只定义「能力」，不关心「用哪个模型」
- Provider 只关心「模型调用」，不关心「业务语义」
- Runtime 只关心「推理引擎」，不关心「模型业务」

### 反模式（禁止）
- Skill 里直接 `import onnxruntime` —— Skill 不该知道 Runtime 的存在
- Planner 里直接调用模型 —— Planner 只产出 ExecutionPlan，不执行
- Tool 里写业务逻辑 —— Tool 只是 MCP 入口，逻辑在 Skill

---

## 原则 2：本地优先（Local First）

**默认本地，离线可用；云端是可选升级，不是默认路径。**

### 落实点
- 默认 Provider = SmolVLM2（GGUF via llama.cpp，Metal/CUDA/CPU 加速，约 500MB）
- 模型自动下载到本地缓存目录 `~/.vision-mcp/models/`
- 不依赖任何云端 API Key 即可运行
- 配置 `quality: high` 时才切换大模型（MiniCPM-V，需 GPU）

### 决策示例
- 选型：SmolVLM2 Q8_0 via llama.cpp —— Metal/CUDA 加速，CPU 也可跑
- 选型：ONNX Runtime 优先 —— 跨平台、CPU 友好
- 选型：不默认依赖 GPU —— 保证最广可用性

---

## 原则 3：配置驱动（Configuration Driven）

**能用配置解决的，不用代码。策略变更 = 配置变更。**

> 现状说明：YAML 配置文件（`policy.yaml` / `providers.yaml` 等）为**规划目标，尚未实现**。当前配置机制为 JSON（`config/default.json`，可选）+ 环境变量（`VISION_*`）覆盖；策略规则硬编码在 `policy-engine.ts` 的 `DEFAULT_RULES` 中。本原则描述的是目标方向，正逐步收敛中。

### 落实点（现状）
- 运行参数 -> `config/default.json` + 环境变量（`VISION_*`）
- 策略规则 -> `policy-engine.ts` 硬编码 `DEFAULT_RULES`（large-image-resize / memory-guard 仅告警 / reject-huge）
- 生命周期参数（idle timeout 等）-> 硬编码在 `BaseLlamaCppProvider`
- 预处理流程（resize 等）-> ExecutionPlan 配置

### 示例（目标形态，YAML 配置化）
```yaml
# 新增一个「大图缩放」策略，不改任何代码
policies:
  - name: large-image-resize
    when:
      image.width > 3000
    preprocess:
      - resize
```

### 反模式（禁止）
- `if (image.width > 3000) { resize() }` 硬编码在 Skill 里
- 新增模型需要修改 Planner 源码

---

## 原则 4：插件优先（Plugin First）

**核心引擎稳定，能力通过插件扩展。新增 = 加文件，不是改文件。**

### 三条扩展轴
```
Skill（能力）     新增视觉能力 -> 加 skills/xxx/ 目录
Provider（模型）  新增模型     -> 加 providers/xxx/ 目录
Runtime（引擎）   新增推理引擎 -> 加 providers/llama-server/ 共享基类
```

### 落实点
- 每个 Skill 是独立目录：`skill.json + prompt.md + schema.json`（无 validator.ts / postprocess.ts / examples/，校验内联在 SkillPipeline）
- 每个 Provider 实现 `VisionProvider` 接口即可注册
- GGUF Provider 共享 `BaseLlamaCppProvider` 基类，统一生命周期 / 缓存 / 图像优化
- 新增任一插件，**不需要修改** Engine 核心代码

### 反模式（禁止）
- 新增 Skill 需要修改 SkillEngine 的 switch/case
- 新增 Provider 需要修改 ExecutionPlanner

---

## 原则 5：分层解耦（Layered Decoupling）

**严格单向依赖，禁止跨层调用。**

### 分层与依赖方向
```
Tool（MCP入口）
  ↓ 调用
Planner（决策）
  ↓ 产出 ExecutionPlan
Policy（策略校验/选择）
  ↓ 产出最终 Plan
Skill（能力定义）
  ↓ 声明所需 Prompt + Schema
Provider（模型抽象）
  ↓ 调用
Runtime（推理引擎）
  ↓ 执行
Model（模型文件）
```

### 严格禁止
- ❌ Skill 直接调用 Runtime（`import onnxruntime`）
- ❌ Tool 直接调用 Provider（跳过 Planner/Policy/Skill）
- ❌ Runtime 知道 Skill 的存在（反向依赖）
- ❌ Provider 知道具体业务语义

> 详见 [02-contracts/03-layer-rules.md](../02-contracts/03-layer-rules.md)

---

## 原则 6：质量内建（Quality Built-in）

**小模型输出不可靠是常态，质量保障是必需品。**

### 三层质量保障
```
1. Prompt Compiler    用户意图 → 模型优化的 Prompt
2. Response Validator 模型输出 → Schema 校验 → 自动修复/重试
3. Result Composer    多 Skill 结果 → 统一 structuredContent
```

### 落实点
- 所有 Skill 必须定义 `schema.json`，模型输出必须过校验
- Prompt 不由 LLM 临时生成，从 Prompt Registry 取
- 解析失败时轻量重试（1-2 次），而非直接报错
- 多 Skill 组合时由 Composer 统一格式

### 反模式（禁止）
- 把用户原始问题直接喂给模型
- 模型返回什么就用什么，不校验
- 各 Skill 各自返回，格式不统一

---

## 原则 7：契约稳定（Stable Contract）

**对外契约（API、Schema、返回结构）一旦发布，不轻易破坏性变更。**

### 稳定契约清单
| 契约 | 说明 |
|------|------|
| `vision.analyze` Tool 入参 | MCP 暴露的唯一接口 |
| `structuredContent` 返回结构 | Client 依赖它解析 |
| Skill 的 `schema.json` | Provider 按此约束输出 |
| `VisionProvider` 接口（含 `runtime` 字段） | Provider 插件按此实现 |

### 变更规则
- 新增字段：允许（向后兼容）
- 删除/重命名字段：禁止（需走 v2 + 废弃周期）
- Schema 变更：走版本号（`schema_version`）

---

## 原则 8：渐进增强（Progressive Enhancement）

**先跑通最小闭环，再逐层增强。不追求一次性完美。**

### 落实到开发顺序
```
1. 先跑通：Tool → SmolVLM → 返回文本（最小闭环）
2. 再加：Request Normalizer + 统一返回结构
3. 再加：Skill 抽象 + Prompt Registry
4. 再加：Schema Validator + Result Composer
5. 再加：Execution Planner + Policy Engine
6. 再加：Cache + Lifecycle Manager
7. 再加：第二个 Provider / Runtime
```

### 反模式（禁止）
- 第一行代码就写 22 层架构
- 没跑通就写 60 份文档
- 为了「未来扩展」提前实现永远不会用的抽象

---

## 原则冲突时的优先级

当原则之间冲突时，按以下优先级裁决：

```
1. 单一职责 > 可扩展性      （宁可先做好一件事）
2. 本地优先 > 功能丰富      （宁可先离线可用）
3. 契约稳定 > 实现简洁      （对外契约不能随便改）
4. 渐进增强 > 一步到位      （先跑通再优化）
5. 质量内建 > 性能极致      （准确率优先于速度）
```

---

## 原则自检清单

开发任何模块前，用以下清单自检：

- [ ] 这个模块的单一职责是什么？能用一句话说清吗？
- [ ] 新增同类能力时，需要改这个模块吗？（不需要 = 插件化达标）
- [ ] 策略/参数是配置化的，还是硬编码的？
- [ ] 这个调用是否跨越了分层边界？
- [ ] 小模型输出不可靠时，有兜底校验吗？
- [ ] 这个对外契约变更会破坏现有 Client 吗？
- [ ] 这一步是否在最小可跑通路径上？还是过度设计？

---

## 本文小结

8 条原则不是平行的，它们服务于一个目标：

> **让这个项目可维护、可扩展、可信赖。**

- 可维护：单一职责 + 分层解耦 + 契约稳定
- 可扩展：插件优先 + 配置驱动
- 可信赖：本地优先 + 质量内建
- 可落地：渐进增强

> 下一份文档：[01-architecture/01-system-architecture.md](../01-architecture/01-system-architecture.md) —— 把原则落实为系统架构。
