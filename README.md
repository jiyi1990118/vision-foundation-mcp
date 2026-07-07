# Vision Foundation MCP

[![GitHub](https://img.shields.io/badge/GitHub-vision--foundation--mcp-blue?logo=github)](https://github.com/jiyi1990118/vision-foundation-mcp)
[![npm](https://img.shields.io/badge/npm-@npm__xiyuan%2Fvision--foundation--mcp-red?logo=npm)](https://www.npmjs.com/package/@npm_xiyuan/vision-foundation-mcp)

本地视觉理解 MCP 服务，基于 SmolVLM / SmolVLM2 / MiniCPM-V + llama.cpp，为 Claude / Cursor / ChatGPT 等 MCP Client 提供图片分析能力。

## 📑 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [安装](#安装)
  - [方式一：npm安装（推荐）](#方式一npm安装推荐)
  - [方式二：从源码安装](#方式二从源码安装)
- [配置 MCP Client](#配置-mcp-client)
- [使用](#使用)
- [环境变量](#环境变量)
- [架构](#架构)
- [开发](#开发)
- [性能指标](#性能指标)
- [License](#license)

## ✨ 特性

- **🚀 零配置启动**：llama-server 首次运行时自动下载安装，无需手动配置
- **🔒 本地推理**：SmolVLM-500M / SmolVLM2-500M GGUF，无需云端 API，保护隐私
- **⚡ GPU 加速**：自动检测 Metal (Apple Silicon) / CUDA (NVIDIA) / CPU
- **🎯 多能力**：分类 / OCR / 描述 / 表格 / 文档 / 海报 / 审核 / 布局（8 个 Skill）
- **🧠 智能路由**：意图自动映射到 Skill 组（describe → classify + summary）
- **🎨 多模型可选**：默认 SmolVLM2（better quality），可切 SmolVLM（fast），`VISION_HIGH_QUALITY=1` 启用 MiniCPM-V 2.6（high）
- **⚡ 高性能**：单次推理 ~300ms（Metal GPU），结果缓存秒返回
- **📊 资源管理**：空闲超时卸载、引用计数、内存压力监控、崩溃自动恢复

## 🚀 快速开始

### 最简安装（npm）

```bash
npm install @npm_xiyuan/vision-foundation-mcp
```

或使用 pnpm：

```bash
pnpm add @npm_xiyuan/vision-foundation-mcp
```

### 快速配置（Claude Desktop）

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "vision": {
      "command": "npx",
      "args": ["@npm_xiyuan/vision-foundation-mcp"]
    }
  }
}
```

首次运行时会自动：
- ✅ 下载并安装 llama-server
- ✅ 下载 SmolVLM2 模型文件
- ✅ 配置运行时环境

**立即可用，无需任何手动配置！** 🎉

## 📦 安装

### 方式一：npm安装（推荐）

适合快速体验和生产环境使用：

```bash
npm install @npm_xiyuan/vision-foundation-mcp
# 或
pnpm add @npm_xiyuan/vision-foundation-mcp
```

**优势**：
- ✅ 一键安装，无需手动配置
- ✅ 自动管理依赖和版本
- ✅ 支持 npx 直接运行

### 方式二：从源码安装

适合开发者和需要自定义的场景：

#### 1. 克隆仓库

```bash
git clone git@github.com:jiyi1990118/vision-foundation-mcp.git
cd vision-foundation-mcp
pnpm install
pnpm setup:llama  # 可选：检测/准备 llama.cpp
pnpm build
```

#### 2. llama.cpp（自动安装）

llama-server 会在首次运行时自动下载安装到：
- **优先**：项目内 `<package-root>/bin/`
- **降级**：用户目录 `~/.vision-mcp/bin/`

**路径优先级**：
1. `LLAMA_SERVER_PATH` 环境变量
2. 项目内 `bin/llama-server`
3. 用户目录 `~/.vision-mcp/bin/llama-server`
4. 系统路径（`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`）
5. PATH 查找 `llama-server`

如需手动安装：

```bash
# macOS (Homebrew)
brew install llama.cpp

# Linux — 从源码编译
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp && cmake -B build && cmake --build build --config Release
# 将 build/bin/llama-server 加入 PATH 或设置 LLAMA_SERVER_PATH

# 或使用项目提供的检测工具
pnpm setup:llama
```

**环境变量：**
- `LLAMA_SERVER_PATH` — 指定已安装的 llama-server 路径（跳过自动下载）
- `LLAMA_DOWNLOAD_MIRROR` — 指定镜像站（如 `https://ghproxy.com`，用于加速 GitHub 下载）

#### 3. 下载模型

默认 SmolVLM2-500M-Video（better quality）：

```bash
mkdir -p ~/.vision-mcp/models/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF

# 模型文件（Q4_K_M，~300MB）
curl -L -o ~/.vision-mcp/models/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/SmolVLM2-500M-Video-Instruct-Q4_K_M.gguf \
  "https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/SmolVLM2-500M-Video-Instruct-Q4_K_M.gguf"

# 视觉投影器（Q8_0，~100MB）
curl -L -o ~/.vision-mcp/models/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf \
  "https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf"
```

可选 — SmolVLM-500M-Instruct（更快的 fast 候选，Q8_0）：

```bash
mkdir -p ~/.vision-mcp/models/ggml-org/SmolVLM-500M-Instruct-GGUF

# 模型文件 (417MB)
curl -L -o ~/.vision-mcp/models/ggml-org/SmolVLM-500M-Instruct-GGUF/SmolVLM-500M-Instruct-Q8_0.gguf \
  "https://huggingface.co/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/main/SmolVLM-500M-Instruct-Q8_0.gguf"

# 视觉投影器 (104MB)
curl -L -o ~/.vision-mcp/models/ggml-org/SmolVLM-500M-Instruct-GGUF/mmproj-SmolVLM-500M-Instruct-Q8_0.gguf \
  "https://huggingface.co/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/main/mmproj-SmolVLM-500M-Instruct-Q8_0.gguf"
```

可选 — MiniCPM-V 2.6（high，需 GPU，~2GB）：

```bash
mkdir -p ~/.vision-mcp/models/bartowski/MiniCPM-V-2_6-GGUF

# 模型文件 (~2GB)
curl -L -o ~/.vision-mcp/models/bartowski/MiniCPM-V-2_6-GGUF/MiniCPM-V-2_6-Q4_K_M.gguf \
  "https://huggingface.co/bartowski/MiniCPM-V-2_6-GGUF/resolve/main/MiniCPM-V-2_6-Q4_K_M.gguf"

# 视觉投影器
curl -L -o ~/.vision-mcp/models/bartowski/MiniCPM-V-2_6-GGUF/mmproj-model-f16.gguf \
  "https://huggingface.co/bartowski/MiniCPM-V-2_6-GGUF/resolve/main/mmproj-model-f16.gguf"
```

> **中国大陆用户**：可使用 `https://hf-mirror.com` 替代 `https://huggingface.co` 加速下载

> **提示**：MiniCPM-V 仅在启用 `VISION_HIGH_QUALITY=1` 且请求带 `options.quality="high"` 时才会加载；默认仍用 SmolVLM2。

## ⚙️ 配置 MCP Client

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

**使用 npm 包（推荐）**：

```json
{
  "mcpServers": {
    "vision": {
      "command": "npx",
      "args": ["@npm_xiyuan/vision-foundation-mcp"]
    }
  }
}
```

**从源码运行**：

```json
{
  "mcpServers": {
    "vision": {
      "command": "node",
      "args": ["/path/to/vision-foundation-mcp/dist/index.js"],
      "env": {
        "VISION_PROVIDER": "smolvlm2",
        "VISION_HIGH_QUALITY": "1",
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

> `VISION_HIGH_QUALITY=1` 是可选项；省略则只跑 SmolVLM2（fast），更省内存。

如果要试更快的 SmolVLM-500M 候选，把 `VISION_PROVIDER` 改为：

```json
"VISION_PROVIDER": "gguf"
```

### Cursor

在 Cursor Settings → MCP 中添加：

```json
{
  "mcpServers": {
    "vision": {
      "command": "npx",
      "args": ["@npm_xiyuan/vision-foundation-mcp"]
    }
  }
}
```

或从源码运行：

```json
{
  "mcpServers": {
    "vision": {
      "command": "node",
      "args": ["/path/to/vision-foundation-mcp/dist/index.js"]
    }
  }
}
```

## 💡 使用

配置完成后，在 Claude/Cursor 中直接对话：

```
用户: 请分析这张图片 /path/to/screenshot.png
Claude: [调用 vision.analyze] 这张图片显示了一个红色方块和蓝色圆形...
```

### 支持的意图

| 意图关键词 | 执行的 Skill |
|-----------|-------------|
| describe / describe / 描述 | classify + summary |
| text / extract / OCR / 文字 | ocr |
| table / 表格 | table |
| document / 文档 | document |
| poster / 海报 | poster |
| safe / 审核 | moderation |
| layout / 布局 | layout |
| detail / 详细 | classify + ocr + summary |
| auto (默认) | classify + summary |

### 直接指定 Skill

```
用户: 用 OCR 技能分析这张图片 base64:iVBORw0K...
```

### 高质量模式（需启用 `VISION_HIGH_QUALITY=1` + GPU）

启用后，请求带 `quality: "high"` 即可路由到 MiniCPM-V 2.6：

```json
{
  "image": "/path/to/chart.png",
  "intent": "describe",
  "options": { "quality": "high" }
}
```

- 资源不足（<4GB 可用内存）或无 GPU → 自动回退 SmolVLM
- `quality: "fast"` 或缺省 → 始终用 SmolVLM
- 首次 `quality=high` 触发 MiniCPM-V 模型准备（已下载则秒载，否则下载约 2GB）

## 🔧 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VISION_PROVIDER` | `smolvlm2` | 默认/active Provider：`smolvlm2`、`gguf` 或 `onnx` |
| `VISION_HIGH_QUALITY` | 未设置 | 设为 `1` 时额外注册 MiniCPM-V 2.6，使 `quality=high` 请求可路由到它 |
| `LLAMA_SERVER_PATH` | 自动检测 | llama-server 路径（设置后跳过自动下载） |
| `LLAMA_DOWNLOAD_MIRROR` | - | 下载镜像站（如 `https://ghproxy.com`） |
| `LOG_LEVEL` | `info` | 日志级别：error/warn/info/debug |
| `HF_ENDPOINT` | `https://hf-mirror.com` | 模型下载地址（ONNX Provider / 国内镜像） |

## 🏗️ 架构

```
MCP Client
    │ vision.analyze(image, intent)
    ▼
┌───────────────────────────────────────┐
│  Vision Foundation MCP                 │
│                                        │
│  Tool → Normalizer → Metadata          │
│              → Router (selectProvider)  │
│              → Planner → Policy         │
│              → SkillPipeline → Provider │
│              → Composer → Result        │
│                                        │
│  Providers (端口隔离，可共存)             │
│    ├─ SmolVLM2 (default, better quality)│
│    ├─ GGUF     (SmolVLM-500M fast)       │
│    ├─ MiniCPM  (MiniCPM-V 2.6 high)      │
│    └─ ONNX     (legacy, Transformers.js) │
│        └─ llama-server → Metal/CUDA/CPU  │
│        └─ 进程查找复用已有 llama-server，必要时随机空闲端口启动 │
│        └─ 自动下载安装（首次运行）          │
└───────────────────────────────────────┘
```

## 🛠️ 开发

```bash
# 开发模式（热重载）
pnpm dev

# 类型检查
pnpm typecheck

# 运行测试（单元测试，不需要GPU）
pnpm test:unit

# 运行完整测试（包括推理测试，需要GPU和模型）
pnpm test

# 运行特定测试
npx vitest run --fileParallelism=false tests/resolver.test.ts
```

## 📊 性能指标

| 指标 | SmolVLM (fast) | SmolVLM2 (default) | MiniCPM-V (high) |
|------|----------------|---------------------|------------------|
| 模型加载 | ~1s | ~1-2s | ~5s |
| 单次推理 | ~300ms | ~400-600ms | ~1-2s |
| 内存占用 | ~500MB | ~500-800MB | ~4GB |
| 最小内存要求 | 512MB | 768MB | 4GB |
| GPU 要求 | 否（CPU 可跑） | 否（CPU 可跑） | 是（Metal/CUDA） |
| 并发上限 | 4 | 4 | 4 |
| 空闲超时 | 10 min | 10 min | 10 min |
| 描述质量 | 良好 | **优秀** ⭐ | 卓越 |

## 🔗 相关链接

- **GitHub 仓库**：[jiyi1990118/vision-foundation-mcp](https://github.com/jiyi1990118/vision-foundation-mcp)
- **npm 包**：[@npm_xiyuan/vision-foundation-mcp](https://www.npmjs.com/package/@npm_xiyuan/vision-foundation-mcp)
- **MCP 协议**：[Model Context Protocol](https://modelcontextprotocol.io/)
- **llama.cpp**：[ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp)

## 📄 License

MIT

---

**使用愉快！如有问题，欢迎提交 [Issue](https://github.com/jiyi1990118/vision-foundation-mcp/issues)** 🎉
