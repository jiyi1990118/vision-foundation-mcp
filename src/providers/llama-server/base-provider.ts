/**
 * BaseLlamaCppProvider - shared llama.cpp/llama-server provider implementation.
 *
 * GGUF-backed vision providers (SmolVLM, SmolVLM2, MiniCPM-V) all drive the
 * same `llama-server` binary over HTTP via `LlamaServerProcess`. This base
 * class encapsulates the identical lifecycle, caching, resource management,
 * GPU adaptation, and image-optimization logic; subclasses only supply
 * identity, resource requirements, model-file acquisition, and tunables.
 *
 * @see Docs/01-architecture/06-provider-runtime.md
 * @see Docs/01-architecture/08-lifecycle-manager.md
 */
import { freemem } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { logger } from '../../utils/logger.js';
import { detectHardware, type HardwareProfile } from '../../core/runtime-detector.js';
import { LlamaServerProcess } from './process.js';
import { allocateRandomFreePort, findExistingLlamaServerProcess } from './process-registry.js';
import type { ImageInput, InferenceRequest, InferenceResponse } from '../../types/domain.js';
import type { VisionProvider } from '../types.js';

export interface ModelPaths {
  modelPath: string;
  mmprojPath: string;
}

export interface LlamaCppProviderConfig {
  name: string;
  requirements: {
    minMemoryMB: number;
    gpuRequired: boolean;
    modelSizeMB: number;
  };
  maxOutputTokens: number;
  maxImageDimension: number;
  minFreeRamMB: number;
  /** Minimum VRAM (MB) to offload layers on CUDA; below this -> CPU. */
  minVramMB: number;
  /** Acquire model files; throws on download/corruption failure. */
  ensureModel: () => Promise<ModelPaths>;
  /** Idle timeout before auto-unload (ms). Defaults to 10 min. */
  idleTimeoutMs?: number;
}

const DEFAULT_IDLE_TIMEOUT = 600_000;
const CACHE_TTL = 3_600_000;
const CACHE_MAX = 100;
const MEMORY_CHECK_INTERVAL = 30_000;

export abstract class BaseLlamaCppProvider implements VisionProvider {
  readonly name: string;
  readonly runtime = 'llama-cpp';
  readonly supportedRuntimes = ['llama-cpp'];
  readonly supportedSkills = [
    'classify', 'ocr', 'summary', 'table', 'document', 'poster', 'moderation', 'layout',
  ];
  readonly requirements: {
    minMemoryMB: number;
    gpuRequired: boolean;
    modelSizeMB: number;
  };

  protected readonly config: LlamaCppProviderConfig;

  private loaded = false;
  private server: LlamaServerProcess | null = null;
  private hw: HardwareProfile | null = null;
  private resultCache = new Map<string, { text: string; duration: number; timestamp: number }>();
  private refCount = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private memoryTimer: ReturnType<typeof setInterval> | null = null;
  // In-flight load/respawn promises deduplicate concurrent cold loads and
  // crash-restart respawns so we never spawn two llama-server processes.
  private loadPromise: Promise<void> | null = null;
  private spawnPromise: Promise<{ port: number; gpuLayers: number }> | null = null;
  // Deduplicates concurrent unload calls (idle timer + memory monitor + shutdown)
  // and lets load/infer wait for an in-flight teardown before proceeding.
  private unloadPromise: Promise<void> | null = null;

  protected constructor(config: LlamaCppProviderConfig) {
    this.config = config;
    this.name = config.name;
    this.requirements = config.requirements;
  }

  private get idleTimeoutMs(): number {
    return this.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT;
  }

  // ── Lifecycle ───────────────────────────────────────

  async load(): Promise<void> {
    // Wait for any in-flight teardown so we don't spawn while unload is stopping.
    if (this.unloadPromise) {
      await this.unloadPromise;
    }
    if (this.loaded) {
      return;
    }
    // Deduplicate concurrent cold loads so we never spawn two llama-server
    // processes for the same provider. Concurrent callers wait on the same
    // in-flight load.
    if (this.loadPromise) {
      await this.loadPromise;
      if (this.loaded) {
        return;
      }
      // Load resolved but the provider was unloaded in the meantime (idle /
      // memory race). Fall through to start a fresh load.
    }
    this.loadPromise = this.doLoad();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async doLoad(): Promise<void> {
    const { port, gpuLayers } = await this.spawnServer();
    this.loaded = true;
    this.startMemoryMonitor();
    logger.info(`${this.name} provider loaded`, {
      port,
      baseUrl: this.server!.endpoint,
      gpuLayers,
      refCount: this.refCount,
    });
  }

  /**
   * Spawn (or attach to) the llama-server subprocess. Shared by the initial
   * load and crash-restart, and deduplicated via `spawnPromise` so concurrent
   * callers never start two servers.
   */
  private async spawnServer(): Promise<{ port: number; gpuLayers: number }> {
    if (this.spawnPromise) return this.spawnPromise;
    const promise = this.doSpawnServer();
    this.spawnPromise = promise;
    try {
      return await promise;
    } finally {
      this.spawnPromise = null;
    }
  }

  private async doSpawnServer(): Promise<{ port: number; gpuLayers: number }> {
    this.hw = await detectHardware();

    if (this.requirements.gpuRequired && !this.hw.hasMetal && !this.hw.hasCUDA) {
      throw new Error(
        `${this.name} provider requires a GPU (Metal/CUDA); host has none. ` +
        'The provider-router should fall back to the fast provider instead.',
      );
    }

    const gpuLayers = this.computeGpuLayers();
    const threads = this.computeThreads();
    logger.info(`${this.name} provider loading`, {
      gpu: this.hw.gpus[0]?.name ?? 'none', gpuLayers, threads,
    });

    const modelPaths = await this.config.ensureModel();
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

    return { port, gpuLayers };
  }

  async infer(req: InferenceRequest): Promise<InferenceResponse> {
    // Wait for any in-flight teardown so we don't use a server being stopped.
    if (this.unloadPromise) {
      await this.unloadPromise;
    }
    if (!this.loaded || !this.server) {
      await this.load();
    }
    this.acquire();

    try {
      return await this.doInfer(req);
    } finally {
      this.release();
    }
  }

  async unload(): Promise<void> {
    // Deduplicate concurrent unload calls (idle timer + memory monitor + shutdown).
    if (this.unloadPromise) return this.unloadPromise;
    this.unloadPromise = this.doUnload();
    try {
      await this.unloadPromise;
    } finally {
      this.unloadPromise = null;
    }
  }

  private async doUnload(): Promise<void> {
    // Wait for any in-flight load/respawn to settle before tearing down, so we
    // never stop a server that is mid-spawn.
    if (this.loadPromise) {
      await this.loadPromise.catch(() => {});
    }
    if (this.spawnPromise) {
      await this.spawnPromise.catch(() => {});
    }
    if (!this.loaded) return;

    logger.info(`${this.name} provider unloading`, { refCount: this.refCount });

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
    logger.info(`${this.name} provider unloaded`, { provider: this.name });
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  // ── Reference counting ──────────────────────────────

  private acquire(): void {
    this.refCount++;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private release(): void {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount === 0 && this.loaded) {
      this.idleTimer = setTimeout(() => {
        if (this.refCount === 0) {
          logger.info(`${this.name} idle timeout, unloading`, { idleMs: this.idleTimeoutMs });
          this.unload()
            .catch((e) => logger.warn(`${this.name} idle unload failed`, { error: (e as Error).message }));
        }
      }, this.idleTimeoutMs);
    }
  }

  // ── Inference ───────────────────────────────────────

  private async doInfer(req: InferenceRequest): Promise<InferenceResponse> {
    const useCache = req.cache !== false;
    const cacheKey = this.buildCacheKey(req);
    if (useCache) {
      const cached = this.resultCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        // LRU: refresh position so frequently-hit entries survive eviction.
        this.resultCache.delete(cacheKey);
        this.resultCache.set(cacheKey, cached);
        logger.debug(`${this.name} cache hit`, { key: cacheKey.slice(0, 16) });
        return { text: cached.text, duration: 0 };
      }
    }

    const optimizedImage = await this.optimizeImage(req.image);
    const start = Date.now();
    const dataUri = `data:${optimizedImage.mimeType};base64,${optimizedImage.buffer.toString('base64')}`;
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUri } },
          { type: 'text', text: req.prompt },
        ],
      }],
      max_tokens: Math.min(req.maxTokens, this.config.maxOutputTokens),
      temperature: req.temperature,
      stream: false,
    };

    const data = await this.server!.inferWithRetry(body, async () => {
      // The server process died mid-request. Respawn WITHOUT acquiring a new
      // reference: the enclosing infer() already holds one and will release it
      // on completion, keeping ref-counting symmetric across crash-restarts.
      // spawnServer() is deduplicated, so concurrent restarts share one respawn.
      this.loaded = false;
      this.server = null;
      await this.spawnServer();
      this.loaded = true;
    }, 2, req.signal);
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    const duration = Date.now() - start;

    logger.debug(`${this.name} inference completed`, {
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
  }

  async *streamInfer(req: InferenceRequest): AsyncGenerator<string> {
    if (this.unloadPromise) {
      await this.unloadPromise;
    }
    if (!this.loaded || !this.server) {
      await this.load();
    }
    this.acquire();

    try {
      const optimizedImage = await this.optimizeImage(req.image);
      const b64 = optimizedImage.buffer.toString('base64');
      const dataUri = `data:${optimizedImage.mimeType};base64,${b64}`;

      const body = {
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUri } },
            { type: 'text', text: req.prompt },
          ],
        }],
        max_tokens: Math.min(req.maxTokens, this.config.maxOutputTokens),
        temperature: req.temperature,
      };

      let yielded = 0;
      for await (const chunk of this.server!.streamOnce(body, req.signal)) {
        yielded++;
        yield chunk;
      }
      if (yielded === 0) {
        logger.warn(`${this.name} streamInfer produced no chunks`);
      }
    } finally {
      this.release();
    }
  }

  // ── Resource management ─────────────────────────────

  private startMemoryMonitor(): void {
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    this.memoryTimer = setInterval(() => {
      const freeMB = Math.floor(freemem() / 1024 / 1024);
      if (freeMB < this.config.minFreeRamMB && this.refCount === 0 && !this.loadPromise && !this.spawnPromise) {
        logger.warn(`${this.name} low memory, unloading`, {
          freeMB,
          threshold: this.config.minFreeRamMB,
        });
        this.unload().catch(() => {});
      }
    }, MEMORY_CHECK_INTERVAL);
  }

  // ── GPU adaptation ──────────────────────────────────

  private computeGpuLayers(): number {
    if (!this.hw) return 0;
    if (this.hw.hasMetal || this.hw.hasCoreML) return 99;
    if (this.hw.hasCUDA) {
      const gpu = this.hw.gpus.find((g) => g.vendor === 'nvidia');
      if (gpu?.vramMB && gpu.vramMB < this.config.minVramMB) return 0;
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

  // ── Image optimization ──────────────────────────────

  private async optimizeImage(image: ImageInput): Promise<ImageInput> {
    try {
      const meta = await sharp(image.buffer).metadata();
      const maxDim = this.config.maxImageDimension;
      if ((meta.width ?? 0) > maxDim || (meta.height ?? 0) > maxDim) {
        const resized = await sharp(image.buffer)
          .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer();
        logger.debug(`${this.name} image resized`, {
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
      // If sharp fails, use original.
    }
    return image;
  }

  private buildCacheKey(req: InferenceRequest): string {
    const imgHash = createHash('sha256').update(req.image.buffer).digest('hex').slice(0, 32);
    const promptHash = createHash('sha256').update(req.prompt).digest('hex').slice(0, 16);
    // Include the actual generation params so requests that differ in
    // max_tokens/temperature don't collide on the same cached response.
    const cappedTokens = Math.min(req.maxTokens, this.config.maxOutputTokens);
    const paramsHash = createHash('sha256').update(`${cappedTokens}:${req.temperature}`).digest('hex').slice(0, 8);
    return `${imgHash}:${promptHash}:${paramsHash}`;
  }
}
