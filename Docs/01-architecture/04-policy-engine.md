# 04 - Policy Engine（策略引擎）

> Policy Engine 对 Planner 产出的「草稿 Plan」做配置化校验与覆盖。新增模型、调整策略，改配置不改代码。

---

## 1. 设计目标

| 目标 | 说明 |
|------|------|
| 配置驱动 | 策略全部写在 YAML，不硬编码 |
| 可覆盖 | 能覆盖 Planner 的建议 |
| 可守卫 | 能强制某些约束（如审核不外发） |
| 无副作用 | 纯函数，输入草稿 → 输出最终 Plan |

## 非目标
- ❌ 不做决策（那是 Planner 的事）
- ❌ 不执行推理
- ❌ 不做意图分析

---

## 2. 为什么需要 Policy Engine

**问题**：Planner 的决策逻辑是「建议性」的，但有些场景需要「强制性」约束：

| 场景 | Planner 建议 | Policy 强制 |
|------|-------------|-------------|
| 内容审核 | 可能选大模型 | 强制本地 provider（隐私不外发） |
| 超大图 | 可能直接推理 | 强制先 resize |
| 内存紧张 | 可能选大模型 | 强制降级 |
| 特定 Skill | 默认 timeout | 覆盖为更长 timeout |

如果这些约束写进 Planner，Planner 会越来越臃肿。**Planner 负责「合理」，Policy 负责「合规」。**

---

## 3. 策略配置结构

### 3.1 policy.yaml 结构
```yaml
policies:
  - name: <策略名>              # 唯一标识
    description: <说明>          # 人类可读
    priority: <number>           # 优先级，数字越大越先匹配
    when:                        # 匹配条件（全满足才命中）
      <条件键>: <条件值>
    override:                    # 覆盖字段
      <Plan字段>: <值>
    action: <allow | deny | warn>  # 动作
```

### 3.2 条件键（when）

| 条件键 | 类型 | 示例 | 说明 |
|--------|------|------|------|
| `image.size` | number | `< 2MB` | 文件大小 |
| `image.width` | number | `> 3000` | 宽度 |
| `image.height` | number | `> 3000` | 高度 |
| `complexity` | enum | `== high` | 复杂度 |
| `estimatedType` | string | `== ui` | 估算类型 |
| `skill` | string | `== moderation` | 含某 Skill |
| `quality` | enum | `== high` | 质量模式 |
| `provider` | string | `== qwen` | Planner 建议的 provider |
| `memory.available` | number | `< 2GB` | 可用内存 |
| `hasGPU` | boolean | `== true` | 是否有 GPU |

### 3.3 覆盖字段（override）

可覆盖 ExecutionPlan 的任意字段：
```yaml
override:
  provider: gguf              # 覆盖模型（示例值；实际可选 gguf / smolvlm2 / minicpm）
  runtime: onnx              # 覆盖运行时
  preprocess:                # 覆盖预处理
    - resize
  timeout: 5000              # 覆盖超时
  retry:
    max: 2
    strategy: reprompt
```

### 3.4 动作（action）

| 动作 | 含义 |
|------|------|
| `allow` | 允许执行（可带 override） |
| `deny` | 拒绝执行，返回错误 |
| `warn` | 允许但记录警告日志 |

---

## 4. 策略匹配流程

```
草稿 Plan + Context
        │
        ▼
┌───────────────────┐
│ 按 priority 排序   │
│ 所有 policies     │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│ 依次评估 when 条件 │
│ 命中第一个即停止   │  ← 类似 switch-case
└─────────┬─────────┘
          │
     ┌────┴────┐
     ▼         ▼
  未命中      命中
     │         │
     │         ▼
     │    ┌─────────┐
     │    │ 执行 action │
     │    │ 应用 override│
     │    └────┬────┘
     │         │
     └────┬────┘
          ▼
   最终 ExecutionPlan
```

**匹配规则**：
- 按 `priority` 降序评估
- **命中第一个满足所有 when 条件的策略即停止**（单匹配）
- 未命中任何策略 → 直接采用草稿 Plan
- `deny` 动作 → 立即中断，返回 PolicyDeniedError

---

## 5. 内置策略示例

### 5.1 快速本地（默认）
```yaml
- name: fast-local
  priority: 10
  when:
    image.size: "< 2MB"
    complexity: "low"
  override:
    provider: gguf               # 默认 provider，本地 SmolVLM via llama.cpp
    runtime: gguf
```

### 5.2 大图预处理
```yaml
- name: large-image-resize
  priority: 20
  when:
    image.width: "> 3000"
  override:
    preprocess:
      - resize
    provider: gguf
```

### 5.3 高质量模式
```yaml
- name: high-quality
  priority: 30
  when:
    complexity: "high"
    quality: "high"
    memory.available: "> 4GB"
  override:
    provider: minicpm           # 高质量 provider；MiniCPM-V via llama.cpp
    runtime: gguf
```

### 5.4 安全审核（强制本地）
```yaml
- name: safety-moderation
  priority: 100                    # 最高优先级
  when:
    skill: "moderation"
  override:
    provider: gguf                # 审核数据不外发（任何本地 provider 皆可）
    retry:
      max: 0                       # 不重试
  action: allow
```

### 5.5 资源保护
```yaml
- name: memory-guard
  priority: 90
  when:
    memory.available: "< 1GB"
  action: warn                     # 允许但警告；不再覆盖 provider
```

> **实现状态**：`memory-guard` 规则当前仅发出 `warn`，不再通过 `override.provider` 强制切换到小模型。Provider 选择权完全交给 `ProviderRouter`（见 `src/core/provider-router.ts`），路由器在候选筛选阶段已经根据 `requirements.minMemoryMB` / `gpuRequired` 过滤掉不可行的 provider，避免在内存不足时仍然选中大模型。Policy Engine 不再重复这一决策。

### 5.6 拒绝超大图
```yaml
- name: reject-huge
  priority: 95
  when:
    image.size: "> 50MB"
  action: deny                     # 直接拒绝
```

---

## 6. 策略评估上下文

Policy Engine 评估时拿到的完整上下文：

```typescript
interface PolicyContext {
  plan: ExecutionPlan;          // Planner 草稿
  metadata: ImageMetadata;      // 图片元信息
  intent: string;               // 用户意图
  options: RequestOptions;      // 用户选项
  resources: MachineResources;  // 机器资源
}
```

条件表达式支持的运算符：
```
==   等于
!=   不等于
>    大于（数值）
<    小于（数值）
>=   >=
<=   <=
in   包含于列表
contains  字符串/数组包含
```

---

## 7. 接口定义

```typescript
interface PolicyEngine {
  /**
   * 评估策略，返回最终 Plan 或拒绝
   * @throws PolicyDeniedError 当命中 deny 策略
   */
  evaluate(ctx: PolicyContext): Promise<ExecutionPlan>;
}
```

**不变量**：
- 纯函数，无副作用（除日志）
- 不调用 Provider/Runtime
- 不修改草稿 Plan 对象（返回新对象）

---

## 8. 策略热加载

```yaml
# config/policy.yaml 可在运行时更新
# Policy Engine 监听文件变更，热加载新策略
# 无需重启服务
```

**冲突检测**：加载时检测同名策略、优先级重复，发出警告。

---

## 9. 策略测试要点

| 测试场景 | 预期 |
|----------|------|
| 小图 + 低复杂度 | 命中 fast-local |
| 大图 width>3000 | preprocess 含 resize |
| moderation + 任何条件 | provider=gguf（强制本地） |
| 内存<1GB | warn（不覆盖 provider；路由器已筛选） |
| 图片>50MB | deny |
| 无策略命中 | 采用草稿 Plan 原样 |
| 两个策略 priority 相同 | 加载时警告 |

---

## 10. Planner 与 Policy 的职责边界

```
┌─────────────┐         ┌─────────────┐
│   Planner   │         │   Policy    │
├─────────────┤         ├─────────────┤
│ 意图→Skill  │         │ 配置化约束   │
│ 元信息→预处理│  草稿   │ 强制安全规则 │
│ 资源→Runtime │ ────►   │ 资源保护     │
│ 成本→Provider│         │ 覆盖/拒绝    │
│ 生成超时/重试│         │ 最终决定权   │
├─────────────┤         ├─────────────┤
│  性质: 建议  │         │  性质: 强制  │
│  无配置     │         │  配置驱动    │
└─────────────┘         └─────────────┘
```

**一句话总结**：Planner 负责「怎么做最合理」，Policy 负责「这么做是否被允许」。

---

## 11. 本文小结

Policy Engine 核心要点：

1. **配置驱动** —— 策略全在 YAML，改配置不改代码
2. **单匹配** —— 按 priority 降序，命中第一个即停
3. **三种动作** —— allow（可覆盖）/ deny（拒绝）/ warn（警告）
4. **安全守卫** —— 审核、超大图、资源不足等强制约束
5. **最终决定权** —— Policy 的覆盖优先于 Planner 的建议
6. **热加载** —— 运行时更新策略无需重启

> 下一篇：[05 - Skill Engine](./05-skill-engine.md)
