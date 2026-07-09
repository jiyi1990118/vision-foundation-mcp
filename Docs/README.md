# Vision Foundation MCP — 设计文档总索引

> 本目录是 Vision Foundation MCP 的完整设计文档体系。
> 文档按「总览 → 架构 → 契约 → 开发规范 → 决策记录 → 路线图」分层组织。

> ⚠️ **实现状态说明**：本目录为早期设计文档，部分内容（如 `smolvlm`/`qwen2.5-vl` provider 名、ONNX 优先、`ports.json`）已过时。
> 当前实现的权威文档是 **[`/AGENTS.md`](../AGENTS.md)** 和 **[`/README.md`](../README.md)**。
> 实际 provider 列表：`smolvlm2`（默认）/ `gguf` / `minicpm` / `onnx`（遗留）/ `ppu-paddle-ocr`（可选 OCR-only）。GGUF-backed provider 基于 llama.cpp，`ppu-paddle-ocr` 基于 native OCR。
> M5 多模型扩展和 v0.2 OCR-driven key-content extraction 已完成，详见 [`05-roadmap/01-roadmap.md`](./05-roadmap/01-roadmap.md)。

---

## 文档结构

```
Docs/
├── 00-overview/          总览（项目定位、设计原则）
├── 01-architecture/      架构设计（7 份核心架构文档）
├── 02-contracts/         契约（领域模型、API、分层规则）
├── 03-development/       开发规范（编码、目录、测试）
├── 04-decisions/         架构决策记录（ADR）
└── 05-roadmap/           路线图
```

---

## 阅读顺序

### 第一次了解项目（按序阅读）
1. [00-overview/01-project-overview.md](./00-overview/01-project-overview.md) — 项目是什么、做什么、不做什么
2. [00-overview/02-design-principles.md](./00-overview/02-design-principles.md) — 8 条设计原则
3. [01-architecture/01-system-architecture.md](./01-architecture/01-system-architecture.md) — 系统分层总览
4. [01-architecture/02-request-lifecycle.md](./01-architecture/02-request-lifecycle.md) — 一次请求的完整流程
5. [05-roadmap/01-roadmap.md](./05-roadmap/01-roadmap.md) — 开发里程碑

### 开发某个模块
- 开发前必读：[02-contracts/01-domain-model.md](./02-contracts/01-domain-model.md)（术语表）+ [02-contracts/03-layer-rules.md](./02-contracts/03-layer-rules.md)（分层规则）
- 对应架构文档：见下表

### AI 协同开发
- 必读：00-overview + 02-contracts/01-domain-model + 02-contracts/03-layer-rules + 03-development
- 按模块读对应架构文档

---

## 完整文档清单

### 00-overview（总览）
| 文档 | 内容 |
|------|------|
| [01-project-overview.md](./00-overview/01-project-overview.md) | 项目定位、边界、SmolVLM 定位、设计理念 |
| [02-design-principles.md](./00-overview/02-design-principles.md) | 8 条设计原则 + 冲突优先级 + 自检清单 |

### 01-architecture（架构设计）
| 文档 | 内容 |
|------|------|
| [01-system-architecture.md](./01-architecture/01-system-architecture.md) | 7 层架构总览、依赖关系、扩展点 |
| [02-request-lifecycle.md](./01-architecture/02-request-lifecycle.md) | 11 阶段请求生命周期、异常路径、时序图 |
| [03-execution-planner.md](./01-architecture/03-execution-planner.md) | 5 维决策、Skill/Provider 选择、缓存键 |
| [04-policy-engine.md](./01-architecture/04-policy-engine.md) | 配置化策略、匹配流程、内置策略示例 |
| [05-skill-engine.md](./01-architecture/05-skill-engine.md) | Skill 生命周期、Pipeline 编排、三层质量保障 |
| [06-provider-runtime.md](./01-architecture/06-provider-runtime.md) | Provider/Runtime 分离、Lifecycle 管理 |
| [07-model-management.md](./01-architecture/07-model-management.md) | 模型下载/校验/缓存/版本管理 |
| [08-lifecycle-manager.md](./01-architecture/08-lifecycle-manager.md) | SmolVLM 资源自动释放：6 状态机、三触发器、防抖动、泄漏检测 |
| [09-prompt-schema-registry.md](./01-architecture/09-prompt-schema-registry.md) | Prompt/Schema 注册表：模板编译、Few-shot、版本管理、Schema 校验修复 |
| [10-error-handling.md](./01-architecture/10-error-handling.md) | 统一错误码、分层捕获、重试策略、部分成功 |
| [11-security.md](./01-architecture/11-security.md) | 图片安全、SSRF 防护、防 DoS/OOM、隐私保护、Prompt 注入防护 |
| [12-cache.md](./01-architecture/12-cache.md) | 推理结果缓存：LRU+TTL、缓存键设计、一致性 |

### 02-contracts（契约）
| 文档 | 内容 |
|------|------|
| [01-domain-model.md](./02-contracts/01-domain-model.md) | 术语表、核心实体、命名规则、禁止同义词 |
| [02-api-contract.md](./02-contracts/02-api-contract.md) | vision.analyze 请求/响应契约、错误码、版本管理 |
| [03-layer-rules.md](./02-contracts/03-layer-rules.md) | 依赖矩阵、黑白名单、违规示例 |

### 03-development（开发规范）
| 文档 | 内容 |
|------|------|
| [01-coding-standard.md](./03-development/01-coding-standard.md) | TS 规范、命名、错误处理、日志、异步 |
| [02-folder-structure.md](./03-development/02-folder-structure.md) | 目录树、文件放置规则、新增模块流程 |
| [03-testing-guide.md](./03-development/03-testing-guide.md) | 测试金字塔、Mock 策略、覆盖率要求 |

### 04-decisions（架构决策记录）
| 文档 | 决策 |
|------|------|
| [ADR-001-single-tool.md](./04-decisions/ADR-001-single-tool.md) | 为什么只有一个 Tool |
| [ADR-002-skill-not-tool.md](./04-decisions/ADR-002-skill-not-tool.md) | 为什么 Skill 不是 Tool |
| [ADR-003-policy-engine.md](./04-decisions/ADR-003-policy-engine.md) | 为什么需要 Policy Engine |
| [ADR-004-provider-runtime-split.md](./04-decisions/ADR-004-provider-runtime-split.md) | 为什么 Provider 不直接调 Runtime |
| [ADR-005-lifecycle-strategy.md](./04-decisions/ADR-005-lifecycle-strategy.md) | 模型资源释放策略（空闲超时/内存压力/引用计数） |

### 05-roadmap（路线图）
| 文档 | 内容 |
|------|------|
| [01-roadmap.md](./05-roadmap/01-roadmap.md) | M1-M6 里程碑、交付内容、验收标准 |

### superpowers（实施计划与规格）
| 文档 | 内容 |
|------|------|
| [specs/2026-07-09-key-content-extraction-design.md](./superpowers/specs/2026-07-09-key-content-extraction-design.md) | 红框/目标区域关键内容提取设计 |
| [plans/2026-07-08-ppu-paddle-ocr-integration.md](./superpowers/plans/2026-07-08-ppu-paddle-ocr-integration.md) | `ppu-paddle-ocr` 专用 OCR Provider 集成计划 |
| [plans/2026-07-09-key-content-extraction.md](./superpowers/plans/2026-07-09-key-content-extraction.md) | OCR-driven key-content extraction 实施计划 |

---

## 核心架构速览

```
┌──────────────────────────────────────────────────┐
│  MCP Client (Claude / Cursor / ChatGPT / Codex)  │
└───────────────────────┬──────────────────────────┘
                        │ vision.analyze(image, intent)
                        ▼
  L0  Tool          ─── 唯一入口
  L1  Request       ─── 归一化 + 元数据
  L2  Decision      ─── Planner（建议）+ Policy（强制）
  L3  Skill         ─── Pipeline + Prompt/Schema Registry + Validator + Composer
  L4  Provider      ─── 模型/能力抽象（smolvlm2 / gguf / minicpm / ppu-paddle-ocr）
  L5  Runtime       ─── 引擎抽象（llama-cpp / onnx / native-ocr）
  L6  Infrastructure─── 模型管理 + 生命周期 + 缓存
```

当前 `vision.analyze` 结果还会在 OCR 成功且请求涉及目标区域/红框时执行 annotation detection 和 key-content extraction，将红框中的文本、表格结构和 `targetExtraction` 写入 `structuredContent.result`。

**三轴扩展**：Skill（能力）/ Provider（模型）/ Runtime（引擎）皆可插件化，新增不改核心引擎。

---

## 文档约定

- 所有文档使用 GitHub-flavored Markdown
- 架构图使用 ASCII / Mermaid
- 术语必须遵守 [领域模型术语表](./02-contracts/01-domain-model.md)
- 新增架构决策 → 在 04-decisions/ 新增 ADR
- 文档变更需保持相互引用一致
