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
- 默认使用 SmolVLM2，兼顾本地推理质量和资源占用；可切换 SmolVLM fast 模式，也可启用 MiniCPM-V high-quality 模式。
- 首次运行可自动准备 `llama-server` 与模型文件。
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
| `image` | 是 | 图片来源。支持本地文件路径、base64、data URI、HTTP(S) URL。 |
| `intent` | 否 | 自然语言意图，如 `describe`、`ocr`、`table`、`document`、`auto`。默认 `auto`。 |
| `skills` | 否 | 显式指定要执行的 Skill，会覆盖 intent 推断。例如 `["classify", "summary", "ocr"]`。 |
| `options.quality` | 否 | `fast` 使用默认 provider；`high` 在设置 `VISION_HIGH_QUALITY=1` 后可路由到 MiniCPM-V。 |
| `options.provider` | 否 | 可选 provider 覆盖，具体名称取决于当前注册的 provider。 |
| `options.cache` | 否 | 预留给支持缓存的 provider。 |
| `options.maxTokens` | 否 | 可选生成 token 限制，会沿请求链路传递。 |
| `options.target` | 否 | 可选目标区域提示，用于带标注截图，例如 `{ "color": "red", "position": "right", "description": "虚线框内容" }`。 |

### 结构化输出

`vision.analyze` 返回人类可读文本，同时返回 MCP `structuredContent`：

```ts
{
  category: string;
  confidence: number;
  summary: string;
  skills: string[];
  result: Record<string, unknown>;
  metadata: {
    provider: string;
    runtime: string;
    duration: number;
    cached: boolean;
  };
}
```

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
| PPU PaddleOCR | `VISION_OCR_PROVIDER=ppu-paddle-ocr` + `skills: ["ocr"]` | native OCR | 可选专用 OCR-only provider |
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

### 可选专用 OCR Provider

设置 `VISION_OCR_PROVIDER=ppu-paddle-ocr` 后，服务会注册一个基于 PaddleOCR 的专用 OCR Provider：

```bash
VISION_OCR_PROVIDER=ppu-paddle-ocr vision-foundation-mcp
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
| `VISION_OCR_PROVIDER` | 未设置 | 设为 `ppu-paddle-ocr` 后注册可选 OCR-only provider。 |
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
