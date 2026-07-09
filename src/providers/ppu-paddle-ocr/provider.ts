import type { InferenceRequest, InferenceResponse } from '../../types/domain.js';
import type { VisionProvider } from '../types.js';
import type { NormalizedOcrResult, PaddleOcrRawResult, PaddleOcrRect, PaddleOcrTextBox } from './types.js';

interface PaddleOcrServiceLike {
  initialize(): Promise<void>;
  recognize(input: ArrayBuffer, options?: Record<string, unknown>): Promise<PaddleOcrRawResult>;
  destroy(): Promise<void>;
}

type PaddleOcrServiceCtor = new (options?: Record<string, unknown>) => PaddleOcrServiceLike;

export class PpuPaddleOcrProvider implements VisionProvider {
  readonly name = 'ppu-paddle-ocr';
  readonly runtime = 'native-ocr';
  readonly supportedRuntimes = ['native-ocr'];
  readonly supportedSkills = ['ocr'];
  readonly requirements = {
    minMemoryMB: 256,
    gpuRequired: false,
    modelSizeMB: 80,
  };

  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private service: PaddleOcrServiceLike | null = null;

  constructor(private ServiceCtor?: PaddleOcrServiceCtor) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      const ServiceCtor = this.ServiceCtor ?? await loadPaddleOcrServiceCtor();
      this.service = new ServiceCtor({
        processing: { engine: 'canvas-native' },
        debugging: { debug: false, verbose: false },
        recognition: { strategy: 'per-box' },
      });
      await suppressConsoleOutput(() => this.service!.initialize());
      this.loaded = true;
    })();

    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  async infer(req: InferenceRequest): Promise<InferenceResponse> {
    if (!this.loaded || !this.service) {
      await this.load();
    }

    const start = Date.now();
    const raw = await suppressConsoleOutput(() => this.service!.recognize(bufferToArrayBuffer(req.image.buffer), {
      flatten: true,
      noCache: true,
      strategy: 'per-box',
    }));
    const normalized = normalizePaddleOcrResult(raw);

    return {
      text: JSON.stringify(normalized),
      duration: Date.now() - start,
    };
  }

  async unload(): Promise<void> {
    if (this.service) {
      await this.service.destroy();
      this.service = null;
    }
    this.loaded = false;
    this.loadPromise = null;
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}

export function normalizePaddleOcrResult(raw: PaddleOcrRawResult): NormalizedOcrResult {
  const boxes = raw.results ?? raw.boxes ?? raw.result ?? raw.lines?.flat() ?? [];
  const texts = boxes
    .map((box) => normalizeTextBox(box))
    .filter((item): item is NonNullable<ReturnType<typeof normalizeTextBox>> => item !== null);

  if (texts.length === 0 && raw.text) {
    for (const line of raw.text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      texts.push({ text: line });
    }
  }

  return {
    texts,
    language: detectLanguage(texts.map((item) => item.text).join('\n')),
  };
}

function normalizeTextBox(box: PaddleOcrTextBox): { text: string; position?: string; confidence?: number } | null {
  const text = box.text?.trim();
  if (!text) return null;

  const confidence = box.score ?? box.confidence;
  if (isLowConfidenceShortNoise(text, confidence)) return null;

  const points = box.box ?? box.bbox;
  const normalized = {
    text,
    position: points ? normalizeBoxPosition(points) : rectToPosition(box),
    confidence,
  };

  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== undefined),
  ) as { text: string; position?: string; confidence?: number };
}

function normalizeBoxPosition(points: number[][] | PaddleOcrRect): string | undefined {
  if (!Array.isArray(points)) {
    return rectToPosition(points);
  }

  const xs = points.map((p) => p[0]).filter((n): n is number => typeof n === 'number');
  const ys = points.map((p) => p[1]).filter((n): n is number => typeof n === 'number');
  if (xs.length === 0 || ys.length === 0) return undefined;
  return `${Math.round(Math.min(...xs))},${Math.round(Math.min(...ys))},${Math.round(Math.max(...xs))},${Math.round(Math.max(...ys))}`;
}

function rectToPosition(box: PaddleOcrTextBox | PaddleOcrRect): string | undefined {
  if (
    typeof box.x !== 'number'
    || typeof box.y !== 'number'
    || typeof box.width !== 'number'
    || typeof box.height !== 'number'
  ) {
    return undefined;
  }

  return `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.x + box.width)},${Math.round(box.y + box.height)}`;
}

function detectLanguage(text: string): string {
  if (/[\u4e00-\u9fff]/u.test(text)) return 'zh';
  if (/[A-Za-z]/.test(text)) return 'en';
  return 'unknown';
}

function isLowConfidenceShortNoise(text: string, confidence: number | undefined): boolean {
  if (confidence === undefined || confidence >= 0.5) return false;
  return Array.from(text).length <= 1;
}

async function loadPaddleOcrServiceCtor(): Promise<PaddleOcrServiceCtor> {
  const mod = await import('ppu-paddle-ocr');
  return mod.PaddleOcrService as PaddleOcrServiceCtor;
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

let consoleRedirectDepth = 0;
let originalConsoleLog: typeof console.log | undefined;
let originalConsoleInfo: typeof console.info | undefined;
let originalConsoleWarn: typeof console.warn | undefined;

async function suppressConsoleOutput<T>(fn: () => Promise<T>): Promise<T> {
  if (consoleRedirectDepth === 0) {
    originalConsoleLog = console.log;
    originalConsoleInfo = console.info;
    originalConsoleWarn = console.warn;
    console.log = (...args: unknown[]) => console.error(...args);
    console.info = (...args: unknown[]) => console.error(...args);
    console.warn = (...args: unknown[]) => console.error(...args);
  }
  consoleRedirectDepth++;

  try {
    return await fn();
  } finally {
    consoleRedirectDepth--;
    if (consoleRedirectDepth === 0 && originalConsoleLog && originalConsoleInfo && originalConsoleWarn) {
      console.log = originalConsoleLog;
      console.info = originalConsoleInfo;
      console.warn = originalConsoleWarn;
      originalConsoleLog = undefined;
      originalConsoleInfo = undefined;
      originalConsoleWarn = undefined;
    }
  }
}
