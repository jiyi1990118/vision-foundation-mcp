/**
 * GGUF Provider — SmolVLM-500M via llama.cpp llama-server.
 *
 * Architecture:
 *   MCP Tool → GGUF Provider → LlamaServerProcess → HTTP → llama-server (subprocess)
 *
 * Features:
 * - GPU auto-detection: Metal / CUDA / CPU (-ngl, P-core threads)
 * - Result cache: SHA256(image+prompt) → cached response
 * - Idle timeout: auto-unload after 10 min of no requests
 * - Reference counting: concurrent requests share one server instance
 * - Memory monitoring: unload if system RAM < threshold
 * - Crash recovery: auto-restart llama-server on unexpected exit
 * - Image optimization: resize large images to 512px max
 * - Stream support: optional SSE streaming for long generations
 *
 * @see Docs/01-architecture/06-provider-runtime.md
 * @see Docs/01-architecture/08-lifecycle-manager.md
 */

import { freemem } from 'node:os';
import { createHash } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { detectHardware, type HardwareProfile } from '../../core/runtime-detector.js';
import { ensureGGUFModel } from '../../core/model-manager.js';
import { LlamaServerProcess } from '../llama-server/process.js';
import { allocateRandomFreePort, findExistingLlamaServerProcess } from '../llama-server/process-registry.js';
import type {
  ImageInput,
  InferenceRequest,
  InferenceResponse,
} from '../../types/domain.js';
import type { VisionProvider } from '../types.js';

// ── Constants ──────────────────────────────────────────

// Resource management
const IDLE_TIMEOUT = 600_000;        // 10 min → unload server
const MIN_FREE_RAM_MB = 512;         // Below this → force unload to free memory
const MEMORY_CHECK_INTERVAL = 30_000; // Check every 30s

// Cache
const CACHE_TTL = 3_600_000;         // 1 hour
const CACHE_MAX = 100;

// ── Provider ───────────────────────────────────────────

export class GGUFProvider implements VisionProvider {
  readonly name = 'gguf-smolvlm';
  readonly runtime = 'llama-cpp';
  readonly supportedRuntimes = ['llama-cpp'];
  readonly supportedSkills = [
    'classify', 'ocr', 'summary', 'table', 'document', 'poster', 'moderation', 'layout',
  ];
  readonly requirements = {
    minMemoryMB: 256,
    gpuRequired: false,
    modelSizeMB: 417,
  };

  private loaded = false;
  private server: LlamaServerProcess | null = null;
  private hw: HardwareProfile | null = null;

  // Result cache
  private resultCache = new Map<string, { text: string; duration: number; timestamp: number }>();

  // Resource management: reference counting + idle timer
  private refCount = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private memoryTimer: ReturnType<typeof setInterval> | null = null;
  private lastUsedAt = 0;

  // ── Lifecycle ───────────────────────────────────────

  async load(): Promise<void> {
    if (this.loaded) {
      this.acquire();
      return;
    }

    this.hw = await detectHardware();
    const gpuLayers = this.computeGpuLayers();
    const threads = this.computeThreads();
    logger.info('GGUF Provider loading', {
      gpu: this.hw.gpus[0]?.name ?? 'none',
      gpuLayers,
      threads,
    });

    const modelPaths = await ensureGGUFModel();

    const existing = findExistingLlamaServerProcess({ modelPath: modelPaths.modelPath });
    const port = existing?.port ?? await allocateRandomFreePort();
    this.server = new LlamaServerProcess({
      name: this.name,
      modelPath: modelPaths.modelPath,
      mmprojPath: modelPaths.mmprojPath,
      port,
      existingPid: existing?.pid,
      gpuLayers,
      threads,
    });
    await this.server.start();

    this.loaded = true;
    this.acquire();
    this.startMemoryMonitor();

    logger.info('GGUF Provider loaded', {
      port,
      baseUrl: this.server.endpoint,
      gpuLayers,
      refCount: this.refCount,
    });
  }

  private acquire(): void {
    this.refCount++;
    this.lastUsedAt = Date.now();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private release(): void {
    this.refCount = Math.max(0, this.refCount - 1);
    this.lastUsedAt = Date.now();

    if (this.refCount === 0 && this.loaded) {
      this.idleTimer = setTimeout(() => {
        if (this.refCount === 0) {
          logger.info('Idle timeout reached, unloading server', { idleMs: IDLE_TIMEOUT });
          this.unload().catch((e) => {
            logger.warn('Idle unload failed', { error: (e as Error).message });
          });
        }
      }, IDLE_TIMEOUT);
    }
  }

  async infer(req: InferenceRequest): Promise<InferenceResponse> {
    if (!this.loaded || !this.server) {
      await this.load();
    } else {
      this.acquire();
    }

    try {
      return await this.doInfer(req);
    } finally {
      this.release();
    }
  }

  private async doInfer(req: InferenceRequest): Promise<InferenceResponse> {
    const useCache = req.cache !== false;
    const cacheKey = this.buildCacheKey(req);
    if (useCache) {
      const cached = this.resultCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        logger.debug('Cache hit', { key: cacheKey.slice(0, 16) });
        return { text: cached.text, duration: 0 };
      }
    }

    const optimizedImage = await this.optimizeImage(req.image);
    const start = Date.now();

    try {
      const b64 = optimizedImage.buffer.toString('base64');
      const dataUri = `data:${optimizedImage.mimeType};base64,${b64}`;

      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUri } },
              { type: 'text', text: req.prompt },
            ],
          },
        ],
        max_tokens: Math.min(req.maxTokens, 512),
        temperature: req.temperature,
        stream: false,
      };

      const data = await this.server!.inferWithRetry(body, async () => {
        this.loaded = false;
        this.server = null;
        this.refCount = 0;
        await this.load();
      });
      const text = data.choices?.[0]?.message?.content?.trim() ?? '';
      const duration = Date.now() - start;

      logger.debug('GGUF inference completed', {
        duration,
        tokens: data.usage?.completion_tokens ?? 0,
        textLength: text.length,
      });

      if (useCache) {
        this.resultCache.set(cacheKey, { text, duration, timestamp: Date.now() });
        if (this.resultCache.size > CACHE_MAX) {
          const oldest = this.resultCache.keys().next().value;
          if (oldest) this.resultCache.delete(oldest);
        }
      }

      return { text, duration };
    } catch (e) {
      logger.error('GGUF inference failed', { error: (e as Error).message });
      throw e;
    }
  }

  async *streamInfer(req: InferenceRequest): AsyncGenerator<string> {
    if (!this.loaded || !this.server) {
      await this.load();
    } else {
      this.acquire();
    }

    try {
      const optimizedImage = await this.optimizeImage(req.image);
      const b64 = optimizedImage.buffer.toString('base64');
      const dataUri = `data:${optimizedImage.mimeType};base64,${b64}`;

      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUri } },
              { type: 'text', text: req.prompt },
            ],
          },
        ],
        max_tokens: Math.min(req.maxTokens, 512),
        temperature: req.temperature,
      };

      let yielded = 0;
      for await (const chunk of this.server!.streamOnce(body)) {
        yielded++;
        yield chunk;
      }
      if (yielded === 0) {
        logger.warn('streamInfer produced no chunks', { provider: this.name });
      }
    } finally {
      this.release();
    }
  }

  async unload(): Promise<void> {
    if (!this.loaded) return;

    logger.info('GGUF Provider unloading', {
      provider: this.name,
      refCount: this.refCount,
    });

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer);
      this.memoryTimer = null;
    }

    if (this.server) {
      await this.server.stop();
      this.server = null;
    }

    this.resultCache.clear();
    this.loaded = false;
    this.refCount = 0;
    logger.info('GGUF Provider unloaded', { provider: this.name });
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  // ── Resource Management ─────────────────────────────

  private startMemoryMonitor(): void {
    if (this.memoryTimer) clearInterval(this.memoryTimer);

    this.memoryTimer = setInterval(() => {
      const freeMB = Math.floor(freemem() / 1024 / 1024);

      if (freeMB < MIN_FREE_RAM_MB && this.refCount === 0) {
        logger.warn('Low system memory, unloading server', {
          freeMB,
          threshold: MIN_FREE_RAM_MB,
        });
        this.unload().catch(() => {});
      }
    }, MEMORY_CHECK_INTERVAL);
  }

  // ── GPU Adaptation ───────────────────────────────────

  private computeGpuLayers(): number {
    if (!this.hw) return 0;
    if (this.hw.hasMetal || this.hw.hasCoreML) return 99;
    if (this.hw.hasCUDA) {
      const gpu = this.hw.gpus.find((g) => g.vendor === 'nvidia');
      if (gpu?.vramMB && gpu.vramMB < 2048) return 0;
      return 99;
    }
    return 0;
  }

  private computeThreads(): number {
    if (!this.hw) return 4;
    if (this.hw.coreTopology && this.hw.coreTopology.performanceCores > 0) {
      return this.hw.coreTopology.performanceCores;
    }
    return Math.max(1, Math.min(this.hw.cpuCores, 8));
  }

  // ── Image Optimization ──────────────────────────────

  private async optimizeImage(image: ImageInput): Promise<ImageInput> {
    try {
      const sharp = (await import('sharp')).default;
      const meta = await sharp(image.buffer).metadata();
      const maxDim = 512;

      if ((meta.width ?? 0) > maxDim || (meta.height ?? 0) > maxDim) {
        const resized = await sharp(image.buffer)
          .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer();

        logger.debug('Image resized', {
          from: `${meta.width}x${meta.height}`,
          origSize: image.size,
          newSize: resized.length,
        });

        return {
          buffer: resized,
          mimeType: 'image/png',
          source: image.source + '-resized',
          size: resized.length,
        };
      }
    } catch {
      // If sharp fails, use original
    }
    return image;
  }

  private buildCacheKey(req: InferenceRequest): string {
    const imgHash = createHash('sha256')
      .update(req.image.buffer)
      .digest('hex')
      .slice(0, 32);
    const promptHash = createHash('sha256')
      .update(req.prompt)
      .digest('hex')
      .slice(0, 16);
    return `${imgHash}:${promptHash}`;
  }
}
