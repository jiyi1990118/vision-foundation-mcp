# ADR-002: 为什么 Skill 不是 Tool

- **状态**：Accepted
- **日期**：2025-06-30

## 背景

Skill（如 ocr、ui、chart）是视觉能力单元。是否应把每个 Skill 直接映射为一个 MCP Tool？

## 决策

**Skill 是内部能力抽象，不等于 MCP Tool。**

- MCP 对外：只有 `vision.analyze` 一个 Tool（见 ADR-001）
- 内部能力：Skill 由 Execution Planner 根据意图选择，由 Skill Pipeline 编排

```
Tool（对外）  ≠  Skill（对内）
Tool = 1 个（vision.analyze）
Skill = N 个（内部能力单元）
```

## 理由

### 1. 职责不同
- **Tool** 是 MCP 协议的接口契约，面向 Client/LLM
- **Skill** 是内部能力单元，面向 Pipeline 编排

二者属于不同抽象层级，强行 1:1 映射会耦合内外。

### 2. Skill 可组合
一次 `vision.analyze` 可编排多个 Skill（如 classify + ocr + summary）。如果 Skill=Tool，Client 需自己调三次并合并结果，违背「MCP 服务封装复杂度」的原则。

### 3. Skill 有依赖关系
某些 Skill 串行依赖（先 classify 判断类型，再决定跑 chart 还是 ui）。这种编排逻辑应在服务内部，不应暴露给 Client。

### 4. Skill 可条件执行
Plan 可能根据前置 Skill 结果决定是否执行后续 Skill（条件分支）。这是内部编排，Tool 层不该感知。

### 5. Skill 可热插拔
新增 Skill 不影响对外 Tool 契约。如果 Skill=Tool，每次增减都改变对外契约。

## 替代方案

### 方案 B：Skill 1:1 映射 Tool
- 即 ADR-001 的方案 B，已否决

### 方案 C：Skill 作为 Tool 的子参数
```json
{ "name": "vision.analyze", "skill": "ocr" }
```
- 这其实就是当前方案（skills 参数），只是 Skill 作为参数而非独立 Tool
- **采纳为当前方案的一部分**

## 影响

- Skill 是插件，新增不改 Tool 契约
- Pipeline 负责多 Skill 编排（串行/并行/条件）
- Planner 负责意图→Skill 映射
- Skill 需声明 `supportedProviders`（模型能力匹配）

## 相关
- [ADR-001: 为什么只有一个 Tool](./ADR-001-single-tool.md)
- [01-architecture/05-skill-engine.md](../01-architecture/05-skill-engine.md)
