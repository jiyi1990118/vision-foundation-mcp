# 13. Universal Vision Parser（result.parse）

> 混合编排架构：已有 Skills（classify / ocr / summary / layout）与算法提取器
> （chart / diagram / document / code / form）构成**感知层**；Universal Parser
> 在其之上增加**编排层**，融合所有输出为面向 AI Agent 的结构化 JSON。

## 1. 设计目标

| 目标 | 说明 |
|---|---|
| **一次推理** | 仅 `runReasoning()` 需要一次额外 VLM 调用（insights / risks / next_actions）；其余字段全部由已有 Skills + 提取器组装 |
| **模板兜底** | VLM 推理失败 / 空输出 / 幻觉时，自动回退到场景模板（`nextActionTemplates`），确保 Agent 始终获得可操作建议 |
| **纯函数组装** | `buildUniversalParse()` 是同步纯函数；异步 VLM 推理由调用方在 `composeResult` 之前完成并传入 |
| **感知层复用** | 不重复 VLM 调用；直接消费 classify 结果、OCR 文本与置信度、scenario 提取器结构化数据 |

## 2. 输出结构

```typescript
interface UniversalParse {
  scene: SceneBlock;          // 场景检测（多信号融合）
  quality: QualityBlock;      // 图像质量 + OCR 置信度
  layout: Record<string, unknown>;  // 算法布局（leftSidebar / mainContent / footerActions）
  ocr: { corrected: string }; // 规整后的 OCR 文本
  entities: Entity[];          // url / email / phone / date / metric / field / node ...
  relationships: Relationship[]; // 图表边、流程箭头
  logic: string[];             // 分支条件、流向、代码语言/行数
  summary: string;             // 最终摘要文本
  insights: string[];          // VLM 推理洞察（或空）
  risks: string[];             // VLM 推理风险（或空）
  next_actions: string[];      // VLM 推理建议（或场景模板兜底）
  confidence: number;          // 整体置信度
}
```

### 2.1 SceneBlock（场景检测）

```typescript
interface SceneBlock {
  detected: SceneEntry[];  // 所有检测到的候选场景
  final: ParseScene;        // 最高置信度场景
  reason: string;           // 选取理由
}
interface SceneEntry {
  scene: ParseScene;
  confidence: number;
  reason: string;
}
```

**14 种 ParseScene：**

| ParseScene | 来源 |
|---|---|
| `document` | classify=document / scenario=invoice |
| `requirement` | scenario=requirement（标注框 / 目标查询） |
| `ui` | classify=ui/screenshot / scenario=form |
| `prototype` | OCR/summary/intent 关键词（原型 / wireframe） |
| `photo` | classify=photo |
| `code` | scenario=code |
| `table` | OCR/summary/intent 关键词（表格） |
| `chart` | classify=chart/dashboard / scenario=chart |
| `flowchart` | classify=diagram / scenario=diagram |
| `mindmap` | 关键词精炼（思维导图 / 脑图） |
| `ppt` | classify=poster / 关键词（幻灯片） |
| `chat` | 关键词精炼（聊天 / 对话 / 消息） |
| `error` | 关键词精炼（error / exception / 报错） |
| `other` | 兜底 |

**场景融合逻辑**（`buildSceneDetection`）：

1. classify category → scene（置信度 0.7）
2. scenario → scene（置信度 0.9，意图驱动高特异性）
3. 用户 `scene` hint → scene（置信度 0.8，引导不覆盖强证据）
4. OCR + summary + intent 关键词精炼（`refineScene`，置信度 0.9）

四个信号去重后按置信度排序，取最高为 `final`。

### 2.2 QualityBlock（质量评估）

```typescript
interface QualityBlock {
  clarity: number;          // 图像清晰度（0-1）
  ocr_confidence: number;   // OCR 置信度（0-1）
  issues: string[];          // 质量问题标记
}
```

- **clarity**：基于图像尺寸与复杂度。宽 < 400px → 0.4 + `low-resolution`；complexity=low → 0.9；high → 0.6
- **ocr_confidence**：优先使用 per-item 置信度均值（paddle-ocr 提供真实分数）；不足半数时回退到 count-based 估计。低于 0.4 标记 `low-ocr-confidence`

### 2.3 Entity / Relationship / Logic

| 字段 | 数据来源 |
|---|---|
| entities | OCR 正则（url/email/phone/date）+ scenario 提取器（metric/category/node/field/language/title）+ key-content 字段 |
| relationships | diagram 提取器的 edges（from→to flow） |
| logic | diagram 条件/流向 + code 语言/行数 |

实体去重：`type:value:label` 三元组去重（同值不同 label 的字段保留）。

### 2.4 Reasoning（insights / risks / next_actions）

- `runReasoning()`：单次 VLM 调用，temperature=0，maxTokens=256
- 传入 image + compact 文本上下文（scene / OCR excerpt / summary excerpt / key entities）
- **幻觉检测**：同一短语重复 > 2 次判定为幻觉 → 回退模板
- **稀疏跳过**：无 OCR / summary / 提取数据时跳过 VLM 调用（省 ~3-5s）
- **部分回退**：VLM 返回 insights+risks 但 next_actions 为空时，从场景模板补齐

## 3. 场景分类法（scene-taxonomy.ts）

```
src/core/scene-taxonomy.ts
```

| 函数 | 作用 |
|---|---|
| `sceneFromClassify(category)` | classify → scene（0.7 置信度） |
| `sceneFromScenario(scenario)` | scenario → scene（0.9 置信度，跳过 general） |
| `sceneFromHint(hint)` | 用户 scene 参数 → scene（0.8 置信度） |
| `refineScene(base, text)` | OCR+summary+intent 关键词精炼（mindmap/prototype/ppt/chat/error/table） |
| `nextActionTemplates(scene)` | 每种场景的兜底 next_actions 模板 |

## 4. Scenario 提取器（extractors/）

```
src/core/extractors/
  scenario-dispatcher.ts   # 路由
  chart-extractor.ts       # 指标 / 类别 / 系列
  diagram-extractor.ts     # 节点 / 边 / 条件 / 流向
  document-extractor.ts    # 字段 / 行项目 / 区域
  code-extractor.ts        # 语言 / 行 / 行数
  form-extractor.ts        # 部分 / 字段
```

- 所有提取器均为 **OCR 驱动**（不信任 VLM），带 try/catch 回退
- `scenario-dispatcher.ts` 根据 `detectScenario()` 结果路由到对应提取器
- 输出 `ScenarioExtraction` 联合类型，feeding `result.parse` 的 entities/relationships/logic

### ScenarioType（scenario-resolver.ts）

```typescript
type ScenarioType = 'requirement' | 'chart' | 'diagram' | 'invoice' | 'code' | 'form' | 'general';
```

检测逻辑：intent 关键词 OR classify category 命中即触发（关键词优先）；标注框 / 目标查询 → requirement。

## 5. 集成位置

```
vision-analyze.ts (Stage 9 后处理)
  ├── detectAnnotations()       → 多色标注（5 色）
  ├── extractKeyContent()        → 需求场景 key-content
  ├── extractForScenario()       → scenario 提取器
  ├── runReasoning()             → VLM 推理（可跳过）
  └── composeResult()            → buildUniversalParse() → result.parse
```

`composeResult` 传入 `UniversalParseInput`（含 category/confidence/scenario/summary/ocrText/ocrItems/layout/
scenarioExtractionData/keyContentExtraction/reasoningResult/sceneHint/metadata/intent），
`buildUniversalParse` 纯函数组装并写入 `resultMap.parse`。

## 6. 整体置信度

```typescript
// classify 运行时：blend classify + ocr 置信度
// classify 未运行（confidence=0）：使用 OCR 置信度
const overallConfidence = input.confidence > 0
  ? round((input.confidence + quality.ocr_confidence) / 2)
  : round(quality.ocr_confidence);
```

## 7. 测试覆盖

`tests/universal-parser.test.ts`（49+ 测试）：
- 场景检测：classify/scenario/hint 融合、关键词精炼、intent 触发
- 质量评估：低分辨率、无 OCR、per-item 置信度均值、count-based 回退
- 实体提取：正则/scenario/key-content、去重（同值不同 label 保留）、上限
- 关系/逻辑：图表边、分支条件、代码语言/行数
- 组装：模板兜底、VLM 推理、部分回退、置信度计算、OCR 规整
