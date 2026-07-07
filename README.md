# Vision Foundation MCP

本地视觉理解 MCP 服务，基于 SmolVLM / SmolVLM2 / MiniCPM-V + llama.cpp，为 Claude / Cursor / ChatGPT 等 MCP Client 提供图片分析能力。

## 特性

- **本地推理**：SmolVLM-500M / SmolVLM2-500M GGUF，无需云端 API
- **GPU 加速**：自动检测 Metal (Apple Silicon) / CUDA (NVIDIA) / CPU
- **多能力**：分类 / OCR / 描述 / 表格 / 文档 / 海报 / 审核 / 布局（8 个 Skill）
- **智能路由**：意图自动映射到 Skill 组（describe → classify + summary）
- **多模型可选**：默认 SmolVLM2（better quality），可切 SmolVLM（fast），`VISION_HIGH_QUALITY=1` 启用 MiniCPM-V 2.6（high）
- **高性能**：单次推理 ~300ms（Metal GPU），结果缓存秒返回
- **资源管理**：空闲超时卸载、引用计数、内存压力监控、崩溃自动恢复

## 安装

### 1. 安装 llama.cpp

```bash
# 推荐：显式 setup 检测/提示安装
pnpm setup:llama

# macOS (Homebrew)
brew install llama.cpp

# Linux — 从源码编译
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp && cmake -B build && cmake --build build --config Release
# 将 build/bin/llama-server 加入 PATH 或设置 LLAMA_SERVER_PATH
```

`pnpm setup:llama` 不会在 MCP 运行时静默安装可执行文件。它会：

- 检测 `LLAMA_SERVER_PATH`
- 检测 `~/.vision-mcp/bin/llama-server(.exe)`
- 检测 Homebrew / system / PATH 里的 `llama-server`
- 找不到时打印对应平台的安装说明

高级用法：可以设置 `LLAMA_SERVER_DOWNLOAD_URL`，显式下载可信的 `llama-server` 二进制到 `~/.vision-mcp/bin/`。

### 2. 下载模型

默认 SmolVLM2-500M-Video（better quality）：

```bash
mkdir -p ~/.vision-mcp/models/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF

# 模型文件（Q8_0）
curl -L -o ~/.vision-mcp/models/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/SmolVLM2-500M-Video-Instruct-Q8_0.gguf \
  "https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/SmolVLM2-500M-Video-Instruct-Q8_0.gguf"

# 视觉投影器（Q8_0）
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

可选 — MiniCPM-V 2.6（high，需 GPU，~5GB 首次自动下载）：

```bash
mkdir -p ~/.vision-mcp/models/bartowski/MiniCPM-V-2_6-GGUF

# 模型文件 (~4.7GB)
curl -L -o ~/.vision-mcp/models/bartowski/MiniCPM-V-2_6-GGUF/MiniCPM-V-2_6-Q4_K_M.gguf \
  "https://huggingface.co/bartowski/MiniCPM-V-2_6-GGUF/resolve/main/MiniCPM-V-2_6-Q4_K_M.gguf"

# 视觉投影器
curl -L -o ~/.vision-mcp/models/bartowski/MiniCPM-V-2_6-GGUF/mmproj-model-f16.gguf \
  "https://huggingface.co/bartowski/MiniCPM-V-2_6-GGUF/resolve/main/mmproj-model-f16.gguf"
```

> 中国大陆用户可使用 `https://hf-mirror.com` 替代 `https://huggingface.co`

> MiniCPM-V 仅在启用 `VISION_HIGH_QUALITY=1` 且请求带 `options.quality="high"` 时才会加载；默认仍用 SmolVLM2。

### 3. 安装本项目

```bash
git clone <repo-url>
cd vision-foundation-mcp
pnpm install
pnpm setup:llama
pnpm build
```

## 配置 MCP Client

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

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
      "command": "node",
      "args": ["/path/to/vision-foundation-mcp/dist/index.js"]
    }
  }
}
```

## 使用

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

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VISION_PROVIDER` | `smolvlm2` | 默认/active Provider：`smolvlm2`、`gguf` 或 `onnx` |
| `VISION_HIGH_QUALITY` | 未设置 | 设为 `1` 时额外注册 MiniCPM-V 2.6，使 `quality=high` 请求可路由到它 |
| `LLAMA_SERVER_PATH` | 自动检测 | llama-server 路径 |
| `LOG_LEVEL` | `info` | 日志级别：error/warn/info/debug |
| `HF_ENDPOINT` | `https://hf-mirror.com` | 模型下载地址（ONNX Provider / 国内镜像） |

## 架构

```
MCP Client
    │ vision.analyze(image, intent)
    ▼
┌───────────────────────────────────────┐
│  Vision Foundation MCP v0.2.0         │
│                                        │
│  Tool → Normalizer → Metadata          │
│              → Router (selectProvider)  │
│              → Planner → Policy         │
│              → SkillPipeline → Provider │
│              → Composer → Result        │
│                                        │
│  Providers (端口隔离，可共存)             │
│    ├─ GGUF     (SmolVLM-500M fast)       │
│    ├─ MiniCPM  (MiniCPM-V 2.6 high)      │
│    └─ SmolVLM2 (SmolVLM2-500M fast)      │
│        └─ llama-server → Metal/CUDA/CPU  │
│        └─ 进程查找复用已有 llama-server，必要时随机空闲端口启动 │
└───────────────────────────────────────┘
```

## 开发

```bash
# 开发模式（热重载）
pnpm dev

# 类型检查
pnpm typecheck

# 运行测试
pnpm test

# 运行特定测试
npx vitest run tests/gguf-provider.test.ts
```

## 性能指标

| 指标 | SmolVLM (fast) | SmolVLM2 (fast candidate) | MiniCPM-V (high) |
|------|----------------|---------------------------|------------------|
| 模型加载 | ~1s | 待实测 | ~5s |
| 单次推理 | ~300ms | 待实测 | ~1-2s |
| 内存占用 | ~500MB | ~500-800MB | ~4GB |
| 最小内存要求 | 512MB | 768MB | 4GB |
| GPU 要求 | 否（CPU 可跑） | 否（CPU 可跑） | 是（Metal/CUDA） |
| 并发上限 | 4 | 4 | 4 |
| 空闲超时 | 10 min | 10 min | 10 min |

## License

MIT
