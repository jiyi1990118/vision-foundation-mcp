#!/usr/bin/env node
/**
 * Vision Foundation MCP — Server entry point.
 *
 * Provider selection:
 *   VISION_PROVIDER=smolvlm2 (default) — SmolVLM2-500M-Video via llama.cpp
 *   VISION_PROVIDER=gguf                — SmolVLM-500M-Instruct via llama.cpp
 *   VISION_PROVIDER=onnx                — Transformers.js + ONNX Runtime
 *
 * @see Docs/05-roadmap/01-roadmap.md
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { GGUFProvider } from './providers/gguf/provider.js';
import { SmolVLMProvider } from './providers/smolvlm/provider.js';
import { MiniCPMProvider } from './providers/minicpm/provider.js';
import { SmolVLM2Provider } from './providers/smolvlm2/provider.js';
import { registerVisionAnalyzeTool } from './tools/vision-analyze.js';
import { logger } from './utils/logger.js';
import type { VisionProvider } from './providers/types.js';

export async function buildProvidersForRuntime(env: NodeJS.ProcessEnv = process.env): Promise<VisionProvider[]> {
  // VISION_PROVIDER picks the default/active provider; VISION_HIGH_QUALITY=1
  // also registers the MiniCPM-V high-quality provider so `quality=high`
  // requests can route to it (lazy-loaded on first high-quality request).
  const providerType = env.VISION_PROVIDER ?? 'smolvlm2';
  const enableHighQuality = env.VISION_HIGH_QUALITY === '1';
  const providers: VisionProvider[] = [];

  if (providerType === 'onnx') {
    providers.push(new SmolVLMProvider());
    logger.info('Using ONNX Provider (Transformers.js)');
  } else if (providerType === 'gguf') {
    providers.push(new GGUFProvider());
    logger.info('Using GGUF Provider — SmolVLM-500M-Instruct (llama.cpp llama-server)');
  } else {
    providers.push(new SmolVLM2Provider());
    logger.info('Using SmolVLM2 GGUF Provider — SmolVLM2-500M-Video (llama.cpp llama-server)');
  }

  if (enableHighQuality) {
    providers.push(new MiniCPMProvider());
    logger.info('High-quality provider registered (MiniCPM-V, lazy-loaded on quality=high)');
  }

  const ocrProviderType = env.VISION_OCR_PROVIDER ?? 'ppu-paddle-ocr';
  if (ocrProviderType === 'ppu-paddle-ocr') {
    const { PpuPaddleOcrProvider } = await import('./providers/ppu-paddle-ocr/provider.js');
    providers.push(new PpuPaddleOcrProvider());
    logger.info('OCR provider registered (ppu-paddle-ocr, lazy-loaded on OCR-only requests)');
  } else if (ocrProviderType !== 'none') {
    logger.warn('Unknown OCR provider requested; OCR provider disabled', { provider: ocrProviderType });
  }

  return providers;
}

async function main(): Promise<void> {
  const server = new McpServer({
    name: 'vision-foundation-mcp',
    version: '0.3.0',
  });

  const providers = await buildProvidersForRuntime();

  // Register the single MCP Tool
  registerVisionAnalyzeTool(server, providers);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await Promise.allSettled(providers.map((p) => p.unload()));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('Vision Foundation MCP server running', {
    version: '0.3.0',
    providers: providers.map((p) => p.name),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    logger.error('Fatal error in main()', { error: error.message, stack: error.stack });
    process.exit(1);
  });
}
