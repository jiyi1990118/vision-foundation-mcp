# 01 - 开发路线图（Roadmap）

> 本路线图定义从当前到正式发布的里程碑。遵循「渐进增强」原则：先跑通最小闭环，再逐层增强。

---

## 里程碑总览

```
M1  最小闭环（Walking Skeleton）
    ↓
M2  核心引擎（Planner + Policy + Skill）
    ↓
M3  质量保障（Validator + Composer + Prompt Registry）
    ↓
M4  生产就绪（Cache + Lifecycle + 模型管理完善）
    ↓
M5  多模型扩展（MiniCPM-V / Qwen2.5-VL）
    ↓
M6  发布准备（npm / GitHub）
    ↓
M7  OCR-driven 结构化理解（v0.2）
    ↓
M8  Universal Vision Parser（v0.3）
```

---

## M1 - 最小闭环（Walking Skeleton）✅ 已完成

**目标**：跑通「图片进 -> 文本出」的最小路径，验证技术栈可行性。

### 交付内容
- [x] 项目骨架（src/ 目录结构、tsconfig、eslint、prettier）
- [x] MCP Tool `vision.analyze` 入口（硬编码，无 Planner）
- [x] Request Normalizer（支持 file/base64 两种输入）
- [x] SmolVLM Provider（直接调 ONNX Runtime，无 Runtime 抽象）
- [x] 模型自动下载（SmolVLM Q4_K_M）
- [x] 返回纯文本结果（无 structuredContent）

### 验收标准
```
给定一张图片 → vision.analyze → 返回 SmolVLM 的文本描述
```

### 不做
- ❌ Execution Planner
- ❌ Policy Engine
- ❌ Skill 抽象
- ❌ Schema 校验
- ❌ Cache
- ❌ 多 Provider

> 这一阶段验证「模型能跑、MCP 能通」，不追求架构完整。

---

## M2 - 核心引擎（Planner + Policy + Skill）✅ 已完成

**目标**：把 M1 的硬编码路径重构为分层架构，接入 Planner/Policy/Skill。

### 交付内容
- [x] ~~RuntimeAdapter 抽象~~（**设计偏移**：未实现独立 RuntimeAdapter，GGUF provider 直接使用 `BaseLlamaCppProvider` + `LlamaServerProcess`）
- [x] ExecutionPlanner（意图->Skill 映射，元信息->预处理）
- [x] ~~PolicyEngine（policy.yaml 配置化）~~（**设计偏移**：规则硬编码在 `DEFAULT_RULES`，未使用 YAML；3 条规则实现：large-image-resize、memory-guard、reject-huge）
- [x] SkillPipeline（串行/并行编排）
- [x] 至少 3 个 Skill：classify、ocr、summary
- [x] 统一返回 structuredContent 格式
- [x] MetadataExtractor（尺寸/复杂度估算）

### 验收标准
```
vision.analyze({ image, intent: "auto" })
  → Planner 决策 → Policy 校验 → 多 Skill 执行 → structuredContent 返回
```

### 依赖
- M1 完成

---

## M3 - 质量保障（Validator + Composer + Prompt Registry）✅ 已完成

**目标**：解决小模型输出不稳定问题，内建三层质量保障。

### 交付内容
- [x] ~~PromptRegistry + Prompt Compiler~~（**设计偏移**：prompts 内联在各 skill 目录的 prompt.md 中，由 registry.ts 加载，无独立 PromptRegistry 类）
- [x] ~~SchemaRegistry~~（**设计偏移**：每个 skill 的 schema.json 直接在 skill 目录中，无独立 SchemaRegistry 类）
- [x] ~~ResponseValidator~~（**设计偏移**：未提取为独立模块，内联在 SkillPipeline.parseAndValidate() 中，含 markdown 清理、JSON 提取、语法修复、必填字段检查）
- [x] ResultComposer（多 Skill 结果合并为统一 structuredContent）
- [~] ~~补充 Skill：ui、chart、color、object~~（**已撤销**：未作为独立 Skill 创建。chart/diagram 改为 Universal Parser 的场景抽取器 `src/core/extractors/`；ui 布局由 Composer 基于 OCR 算法化生成；color/object 未落地。当前共 8 个 Skill：classify/ocr/summary/table/document/poster/moderation/layout）
- [ ] 部分 Skill 失败 → PartialResult

### 验收标准
```
模型输出带 Markdown / 字段缺失 → 自动修复或重试 → 返回合法结构化结果
```

### 依赖
- M2 完成

---

## M4 - 生产就绪（Cache + Lifecycle + 模型管理）✅ 部分完成

**目标**：达到生产可用水平，资源管理完善。

### 交付内容
- [ ] ~~CacheManager~~（**未实现**：结果缓存设计为愿景文档 `Docs/01-architecture/12-cache.md`，当前 `options.cache` 为 no-op）
- [ ] ~~LifecycleManager~~（**设计偏移**：未实现独立 LifecycleManager 类，生命周期内联在 `BaseLlamaCppProvider` 中：引用计数、空闲定时器、内存监控。防抖机制 minDwellTime/warmup/backoff 未实现）
- [x] ModelManager 完善（断点续传、SHA256 校验、原子写入；版本管理为路线图项）
- [x] ~~错误处理体系~~（**设计偏移**：未实现 VisionError 类层次结构，使用 `classifyVisionError()` 函数 + 字符串匹配；7/18 个错误码已实现）
- [x] 日志体系（结构化日志 logger -> stderr，级别控制）
- [ ] ~~配置体系完善~~（**未实现**：所有 config/*.yaml 未创建，使用环境变量 + 硬编码默认值）
- [x] 安全防护（图片大小限制 10MB、SSRF 防护私有 IP 拦截、magic number 验证、并发限制 Semaphore(4)）
- [x] 补充 Skill：table、document、poster、moderation、layout

### 验收标准
```
- 首次调用自动下载模型，二次调用命中缓存
- 空闲 10 分钟自动卸载模型
- 内存不足自动降级
- 并发请求正常排队
```

### 依赖
- M3 完成

---

## M5 - 多模型扩展 ✅ 已完成

**目标**：验证架构可扩展性，接入多个 Provider。

### 交付内容
- [x] MiniCPM-V Provider（`src/providers/minicpm/provider.ts`，模型仓库 `bartowski/MiniCPM-V-2_6-GGUF`）
- [x] SmolVLM2-500M-Video Provider（`src/providers/smolvlm2/provider.ts`，快速候选）
- [x] GGUF RuntimeAdapter（共享 `LlamaServerProcess`，llama.cpp 后端）
- [x] `quality=high` 模式（`VISION_HIGH_QUALITY=1` 注册 MiniCPMProvider；路由器选择大模型）
- [x] Provider 能力匹配（`supportedSkills` / `supportedRuntimes` / `requirements`）
- [x] `ProviderRouter`（`src/core/provider-router.ts`，根据 quality / 资源 / skill 候选筛选）
- [x] 基准测试脚本（`scripts/benchmark.ts`，对比 3 个 provider 的准确率/延迟/内存）

### 验收标准
```
quality=high + 资源充足 → 路由器自动切换到 MiniCPM-V → 结果质量提升
quality=fast 或 资源不足 → 路由器筛选掉大模型 → 回退 GGUF/SmolVLM2
```

### 实际 provider 列表
| Provider | 模型 | 角色 | 启用方式 |
|----------|------|------|----------|
| `smolvlm2` | SmolVLM2-500M-Video-Instruct-Q4_K_M | 默认/快速候选 | 默认或 `VISION_PROVIDER=smolvlm2` |
| `gguf` | SmolVLM-500M-Instruct-Q8_0 | fast legacy candidate | `VISION_PROVIDER=gguf` |
| `minicpm` | MiniCPM-V-2_6-Q4_K_M | 高质量 | `VISION_HIGH_QUALITY=1` + `quality=high` |
| `ppu-paddle-ocr` | PaddleOCR native model | OCR-only | 默认注册（`VISION_OCR_PROVIDER` 默认 `ppu-paddle-ocr`；置 `none` 关闭） |
| `onnx` | SmolVLM Transformers.js | 遗留 | `VISION_PROVIDER=onnx` |

### 依赖
- M4 完成

---

## M6 - 发布准备（npm / GitHub）✅ 已完成基础发布准备

**目标**：完成开源发布准备。

### 交付内容
- [x] 完整文档（Docs/ 已同步 M5 + v0.2 OCR/key-content 实现状态）
- [x] 使用示例（`examples/`：basic-analysis, high-quality, ocr-only, classify-only, ocr-provider）
- [x] README + README.zh-CN + 安装指南 + 配置指南
- [x] CI/CD（`.github/workflows/ci.yml`：lint + typecheck + build + `pnpm test:unit`）
- [ ] 性能基准报告（脚本已就绪：`scripts/benchmark.ts`；待 MiniCPM-V 模型下载完成后跑全量对比）
- [x] License（MIT）
- [x] GitHub push（`main` 已推送到 `git@github.com:jiyi1990118/vision-foundation-mcp.git`）
- [ ] 发布到 npm（`package.json` 已配置 `files` / `engines` / `publishConfig`；当前等待 `npm login`）
- [x] 移除未使用的 `node-llama-cpp` 依赖（GGUF provider 使用 llama-server 子进程，不使用 native binding）

### 验收标准
```
新用户按 README 5 分钟内跑通第一个 vision.analyze 调用
```

### 依赖
- M5 完成

---

## M7 - OCR-driven 结构化理解（v0.2）✅ 已完成

**目标**：提升中文后台/需求截图、多色标注、密集表格的结构化理解可靠性。

### 交付内容
- [x] `ppu-paddle-ocr` OCR-only Provider（`src/providers/ppu-paddle-ocr/provider.ts`）
- [x] ProviderRouter OCR-only exact skill fit + mixed OCR Provider override
- [x] `options.target` 输入契约，用于红框/指定区域提取
- [x] 多色标注检测（red/blue/green/yellow/magenta，实线/虚线框、噪声过滤、框内文本收集；M7 初版仅红色，后泛化为 5 色）
- [x] Key-content extractor（目标区域解析、局部裁剪 OCR、表格重建、单位合并、金额符号归一化）
- [x] OCR-driven UI composer（`ocrText`、`result.ui`、`result.layout`、分类修正）
- [x] 测试覆盖：annotation detector、key-content extractor、ppu-paddle-ocr provider、routing、planner、composer

### 验收标准
```
给定带（多色）标注框的中文后台截图：
  → OCR 识别全图文本
  → 检测标注框坐标（red/blue/green/yellow/magenta）
  → 提取框内表格列名和每行金额
  → 不泄漏邻近框外表头
  → structuredContent.result.targetExtraction.table 可直接被 LLM 消费
```

### 实测样例
TAPD/POS 后台截图标注区域输出：

| 默认基础价-半份（元） | 默认附加价-半份（元） |
|---|---|
| 0.00 ¥ | 0.00 ¥ |
| 0.00 ¥ | 0.00 ¥ |
| 0.00 ¥ | 0.00 ¥ |
| 0.00 ¥ | 0.00 ¥ |
| 0.00 ¥ | 0.00 ¥ |
| 0.00 ¥ | 0.00 ¥ |

---

## M8 - Universal Vision Parser（v0.3）✅ 已完成

**目标**：在 Skill 结果之上构建跨场景的统一结构化解析层 `result.parse`，补强小模型推理，泛化标注与关键内容提取。

> 这是此前路线图未覆盖的最大一块工作。它不是新增 Skill，而是在 Composer 内通过算法 + VLM reasoning 生成统一的 `UniversalParse`。

### 交付内容
- [x] `result.parse`（`buildUniversalParse`，`src/core/universal-parser.ts`）：统一输出 `scene / quality / layout / ocr.corrected / entities / relationships / logic / summary / insights / risks / next_actions / confidence`
- [x] 场景分类法（`src/core/scene-taxonomy.ts`）：14 类场景 `document / requirement / ui / prototype / photo / code / table / chart / flowchart / mindmap / ppt / chat / error / other`，支持 classify/scene-hint/关键词多重信号融合
- [x] 场景抽取器（`src/core/extractors/`）：`chart` / `diagram` / `document` / `code` / `form` + `scenario-dispatcher` 按场景提取专属结构
- [x] VLM reasoning pass（`runReasoning`，temp=0、256 tokens、无上下文时跳过、模板兜底）：补强小模型推理与洞察
- [x] 多色标注检测泛化（red/blue/green/yellow/magenta，5 色）
- [x] key-content 提取泛化（从红框价格表扩展到通用目标区域解析）
- [x] 后分类启发式修正（`CATEGORY_EXCLUSION_RULES` + `inferCategoryFromSummary` + 媒介优先原则）
- [x] 测试覆盖：`tests/universal-parser.test.ts`、`tests/compose-result-heuristic.test.ts`

### 验收标准
```
给定任意图片：
  -> Skill 结果（classify/ocr/summary/...）+ OCR 证据
  -> scene 识别（14 类之一）
  -> 场景专属抽取（如 chart->数据系列、diagram->节点边、form->字段）
  -> VLM reasoning 补充 insights/risks/next_actions
  -> structuredContent.result.parse 可直接被 LLM 消费
```

### 依赖
- M7 完成

---

## 阶段与文档对应关系

| 里程碑 | 主要参考文档 |
|--------|-------------|
| M1 | 系统架构、目录结构 |
| M2 | Execution Planner、Policy Engine、Skill Engine、分层规则 |
| M3 | Skill Engine（质量保障部分）、API 契约 |
| M4 | 模型管理、Provider/Runtime、编码规范、测试指南 |
| M5 | Provider/Runtime（扩展部分） |
| M6 | README、API 契约、测试指南、发布配置 |
| M7 | OCR Provider、Request Lifecycle、Skill Engine、Provider/Runtime、key-content specs/plans |
| M8 | Skill Engine（§6.3 Result Composer / UniversalParse）、Universal Parser、scene taxonomy |

---

## 未来路线（v1.0 之后）

```
v1.x  更多 Skill（icon识别、wireframe、design-system）
v1.x  OCR/key-content 支持更复杂表格结构（多色标注泛化已完成，见 M7/M8）
v2.0  Video 视频理解
v3.0  Multi-Agent 多模型协作（复杂任务拆分给不同模型）
v4.0  插件市场（第三方 Skill/Provider 分发）
```

这些不在当前 V1 范围，但架构已预留扩展点：
- Skill 插件化 → 新增能力不改引擎
- Provider 插件化 → 新增模型不改引擎
- Runtime 插件化 → 新增引擎不改引擎

---

## 开发优先级原则

当资源有限时，按以下优先级取舍：

```
1. 跑通 > 完整    （先能跑，再补全）
2. 正确 > 性能    （先准确，再优化）
3. 核心 > 边缘    （先 Planner/Skill/Provider，再 Cache/Lifecycle 细节）
4. 本地 > 云端    （先 SmolVLM，再大模型）
5. 稳定 > 功能    （先保证已有能力稳定，再加新 Skill）
```

---

## 本文小结

路线图核心：
1. **8 个里程碑**，从 Walking Skeleton 到 Universal Vision Parser（M1-M8 全部完成）
2. **渐进增强**，每个里程碑都是可交付的增量
3. **M1 先跑通**，不追求架构完整
4. **M3 是质量关键**，三层保障解决小模型不稳定（内联实现，非独立模块）
5. **M5 验证扩展性**，接入第二模型证明架构可插拔
6. **M7/M8 结构化理解**，OCR-driven 富化 + 跨场景统一解析层
7. **未来预留**，Video/Multi-Agent 在 v2+，架构已预留

---

## 设计偏移总结（2026-07-30 审计）

以下设计文档描述的功能未实现或实现方式与设计不同。这些均为**愿景文档**，
描述了理想架构，实际实现采用了更务实的方案。

### 未实现的愿景模块

| 设计文档 | 愿景 | 实际状态 |
|---|---|---|
| `12-cache.md` | CacheManager (LRU+TTL, 512MB, 磁盘缓存) | 未实现，`options.cache` 为 no-op |
| `08-lifecycle-manager.md` | 独立 LifecycleManager 类 (6状态机, minDwellTime, warmup, backoff) | 生命周期内联在 BaseLlamaCppProvider (引用计数+空闲定时器) |
| `09-prompt-schema-registry.md` | 独立 prompts/ + schemas/ 目录, _shared/ 模板, few-shot.json, 版本管理, A/B 测试 | prompts/schemas 内联在 skill 目录中, 由 registry.ts 加载 |
| `04-policy-engine.md` | policy.yaml 配置化, 6 条策略, 热加载 | 3 条规则硬编码在 DEFAULT_RULES, 无 YAML |
| `10-error-handling.md` | VisionError 类层次结构 (8 子类, 18 错误码) | classifyVisionError() 函数 + 字符串匹配, 7 个错误码 |
| `06-provider-runtime.md` | RuntimeAdapter 接口 | GGUF provider 直接使用 BaseLlamaCppProvider |
| `11-security.md` | sanitizeFocus() 防 prompt 注入 | 未实现 |
| `07-model-management.md` | config/providers.yaml, 并发分块下载, 版本管理 | URL 硬编码, 单流下载, 无版本管理 |

### 实现方式与设计不同的模块

| 设计文档 | 设计 | 实际实现 | 原因 |
|---|---|---|---|
| ResponseValidator | 独立模块 | 内联在 SkillPipeline.parseAndValidate() | 功能完整, 无需拆分 |
| PromptRegistry | 独立类 + prompts/ 目录 | skill 目录内联 + registry.ts | 更简单, 无需模板继承 |
| SchemaRegistry | 独立类 | skill 目录内联 | 同上 |
| PolicyEngine | YAML 配置化 | 硬编码 DEFAULT_RULES | 3 条规则足够, YAML 过度设计 |
| LifecycleManager | 独立类 + 6 状态机 | BaseLlamaCppProvider 内联 | 引用计数+空闲定时器已满足需求 |
| Error handling | VisionError 类层次 | classifyVisionError() 函数 | 函数式更轻量, 无需类层次 |

### 实现中有但设计文档未覆盖的模块

| 模块 | 源文件 | 说明 |
|---|---|---|
| UI 分析管线 | `src/ui-analysis/` (24 子目录) | 完整的 UI 重建流水线, 设计文档中未描述 |
| 标注工作台 | `src/ui-analysis/annotation-workbench/` | 人工标注审核 UI, 设计文档中未描述 |
| 场景抽取器 | `src/core/extractors/` | chart/diagram/document/code/form 场景专属抽取 |
| 设计元素提取器 | `src/core/extractors/design-extractor.ts` | DesignBlock/DesignToken 类型 |
| UI 布局提取器 | `src/core/extractors/ui-layout-extractor.ts` | UiLayoutBlock 类型 |
| 分类启发式修正 | `src/core/skill-pipeline.ts` | CATEGORY_EXCLUSION_RULES + inferCategoryFromSummary |
| 数据集导出 | `src/ui-analysis/benchmark/dataset-export.ts` | SHA-256 manifest + 家族分拆 |
| 主动学习 | `src/ui-analysis/benchmark/active-learning.ts` | 频率优先队列 |
