# ADR-001: 为什么只有一个 Tool

- **状态**：Accepted
- **日期**：2025-06-30
- **决策者**：架构设计

## 背景

MCP 服务通常可以为每个能力暴露一个 Tool。例如 Vision 场景可能考虑：
- `vision.classify`
- `vision.ocr`
- `vision.ui`
- `vision.chart`
- `vision.object`
- ...

即十几个 Tool。

## 决策

**只暴露一个 Tool：`vision.analyze`。**

所有视觉能力通过 `intent`（自然语言意图）或 `skills`（显式指定）参数在内部路由到对应 Skill。

```json
{
  "name": "vision.analyze",
  "input": { "image": "...", "intent": "extract text" }
}
```

## 理由

### 1. 避免 Tool 爆炸
视觉能力有十几种（classify/ocr/ui/chart/table/color/moderation/...），未来还会增加。每增一个 Skill 就加一个 Tool，会导致：
- MCP Client 的 Tool 列表臃肿
- LLM 选择 Tool 的负担增大（选择困难）
- Tool 间参数重复（都要 image）

### 2. LLM 友好
单个 Tool + 自然语言 intent，让 LLM 用自然方式表达需求，而非记忆十几个 Tool 名。Execution Planner 负责意图→Skill 的映射，这是 Planner 存在的核心价值。

### 3. 内部编排能力
很多分析是**多 Skill 组合**（如「详细解析」= classify + ocr + summary）。如果按 Tool 暴露，要么 Client 自己编排（增加 Client 负担），要么仍需一个 `vision.auto` Tool。不如统一成一个 `analyze`，内部编排。

### 4. 契约稳定
新增 Skill 时，不需要新增 Tool，对外契约不变。Client 无感知升级。

## 替代方案

### 方案 B：每个能力一个 Tool
- 优点：每个 Tool 职责清晰
- 缺点：Tool 数量膨胀；LLM 选择负担；多能力组合需 Client 编排；新增能力破坏契约（新增 Tool）
- **否决**

### 方案 C：少量粗粒度 Tool（如 vision.understand / vision.extract）
- 优点：比方案 B 少
- 缺点：边界模糊，本质还是需要 intent 路由
- **否决**

## 影响

- Execution Planner 必须可靠地做意图→Skill 映射
- Tool 的 inputSchema 需灵活（支持 intent 或 skills）
- 文档需明确 intent 的常见表达方式，帮助用户/LLM 正确使用

## 相关
- [ADR-002: 为什么 Skill 不是 Tool](./ADR-002-skill-not-tool.md)
- [02-contracts/02-api-contract.md](../02-contracts/02-api-contract.md)
