/**
 * MiniCPM-V Provider — high-quality vision model via llama.cpp llama-server.
 *
 * M5 second provider: routes `quality=high` requests to MiniCPM-V 2.6 via the
 * same `llama-server` runtime as the SmolVLM GGUF provider, but on a separate
 * port (18083) so both can coexist, with higher resource requirements.
 *
 * @see Docs/01-architecture/06-provider-runtime.md
 */

import { freemem } from 'node:os';
import { createHash } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { detectHardware, type HardwareProfile } from '../../core/runtime-detector.js';
import { ensureMiniCPMModel } from '../../core/model-manager.js';
import { LlamaServerProcess } from '../llama-server/process.js';
import { allocateRandomFreePort, findExistingLlamaServerProcess } from '../llama-server/process-registry.js';
import type {
  ImageInput,
  InferenceRequest,
  InferenceResponse,
} from '../../types/domain.js';
import type { VisionProvider } from '../types.js';

// Resource management
const IDLE_TIMEOUT = 600_000;
const MIN_FREE_RAM_MB = 1024;
const MEMORY_CHECK_INTERVAL = 30_000;

// Cache
const CACHE_TTL = 3_600_000;
const CACHE_MAX = 100;

export class MiniCPMProvider implements VisionProvider {
  readonly name = 'minicpm-v';
  readonly runtime = 'llama-cpp';
  readonly supportedRuntimes = ['llama-cpp'];
  readonly supportedSkills = [
    'classify', 'ocr', 'summary', 'table', 'document', 'poster', 'moderation', 'layout',
  ];
  readonly requirements = {
    minMemoryMB: 4096,
    gpuRequired: true,
    modelSizeMB: 2048,
  };

  private loaded = false;
  private server: LlamaServerProcess | null = null;
  private hw: HardwareProfile | null = null;

  private resultCache = new Map<string, { text: string; duration: number; timestamp: number }>();

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

    const hw = await detectHardware();
    this.hw = hw;
    if (!hw.hasMetal && !hw.hasCUDA) {
      throw new Error(
        'MiniCPM-V provider requires a GPU (Metal/CUDA); host has none. ' +
        'The provider-router should fall back to the fast provider instead.',
      );
    }

    const gpuLayers = this.computeGpuLayers();
    const threads = this.computeThreads();
    logger.info('MiniCPM-V provider loading', {
      gpu: hw.gpus[0]?.name ?? 'none',
      gpuLayers,
      threads,
    });

    const modelPaths = await ensureMiniCPMModel();
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

    logger.info('MiniCPM-V provider loaded', {
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
          logger.info('MiniCPM-V idle timeout, unloading', { idleMs: IDLE_TIMEOUT });
          this.unload().catch((e) => {
            logger.warn('MiniCPM-V idle unload failed', { error: (e as Error).message });
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
        logger.debug('MiniCPM-V cache hit', { key: cacheKey.slice(0, 16) });
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
        max_tokens: Math.min(req.maxTokens, 1024),
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

      logger.debug('MiniCPM-V inference completed', {
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
      logger.error('MiniCPM-V inference failed', { error: (e as Error).message });
      throw e;
    }
  }

  async unload(): Promise<void> {
    if (!this.loaded) return;

    logger.info('MiniCPM-V provider unloading', { refCount: this.refCount });

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
    logger.info('MiniCPM-V provider unloaded', { provider: this.name });
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
        logger.warn('MiniCPM-V low memory, unloading', { freeMB, threshold: MIN_FREE_RAM_MB });
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
      if (gpu?.vramMB && gpu.vramMB < 4096) return 0;
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
      const maxDim = 2048;

      if ((meta.width ?? 0) > maxDim || (meta.height ?? 0) > maxDim) {
        const resized = await sharp(image.buffer)
          .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer();

        logger.debug('MiniCPM-V image resized', {
          from: `${meta.width}x${meta.height}`,
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
