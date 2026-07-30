# Vision Foundation MCP

[![GitHub](https://img.shields.io/badge/GitHub-vision--foundation--mcp-blue?logo=github)](https://github.com/jiyi1990118/vision-foundation-mcp)
[![npm](https://img.shields.io/badge/npm-@npm__xiyuan%2Fvision--foundation--mcp-red?logo=npm)](https://www.npmjs.com/package/@npm_xiyuan/vision-foundation-mcp)
[![MCP](https://img.shields.io/badge/MCP-stdio-green)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-black)](./LICENSE)

面向 Claude Desktop、Cursor、opencode 以及其他 MCP Client 的本地视觉理解 MCP 服务。项目通过 `llama.cpp` 在本地运行 SmolVLM / SmolVLM2 / MiniCPM-V，并对外暴露一个 stdio MCP Tool：`vision.analyze`。

[English](./README.md) | 简体中文

## 目录

- [项目能力](#项目能力)
- [快速开始](#快速开始)
- [MCP Tool 契约](#mcp-tool-契约)
- [MCP Client 配置](#mcp-client-配置)
- [使用示例](#使用示例)
- [模型与 Provider](#模型与-provider)
- [运行要求](#运行要求)
- [环境变量](#环境变量)
- [故障排查](#故障排查)
- [开发](#开发)
- [开源发布检查](#开源发布检查)
- [安全与隐私](#安全与隐私)
- [License](#license)

## 项目能力

- 本地图片理解，不依赖云端视觉 API。
- 支持本地文件路径、base64、data URI、HTTP(S) 图片 URL。
- 内置 8 个数据驱动 Skill：`classify`、`summary`、`ocr`、`table`、`document`、`poster`、`moderation`、`layout`。
- 通用视觉解析器：跨场景结构化输出，含场景检测、实体提取、VLM 推理（洞察/风险/下一步行动）。
- UI 截图重建：组件树、设计令牌、布局约束、Codegen/Figma/Markdown 导出。
- 标注截图目标提取：检测彩色标注框（红/蓝/绿/黄/品红），提取框内内容。
- 默认使用 SmolVLM2，兼顾本地推理质量和资源占用；可切换 SmolVLM fast 模式，也可启用 MiniCPM-V high-quality 模式。
- 首次运行可自动准备 `llama-server` 与模型文件。
- Provider 级推理缓存（TTL 1 小时，LRU 100 条），重复请求秒级返回。
- 遵守 MCP stdio 约束：stdout 只输出 JSON-RPC，日志写 stderr。

## 快速开始

在 MCP Client 中直接通过 `npx` 使用：

```json
{
  "mcpServers": {
    "vision": {
      "command": "npx",
      "args": ["-y", "@npm_xiyuan/vision-foundation-mcp"]
    }
  }
}
```

也可以安装到项目中：

```bash
npm install @npm_xiyuan/vision-foundation-mcp
```

```bash
pnpm add @npm_xiyuan/vision-foundation-mcp
```

首次运行可能会下载：

- 来自 `ggml-org/llama.cpp` release 的 `llama-server`。
- 来自 Hugging Face 或 `HF_ENDPOINT` 的 SmolVLM2 GGUF 模型文件。

## MCP Tool 契约

本服务刻意只暴露一个 MCP Tool。内部通过 intent、skills 和 options 做 Skill 路由，避免让 MCP Client 在多个相似视觉工具之间误选。

### Tool 名称

```text
vision.analyze
```

### 输入 Schema

```ts
{
  image: string;
  intent?: string;
  scene?: string;
  skills?: string[];
  options?: {
    quality?: "fast" | "high";
    provider?: string;
    cache?: boolean;
    maxTokens?: number;
    target?: {
      color?: string;
      position?: string;
      description?: string;
    };
  };
}
```

### 输入字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `image` | 是 | 图片来源。支持本地文件路径、base64、data URI、HTTP(S) URL。格式：PNG、JPEG、WebP、GIF、BMP。最大 10 MB。 |
| `intent` | 否 | 自然语言意图。示例：`auto`（默认）、`describe`、`extract text`、`analyze this UI`、`read this table`、`check safety`。关键词 "text"/"OCR" 触发 OCR；"table" 触发表格提取；"UI"/"screenshot" 触发 UI 布局。 |
| `scene` | 否 | 场景提示。有效值：`requirement`、`ui`、`prototype`、`code`、`chart`、`flowchart`、`mindmap`、`ppt`、`chat`、`document`、`photo`、`table`、`error`、`other`。仅作引导，不覆盖图片证据。 |
| `skills` | 否 | 显式指定 Skill，覆盖 intent 推断。可用：`classify`、`ocr`、`summary`、`table`、`document`、`poster`、`moderation`、`layout`。示例：`["classify", "summary", "ocr"]`。 |
| `options.quality` | 否 | `fast`（默认）使用轻量本地模型（~500M）。`high` 在 `VISION_HIGH_QUALITY=1` 且 GPU 内存充足时路由到更大模型（~2B）。 |
| `options.provider` | 否 | 覆盖 provider。有效值：`smolvlm2`（默认）、`gguf`（legacy）、`minicpm`（高质量）、`onnx`（已弃用）。不设置则自动路由。 |
| `options.cache` | 否 | 启用/禁用 provider 级推理缓存（TTL 1 小时，LRU 100 条）。默认启用。设为 `false` 强制重新推理。 |
| `options.maxTokens` | 否 | 每次 Skill 推理的最大 token 数。默认 256。需更长描述时增大（如 512）。 |
| `options.target` | 否 | 标注截图目标区域提示：`{ "color": "red", "position": "right", "description": "虚线框价格表" }`。 |
| `options.reconstruction_mode` | 否 | UI 分析深度：`fast`（CV+OCR，默认）、`balanced`（+UI 检测器）、`high_fidelity`（+OmniParser/图标描述）。 |
| `options.build_tree` | 否 | 为 UI 场景构建层次化 SemanticAST（scene=ui 时默认 true）。 |
| `options.export_codegen` | 否 | 从 UI AST 导出 CodegenIR。 |
| `options.export_figma` | 否 | 从 UI AST 导出 Figma REST-API 格式 JSON。 |
| `options.export_markdown` | 否 | 从 UI AST 导出人类可读 Markdown。 |
| `options.summary_only` | 否 | 将 UI 重建裁剪为仅根节点树+统计，控制大 UI 输出大小。 |
| `options.strict_mode` | 否 | 校验输出结构；缺失必填字段时直接失败而非静默降级。 |

### 结构化输出

`vision.analyze` 返回人类可读文本，同时返回 MCP `structuredContent`：

```ts
{
  category: string;
  confidence: number;
  summary: string;
  skills: string[];
  result: Record<string, unknown>; // 各 Skill 数据 + ui、layout、annotations、targetExtraction、parse
  metadata: {
    provider: string;
    runtime: string;
    duration: number;
    cached: boolean;
  };
  ocrText?: string; // 顶层拼接后的 OCR 文本
}
```

`result` 除了各 Skill 数据，还携带若干算法构建的字段：`ui` 与 `layout`（在 `composeResult` 中由 OCR 构建）、`annotations`（多色标注检测）、`targetExtraction`（关键内容提取）以及 `parse`（通用视觉解析器，见下文）。

### 通用视觉解析器（Universal Vision Parser）

`result.parse` 是通用视觉解析器的输出，由场景分类、OCR、场景提取器以及一次可选的聚焦 VLM 推理调用共同构建，为调用方提供跨多种图片类型的统一结构化视图。

```ts
{
  scene: { detected: SceneEntry[]; final: ParseScene; reason: string };
  quality: { clarity: number; ocr_confidence: number; issues: string[] };
  layout: Record<string, unknown>;
  ocr: { corrected: string };
  entities: { type: string; value: string; label?: string }[];
  relationships: { from: string; to: string; type?: string }[];
  logic: string[];
  summary: string;
  insights: string[];
  risks: string[];
  next_actions: string[];
  confidence: number;
}
```

- `scene` - 检测到的场景候选及最终场景，从 14 个取值中选择：`document`、`requirement`、`ui`、`prototype`、`photo`、`code`、`table`、`chart`、`flowchart`、`mindmap`、`ppt`、`chat`、`error`、`other`。
- `quality` - 清晰度、OCR 置信度及检测到的质量问题。
- `ocr.corrected` - 纠错后的 OCR 文本。
- `entities` / `relationships` / `logic` - 由 OCR 驱动的场景提取器（`chart`、`diagram`、`invoice`/`document`、`code`、`form`）产出的结构化元素。
- `insights` / `risks` / `next_actions` - 来自一次聚焦的 VLM 推理调用（`temp=0`、`maxTokens=256`）。当没有 OCR/摘要/提取上下文时跳过（节省约 3-5 秒）；失败或幻觉时回退到场景专属模板。

标注检测（`result.annotations`）支持 5 种颜色预设 - `red`、`blue`、`green`、`yellow`、`magenta` - 每个框携带 `insideText`、`insideTextLines` 和 `nearbyText`。当场景为 `requirement` 且存在标注框或目标查询时，会执行关键内容提取并写入 `result.targetExtraction`。

### 调用示例

```json
{
  "image": "/Users/me/Desktop/screenshot.png",
  "intent": "describe",
  "skills": ["classify", "summary", "ocr"],
  "options": {
    "quality": "fast"
  }
}
```

### Skill 参考

| Skill | 说明 | 输出字段 |
|-------|------|----------|
| `classify` | 媒介优先分类法：先区分照片/截图/插画，再识别主体。 | `category`, `confidence`, `subcategory`, `reasoning` |
| `ocr` | 提取全部可见文本为结构化文本框，含位置和置信度。支持中英文。检测彩色标注框。 | `texts`, `language` |
| `summary` | 生成详细自然语言描述。UI/需求截图保留页面结构。 | `description`, `tags` |
| `table` | 重建表格结构：行列数、表头、单元格数据。支持有框/无框表格。 | `rowCount`, `columnCount`, `headers`, `rows` |
| `document` | 识别文档类型（发票/收据/表单/信件/报告/文章/合同/证件）并提取关键信息。 | `description`, `documentType` |
| `poster` | 分析设计海报：主题、视觉风格、配色、字体、构图、嵌入文本。 | `description`, `theme` |
| `moderation` | 内容安全检查：暴力、色情、违禁品、政治敏感。低延迟（10s）。 | `description`, `safe` |
| `layout` | 分析视觉布局结构：网格、列、行、侧边栏、分区。 | `description`, `layoutType` |

### Skill 路由

| Intent | 执行 Skill |
|------|------------|
| `auto` | `classify`, `summary` |
| `describe`, `analyze` | `classify`, `summary` |
| `text`, `ocr`, `extract` | `ocr` |
| `table` | `table` |
| `document` | `document` |
| `poster` | `poster` |
| `safe`, `moderation` | `moderation` |
| `layout` | `layout` |
| `detail` | `classify`, `ocr`, `summary` |

## MCP Client 配置

### Claude Desktop

macOS 下编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "vision": {
      "command": "npx",
      "args": ["-y", "@npm_xiyuan/vision-foundation-mcp"]
    }
  }
}
```

源码运行方式：

```json
{
  "mcpServers": {
    "vision": {
      "command": "node",
      "args": ["/path/to/vision-foundation-mcp/dist/index.js"],
      "env": {
        "VISION_PROVIDER": "smolvlm2",
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

### Cursor

在 Cursor Settings -> MCP 中添加：

```json
{
  "mcpServers": {
    "vision": {
      "command": "npx",
      "args": ["-y", "@npm_xiyuan/vision-foundation-mcp"]
    }
  }
}
```

### opencode

在 `~/.config/opencode/opencode.json` 中添加：

```json
{
  "mcp": {
    "vision-foundation": {
      "type": "local",
      "command": ["npx", "-y", "@npm_xiyuan/vision-foundation-mcp"],
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

源码运行方式：

```json
{
  "mcp": {
    "vision-foundation": {
      "type": "local",
      "command": ["node", "/path/to/vision-foundation-mcp/dist/index.js"],
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

修改 MCP 配置后，如果 Client 不支持热加载，请重启 Client。

## 使用示例

在 MCP Client 中直接输入：

```text
分析这张图片：/Users/me/Desktop/chart.png
```

```text
提取这张截图里的文字：/Users/me/Desktop/screenshot.png
```

```text
对这张图片同时执行 OCR 和摘要：/Users/me/Desktop/page.png
```

本地脚本示例：

```bash
pnpm build
node examples/basic-analysis.mjs /path/to/image.png
node examples/ocr-only.mjs /path/to/screenshot.png
VISION_OCR_PROVIDER=ppu-paddle-ocr node examples/ocr-provider.mjs /path/to/screenshot.png
VISION_HIGH_QUALITY=1 node examples/high-quality.mjs /path/to/image.png
```

这些示例用于源码 checkout；npm 包发布的是编译后的 MCP server，不包含 `examples/` 目录。

## 模型与 Provider

| Provider | 环境变量 | Runtime | 用途 |
|---------|----------|---------|------|
| SmolVLM2 | `VISION_PROVIDER=smolvlm2` | llama.cpp | 默认，本地质量更均衡 |
| SmolVLM | `VISION_PROVIDER=gguf` | llama.cpp | 更快的 500M 候选 |
| MiniCPM-V | `VISION_HIGH_QUALITY=1` + `options.quality="high"` | llama.cpp | 高质量模式，建议 GPU |
| PPU PaddleOCR | `VISION_OCR_PROVIDER=ppu-paddle-ocr`（默认）+ `skills: ["ocr"]` | native OCR | 专用 OCR-only provider（默认注册；设为 `none` 可禁用） |
| ONNX SmolVLM | `VISION_PROVIDER=onnx` | Transformers.js / ONNX Runtime | 遗留 fallback |

默认模型缓存目录：

```text
~/.vision-mcp/models
```

默认 `llama-server` 查找顺序：

1. `LLAMA_SERVER_PATH`
2. `<package-root>/bin/llama-server`
3. `~/.vision-mcp/bin/llama-server`
4. `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`
5. `PATH`

### 专用 OCR Provider

PPU PaddleOCR provider **默认注册**。`VISION_OCR_PROVIDER` 默认为 `ppu-paddle-ocr`；设为 `none` 可禁用 OCR-only provider：

```bash
# 默认：注册 ppu-paddle-ocr
VISION_OCR_PROVIDER=ppu-paddle-ocr vision-foundation-mcp

# 禁用 OCR-only provider
VISION_OCR_PROVIDER=none vision-foundation-mcp
```

行为：

- `skills: ["ocr"]` 会优先路由到 `ppu-paddle-ocr`。
- `classify + ocr + summary` 这类截图理解请求仍然由 VLM Provider 处理。
- 模型默认缓存到 `~/.cache/ppu-paddle-ocr`。
- 表格结构不会自动还原；会尽量返回文本框、行文本和位置信息。

## 运行要求

- Node.js 18 或更高版本。
- macOS、Linux 或 Windows，取决于 `llama.cpp` release 是否提供对应平台二进制。
- 首次运行需要网络访问，用于下载 `llama-server` 和模型文件。
- 推荐 Apple Silicon Metal 或 NVIDIA CUDA，但默认模型不强制要求 GPU。
- CPU 可以运行 default/fast provider，但速度取决于机器配置。

源码安装：

```bash
git clone git@github.com:jiyi1990118/vision-foundation-mcp.git
cd vision-foundation-mcp
pnpm install
pnpm setup:llama
pnpm build
pnpm test:unit
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VISION_PROVIDER` | `smolvlm2` | 默认 provider：`smolvlm2`、`gguf` 或 `onnx`。 |
| `VISION_HIGH_QUALITY` | 未设置 | 设为 `1` 后注册 MiniCPM-V，用于 `quality=high` 请求。 |
| `VISION_OCR_PROVIDER` | `ppu-paddle-ocr` | 默认为 `ppu-paddle-ocr`（默认注册）。设为 `none` 可禁用 OCR-only provider。 |
| `LLAMA_SERVER_PATH` | 自动检测 | 已安装的 `llama-server` 路径；设置后跳过自动下载。 |
| `LLAMA_DOWNLOAD_MIRROR` | 未设置 | 可选 GitHub release 镜像，用于下载 `llama-server`。 |
| `HF_ENDPOINT` | 取决于环境 | Hugging Face endpoint；需要时可设为 `https://hf-mirror.com`。 |
| `LOG_LEVEL` | `info` | `error`、`warn`、`info` 或 `debug`。日志写 stderr。 |

## 故障排查

| 问题 | 处理方式 |
|------|----------|
| MCP Client 看不到工具 | 修改配置后重启 MCP Client，并确认命令在终端可直接运行。 |
| 首次请求很慢 | 首次运行可能下载 `llama-server` 和 GGUF 模型；建议把 MCP timeout 设为 120 秒以上。 |
| `llama-server not found` | 运行 `pnpm setup:llama`，安装 `llama.cpp`，或设置 `LLAMA_SERVER_PATH`。 |
| GitHub 下载慢 | 设置 `LLAMA_DOWNLOAD_MIRROR`，或手动安装 `llama-server`。 |
| Hugging Face 下载慢 | 设置 `HF_ENDPOINT=https://hf-mirror.com`，或手动把模型放到 `~/.vision-mcp/models`。 |
| `quality=high` 没有使用 MiniCPM-V | 设置 `VISION_HIGH_QUALITY=1`，重启 MCP Client，并确认机器内存/GPU 资源足够。 |
| stdio JSON-RPC 报错 | 不要向 stdout 打日志。本项目通过 logger 将日志写到 stderr。 |

## 开发

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test:unit
```

常用命令：

```bash
pnpm dev
pnpm setup:llama
pnpm test
pnpm test:slow
npm pack --dry-run
```

`pnpm build` 不能替换成裸 `tsc`，因为它还会把 Skill 资源复制到 `dist/skills`。

## 开源发布检查

发布 npm 前建议执行：

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build
npm pack --dry-run
```

包入口信息：

- npm 包名：`@npm_xiyuan/vision-foundation-mcp`
- binary：`vision-foundation-mcp`
- main/export：`dist/index.js`
- transport：MCP stdio
- tool：`vision.analyze`

## 安全与隐私

- 本地文件由 MCP server 所在机器读取。
- 本地推理不需要云端视觉 API。
- HTTP(S) URL 由 server 进程拉取；请只使用可信图片 URL。
- 不要把私密图片交给不可信 MCP Client 或远程主机。
- 日志不写 stdout，避免破坏 MCP JSON-RPC transport。

## 相关链接

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [llama.cpp](https://github.com/ggml-org/llama.cpp)
- [SmolVLM2 GGUF](https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF)
- [npm package](https://www.npmjs.com/package/@npm_xiyuan/vision-foundation-mcp)

## License

MIT
