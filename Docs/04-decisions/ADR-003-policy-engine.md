# ADR-003: 为什么需要 Policy Engine

- **状态**：Accepted
- **日期**：2025-06-30

## 背景

Execution Planner 已经能根据意图、元信息、资源做决策生成 ExecutionPlan。是否还需要独立的 Policy Engine？

## 决策

**需要独立的 Policy Engine，对 Planner 的草稿做配置化校验与覆盖。**

```
Planner  →  草稿 Plan（建议性）
Policy   →  最终 Plan（强制性，可覆盖）
```

## 理由

### 1. 建议与合规分离
- Planner 负责「怎么做最合理」（业务逻辑）
- Policy 负责「这么做是否被允许」（约束规则）

把约束写进 Planner，会让 Planner 越来越臃肿，且约束变更需改代码。

### 2. 强制性约束需要独立层
某些约束是**不可违反**的，例如：
- 内容审核（moderation）必须用本地模型，数据不外发
- 超大图（>50MB）直接拒绝
- 内存不足时强制降级

这些「安全守卫」若混在 Planner 的建议逻辑里，容易被遗漏或绕过。

### 3. 配置化优于硬编码
策略规则（如「复杂度 high + quality high → 用大模型」）会随运营调整。写在 YAML 里可热加载，写在代码里需发版。

### 4. 单匹配语义清晰
Policy 按 priority 降序，命中第一个即停（类似 switch-case）。这比在 Planner 里堆 if-else 更清晰、可测试。

### 5. 可审计
Policy 的 deny/warn 动作可记录审计日志。Planner 的「建议」不需要审计，Policy 的「拒绝」需要。

## 替代方案

### 方案 B：把策略写进 Planner
- 优点：少一层，简单
- 缺点：Planner 臃肿；约束变更需改代码；安全规则易被绕过；不可热加载
- **否决**

### 方案 C：只用配置，不要 Policy Engine（声明式配置直接生效）
- 即把 policy.yaml 直接作为 Planner 的决策规则
- 缺点：失去「建议+合规」的两阶段语义；无法区分可覆盖与不可违反
- **否决**

## 边界澄清

| 场景 | Planner | Policy |
|------|---------|--------|
| 意图→Skill | ✅ | ❌ |
| 元信息→预处理 | ✅ | 可覆盖 |
| 资源→Runtime | ✅ | 可覆盖 |
| 成本→Provider 建议 | ✅ | 可覆盖 |
| 安全强制（审核本地） | ❌ | ✅ 强制 |
| 资源保护（内存降级） | ❌ | ✅ 强制 |
| 拒绝超大图 | ❌ | ✅ deny |

## 影响

- Planner 产出草稿，不可直接执行
- Policy 评估后才是最终 Plan
- Policy 拥有最终决定权（override 优先）
- 新增/调整策略 = 改 YAML，不改代码
- 策略可热加载

## 相关
- [01-architecture/03-execution-planner.md](../01-architecture/03-execution-planner.md)
- [01-architecture/04-policy-engine.md](../01-architecture/04-policy-engine.md)
