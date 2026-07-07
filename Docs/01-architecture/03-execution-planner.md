# 03 - Execution Planner（执行规划器）

> Planner 是整个系统的大脑。它负责「制定策略」而非「执行」。它的输出是一个 `ExecutionPlan`，交给后续模块执行。

---

## 1. 设计目标

| 目标 | 说明 |
|------|------|
| 自动决策 | 用户无需手动选模型/选 Skill |
| 多因素综合 | 意图 + 图片元信息 + 机器资源 + 配置 |
| 可插拔策略 | 决策逻辑可配置化，不改代码 |
| 只规划不执行 | 严格产出 Plan，不触碰 Provider/Runtime |

## 非目标
- ❌ 不执行推理（那是 Provider/Runtime 的事）
- ❌ 不做策略校验（那是 Policy Engine 的事）
- ❌ 不做输出校验（那是 Validator 的事）

---

## 2. 输入与输出

### 输入：NormalizedRequest
```typescript
interface PlannerInput {
  image: ImageInput;          // 归一化后的图片
  metadata: ImageMetadata;    // 尺寸/复杂度/估计类型
  intent: string;             // 用户自然语言意图
  requestedSkills?: string[]; // 用户显式指定的 Skill
  options: {
    quality?: "fast" | "high";
    provider?: string;        // 用户强制指定
  };
  resources: MachineResources; // CPU/内存/GPU/可用Runtime
}
```

### 输出：ExecutionPlan（草稿）
```typescript
interface ExecutionPlan {
  provider: string;
  runtime: string;
  preprocess: string[];        // ["resize", "denoise"]
  skills: SkillTask[];
  postprocess: string[];       // ["merge"]
  cacheKey: string;
  timeout: number;
  retry: { max: number; strategy: "none" | "reprompt" | "fallback" };
}
```

> 注：Planner 产出的是「草稿」，最终 Plan 由 Policy Engine 校验/覆盖后生效。

---

## 3. 决策维度

Planner 综合以下 **5 个维度** 做决策：

### 3.1 意图分析（Intent Analysis）

将用户自然语言意图映射到 Skill：

```
用户意图                      →  Skill(s)
─────────────────────────────────────────────
"这张图有没有兔子"            →  object
"分析这个UI"                  →  ui, layout
"详细解析图片"                →  classify, summary
"提取文字"                    →  ocr
"这个图表是什么类型"          →  chart
"配色方案是什么"              →  color
"这个页面是什么风格"          →  ui (design-style)
```

**实现方式**：
- 关键词匹配表（快速、确定性强）
- 可选：轻量意图分类器（本地小模型，非 SmolVLM）

**优先级**：用户显式指定 `requestedSkills` 时，跳过意图推断。

### 3.2 图片元信息分析（Metadata Analysis）

基于 Metadata Extractor 的结果调整策略：

```
条件                          →  调整
─────────────────────────────────────────────
width > 3000                  →  preprocess 加 resize
complexity == high            →  倾向高质量 provider
estimatedType == "document"   →  优先 ocr + document skill
estimatedType == "ui"         →  优先 ui skill
fileSize > 10MB               →  预处理压缩
```

### 3.3 复杂度分析（Complexity Analysis）

复杂度由 Metadata Extractor 估算（轻量算法），Planner 据此决策：

```
complexity == low   →  fast 模式，单 Skill，smolvlm2
complexity == medium →  常规多 Skill，smolvlm2
complexity == high  →  若 quality=high 则切换 minicpm
```

### 3.4 资源分析（Runtime Analysis）

```
有 GPU (Metal/CUDA)  →  llama-cpp（GPU 加速）
仅 CPU              →  llama-cpp（CPU 模式）
内存不足            →  路由器筛掉大模型，只用 smolvlm2
某 Runtime 不可用    →  回退到可用 Runtime
```

### 3.5 成本分析（Cost Analysis）

```
quality == fast     →  优先本地小模型，最省
quality == high     →  允许切换大模型（若可用）
默认                 →  本地优先
```

---

## 4. 决策流程图

```
                  ┌──────────────┐
                  │ PlannerInput │
                  └──────┬───────┘
                         │
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
    ┌────────────┐ ┌──────────┐ ┌────────────┐
    │意图分析    │ │元信息分析│ │资源分析    │
    │→ Skills    │ │→ preprocess│ │→ Runtime  │
    └─────┬──────┘ └─────┬────┘ └─────┬──────┘
          │              │             │
          └──────────────┼─────────────┘
                         ▼
                ┌────────────────┐
                │ 复杂度+成本分析  │
                │ → Provider 选择 │
                └───────┬────────┘
                        │
                        ▼
                ┌────────────────┐
                │  生成草稿 Plan  │
                └───────┬────────┘
                        │
                        ▼
                ┌────────────────┐
                │ 输出 ExecutionPlan │
                └────────────────┘
```

---

## 5. Skill 选择策略

### 5.1 单 Skill 场景
用户意图明确指向单一能力时：
```
"提取文字" → skills: [ocr]
"配色"     → skills: [color]
```

### 5.2 多 Skill 场景
意图模糊或要求「全面分析」时：
```
"详细解析" → skills: [classify, ocr, summary]
"分析UI"   → skills: [ui, layout, color]
```

### 5.3 依赖编排
某些 Skill 有依赖关系，Pipeline 按依赖图执行：
```
classify（先判断类型）
   │
   ├── chart  （若是图表）
   ├── table  （若有表格）
   ├── ui     （若是UI）
   └── document（若是文档）
summary（最后综合）
```

### 5.4 自动分析模式（Auto Analyze）
当 intent 为空或为 "auto" 时，Planner 先跑 `classify`，再按类型决定后续 Skill：
```
auto → classify → 根据结果分支：
                     ├── dashboard → chart + summary
                     ├── document  → ocr + document
                     ├── ui        → ui + layout
                     ├── photo     → summary + color
                     └── ...       → summary
```

---

## 6. Provider 选择策略

Planner 的 Provider 选择是「建议」，可被 Policy Engine 覆盖：

```
默认规则：
  quality=fast 或 未指定 → smolvlm2（默认本地优先）
  quality=high 且 大模型可用 → minicpm
  资源不足 → 路由器筛选掉不可行的 provider

特殊规则：
  skill=moderation → 固定本地 provider（不外发隐私数据）
  image.width>8000 → 需大模型（小模型处理不了）
```

---

## 7. 缓存键生成

```typescript
cacheKey = SHA256(image) + ":" + hash(intent + skills + options)
```

- 相同图片 + 相同意图 → 命中缓存
- 不同意图分析同一图片 → 不命中（合理）

---

## 8. 超时与重试策略

Planner 根据 Skill 类型和复杂度设置 timeout：

```
Skill 类型          默认 timeout    retry.max
─────────────────────────────────────────────
classify           3000ms          1
ocr                10000ms         1
ui                 8000ms          1
summary            5000ms          1
chart              10000ms         1
moderation         3000ms          0（不重试）
```

重试策略：
- `reprompt`：重试时强化 prompt（如更强调「只输出JSON」）
- `fallback`：重试时降级到更简单的 Skill
- `none`：不重试

---

## 9. 接口定义

```typescript
interface ExecutionPlanner {
  /**
   * 制定执行计划（草稿）
   * 只规划，不执行
   */
  plan(input: PlannerInput): Promise<ExecutionPlan>;
}
```

**不变量**：
- `plan()` 是纯决策函数，无副作用
- 不在此处调用任何 Provider/Runtime
- 不在此处读写缓存（那是 Pipeline/Cache 的事）

---

## 10. 扩展点

### 自定义意图映射
```yaml
# config/intents.yaml
intentMappings:
  - keywords: ["兔子", "猫", "狗", "动物"]
    skills: [object]
  - keywords: ["仪表盘", "dashboard", "报表"]
    skills: [classify, chart, summary]
```

### 自定义决策规则
通过 Policy Engine 覆盖 Planner 的建议（而非修改 Planner 本身）。

---

## 11. 测试要点

| 测试场景 | 预期 |
|----------|------|
| 意图「提取文字」 | skills 含 ocr |
| 意图为空 | 进入 auto 模式，含 classify |
| 图片 width>3000 | preprocess 含 resize |
| quality=high + 大模型可用 | provider=minicpm |
| quality=high + 大模型不可用 | 回退 smolvlm2 |
| 内存不足 | 路由器筛掉大模型，用 smolvlm2 |
| skill=moderation | 固定本地 provider（不外发） |
| 用户指定 requestedSkills | 跳过意图推断 |

---

## 12. 本文小结

Execution Planner 是系统大脑，核心要点：

1. **只决策不执行** —— 产出 ExecutionPlan 草稿
2. **5 维综合** —— 意图 + 元信息 + 复杂度 + 资源 + 成本
3. **草稿可被覆盖** —— Policy Engine 拥有最终决定权
4. **意图映射可配置** —— 不改代码扩展新意图
5. **资源感知** —— 内存不足时自动降级

> 下一篇：[04 - Policy Engine](./04-policy-engine.md) —— 对 Planner 的草稿做配置化校验与覆盖。
