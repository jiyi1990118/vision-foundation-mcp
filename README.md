# Vision Foundation MCP

[![GitHub](https://img.shields.io/badge/GitHub-vision--foundation--mcp-blue?logo=github)](https://github.com/jiyi1990118/vision-foundation-mcp)
[![npm](https://img.shields.io/badge/npm-@npm__xiyuan%2Fvision--foundation--mcp-red?logo=npm)](https://www.npmjs.com/package/@npm_xiyuan/vision-foundation-mcp)
[![MCP](https://img.shields.io/badge/MCP-stdio-green)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-black)](./LICENSE)

Local vision-understanding MCP server for Claude Desktop, Cursor, opencode, and other MCP clients. It exposes one stdio MCP tool, `vision.analyze`, powered by local SmolVLM / SmolVLM2 / MiniCPM-V models through `llama.cpp`.

English | [简体中文](./README.zh-CN.md)

## Contents

- [What It Does](#what-it-does)
- [Quick Start](#quick-start)
- [MCP Tool Contract](#mcp-tool-contract)
- [Client Configuration](#client-configuration)
- [Usage Examples](#usage-examples)
- [Models And Providers](#models-and-providers)
- [Runtime Requirements](#runtime-requirements)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Release Readiness](#release-readiness)
- [Security And Privacy](#security-and-privacy)
- [License](#license)

## What It Does

- Runs image understanding locally without sending images to a cloud vision API.
- Supports local file paths, base64 strings, data URIs, and HTTP(S) image URLs.
- Provides 8 data-driven skills: `classify`, `summary`, `ocr`, `table`, `document`, `poster`, `moderation`, and `layout`.
- Uses SmolVLM2 by default for balanced local quality; optional SmolVLM fast mode and MiniCPM-V high-quality mode are available.
- Auto-prepares `llama-server` and model files on first use when possible.
- Keeps MCP stdio clean: JSON-RPC stays on stdout, logs go to stderr.

## Quick Start

Use it directly with `npx` from an MCP client:

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

Or install it in a project:

```bash
npm install @npm_xiyuan/vision-foundation-mcp
```

```bash
pnpm add @npm_xiyuan/vision-foundation-mcp
```

First run may download:

- `llama-server` from `ggml-org/llama.cpp` releases.
- SmolVLM2 GGUF model files from Hugging Face or `HF_ENDPOINT`.

## MCP Tool Contract

This server intentionally exposes a single MCP tool. The internal skill router decides which vision skills to run based on `intent`, `skills`, and `options`.

### Tool

```text
vision.analyze
```

### Input Schema

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

### Input Fields

| Field | Required | Description |
|------|----------|-------------|
| `image` | yes | Image source. Supports local file path, base64, data URI, or HTTP(S) URL. |
| `intent` | no | Natural-language intent, such as `describe`, `ocr`, `table`, `document`, or `auto`. Defaults to `auto`. |
| `skills` | no | Explicit skills to run. Overrides intent inference. Example: `["classify", "summary", "ocr"]`. |
| `options.quality` | no | `fast` uses the default provider. `high` can route to MiniCPM-V when `VISION_HIGH_QUALITY=1` is set. |
| `options.provider` | no | Optional provider override. Supported provider names depend on registered providers. |
| `options.cache` | no | Reserved for cache-aware providers. |
| `options.maxTokens` | no | Optional generation token limit passed through the request pipeline. |
| `options.target` | no | Optional target-region hint for annotated screenshots, such as `{ "color": "red", "position": "right", "description": "dashed box content" }`. |

### Structured Output

`vision.analyze` returns human-readable text plus MCP `structuredContent`:

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

### Example Tool Call

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

### Skill Routing

| Intent | Skills |
|------|--------|
| `auto` | `classify`, `summary` |
| `describe`, `analyze` | `classify`, `summary` |
| `text`, `ocr`, `extract` | `ocr` |
| `table` | `table` |
| `document` | `document` |
| `poster` | `poster` |
| `safe`, `moderation` | `moderation` |
| `layout` | `layout` |
| `detail` | `classify`, `ocr`, `summary` |

## Client Configuration

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS:

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

Source checkout configuration:

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

Add this in Cursor Settings -> MCP:

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

Add this to `~/.config/opencode/opencode.json`:

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

If using a local checkout:

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

After editing MCP config, restart the client if it does not hot-reload MCP servers.

## Usage Examples

Ask your MCP client:

```text
Analyze this image: /Users/me/Desktop/chart.png
```

```text
Extract the text from this screenshot: /Users/me/Desktop/screenshot.png
```

```text
Use OCR and summary for this image: /Users/me/Desktop/page.png
```

For local script examples, build the project and run:

```bash
pnpm build
node examples/basic-analysis.mjs /path/to/image.png
node examples/ocr-only.mjs /path/to/screenshot.png
VISION_OCR_PROVIDER=ppu-paddle-ocr node examples/ocr-provider.mjs /path/to/screenshot.png
VISION_HIGH_QUALITY=1 node examples/high-quality.mjs /path/to/image.png
```

These examples are source-checkout examples; the npm package publishes the compiled server, not the `examples/` directory.

## Models And Providers

| Provider | Env | Runtime | Default Use |
|---------|-----|---------|-------------|
| SmolVLM2 | `VISION_PROVIDER=smolvlm2` | llama.cpp | Default, balanced local quality |
| SmolVLM | `VISION_PROVIDER=gguf` | llama.cpp | Faster 500M candidate |
| MiniCPM-V | `VISION_HIGH_QUALITY=1` + `options.quality="high"` | llama.cpp | Higher-quality mode, GPU recommended |
| PPU PaddleOCR | `VISION_OCR_PROVIDER=ppu-paddle-ocr` + `skills: ["ocr"]` | native OCR | Optional dedicated OCR-only provider |
| ONNX SmolVLM | `VISION_PROVIDER=onnx` | Transformers.js / ONNX Runtime | Legacy fallback |

Default model cache path:

```text
~/.vision-mcp/models
```

Default `llama-server` lookup order:

1. `LLAMA_SERVER_PATH`
2. `<package-root>/bin/llama-server`
3. `~/.vision-mcp/bin/llama-server`
4. `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`
5. `PATH`

### Optional Dedicated OCR Provider

Set `VISION_OCR_PROVIDER=ppu-paddle-ocr` to register a dedicated PaddleOCR-backed provider for OCR-only requests:

```bash
VISION_OCR_PROVIDER=ppu-paddle-ocr vision-foundation-mcp
```

Behavior:

- `skills: ["ocr"]` routes to `ppu-paddle-ocr` when available.
- Mixed visual understanding requests such as `classify + ocr + summary` stay on the active VLM provider.
- Models are cached by `ppu-paddle-ocr` under `~/.cache/ppu-paddle-ocr`.
- Table structure is not reconstructed; text boxes and lines are returned in reading/layout order when available.

## Runtime Requirements

- Node.js 18 or newer.
- macOS, Linux, or Windows, depending on available `llama.cpp` release binaries.
- Network access on first run to download `llama-server` and model files.
- Apple Silicon Metal or NVIDIA CUDA is recommended but not required for default local models.
- CPU execution is supported for default/fast providers, but latency depends on the host.

Manual setup from source:

```bash
git clone git@github.com:jiyi1990118/vision-foundation-mcp.git
cd vision-foundation-mcp
pnpm install
pnpm setup:llama
pnpm build
pnpm test:unit
```

## Environment Variables

| Variable | Default | Description |
|---------|---------|-------------|
| `VISION_PROVIDER` | `smolvlm2` | Default provider: `smolvlm2`, `gguf`, or `onnx`. |
| `VISION_HIGH_QUALITY` | unset | Set to `1` to register MiniCPM-V for `quality=high` requests. |
| `VISION_OCR_PROVIDER` | unset | Set to `ppu-paddle-ocr` to register the optional OCR-only provider. |
| `LLAMA_SERVER_PATH` | auto-detect | Existing `llama-server` path. Skips auto-download when set. |
| `LLAMA_DOWNLOAD_MIRROR` | unset | Optional GitHub release mirror for `llama-server` downloads. |
| `HF_ENDPOINT` | environment-dependent | Hugging Face endpoint. Use `https://hf-mirror.com` when needed. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug`. Logs are written to stderr. |

## Troubleshooting

| Problem | Fix |
|--------|-----|
| MCP client shows no tool | Restart the MCP client after changing config. Confirm the command works outside the client. |
| First request is slow | First run may download `llama-server` and GGUF models. Increase MCP timeout to 120 seconds or more. |
| `llama-server not found` | Run `pnpm setup:llama`, install `llama.cpp`, or set `LLAMA_SERVER_PATH`. |
| GitHub download is slow | Set `LLAMA_DOWNLOAD_MIRROR` or install `llama-server` manually. |
| Hugging Face download is slow | Set `HF_ENDPOINT=https://hf-mirror.com` or manually place model files under `~/.vision-mcp/models`. |
| `quality=high` does not use MiniCPM-V | Set `VISION_HIGH_QUALITY=1`, restart the MCP client, and ensure the host has enough memory/GPU resources. |
| stdio JSON-RPC errors | Do not write logs to stdout. This project writes logs to stderr through the logger. |

## Development

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test:unit
```

Useful commands:

```bash
pnpm dev
pnpm setup:llama
pnpm test
pnpm test:slow
npm pack --dry-run
```

`pnpm build` is required before running MCP integration checks because it also copies skill assets into `dist/skills`.

## Release Readiness

Before publishing to npm:

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build
npm pack --dry-run
```

Package entry points:

- npm package: `@npm_xiyuan/vision-foundation-mcp`
- binary: `vision-foundation-mcp`
- main/export: `dist/index.js`
- transport: MCP stdio
- tool: `vision.analyze`

## Security And Privacy

- Local files are read from the machine where the MCP server runs.
- Local inference does not require a cloud vision API.
- HTTP(S) URLs are fetched by the server process; only use trusted image URLs.
- Do not pass private images to untrusted MCP clients or remote hosts.
- Logs avoid stdout to preserve MCP JSON-RPC transport integrity.

## Related Links

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [llama.cpp](https://github.com/ggml-org/llama.cpp)
- [SmolVLM2 GGUF](https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF)
- [npm package](https://www.npmjs.com/package/@npm_xiyuan/vision-foundation-mcp)

## License

MIT
