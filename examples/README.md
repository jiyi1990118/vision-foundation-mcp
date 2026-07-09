# Examples

本目录包含 `@npm_xiyuan/vision-foundation-mcp` 的使用示例。

## 文件列表

| 文件 | 说明 |
|------|------|
| `basic-analysis.mjs` | 基础图片分析（默认 SmolVLM2） |
| `high-quality.mjs` | 高质量分析（MiniCPM-V，需 `VISION_HIGH_QUALITY=1` + GPU） |
| `ocr-only.mjs` | 只跑 OCR skill 提取文字 |
| `ocr-provider.mjs` | 直接运行可选 `ppu-paddle-ocr` Provider |
| `classify-only.mjs` | 只跑 classify skill 分类图片 |
| `base64-input.mjs` | 用 base64 data URI 作为输入（适用于非文件来源） |
| `custom-intent.mjs` | 自定义自然语言 intent 触发不同 skill 组合 |

## 运行方式

```bash
# 先构建
pnpm build

# 基础分析
node examples/basic-analysis.mjs /path/to/image.png

# 高质量模式（需先启用）
VISION_HIGH_QUALITY=1 node examples/high-quality.mjs /path/to/image.png

# OCR
node examples/ocr-only.mjs /path/to/screenshot.png

# 专用 PaddleOCR Provider
VISION_OCR_PROVIDER=ppu-paddle-ocr node examples/ocr-provider.mjs /path/to/screenshot.png
```

## 配置

所有示例都假设 MCP server 已构建到 `dist/index.js`。可通过环境变量控制：

```bash
VISION_PROVIDER=smolvlm2       # 默认 SmolVLM2 (更好描述质量)
VISION_PROVIDER=gguf          # SmolVLM-500M fast
VISION_PROVIDER=onnx           # legacy ONNX
VISION_HIGH_QUALITY=1           # 启用 MiniCPM-V high quality
VISION_OCR_PROVIDER=ppu-paddle-ocr # 启用专用 OCR provider
LOG_LEVEL=warn                  # 减少日志噪音
```
