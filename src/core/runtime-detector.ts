/**
 * Runtime Detector — detects local hardware and recommends the best
 * inference engine configuration.
 *
 * Supports:
 * - Apple Silicon (M1/M2/M3/M4) → CoreML EP
 * - NVIDIA GPU (CUDA)           → CUDA EP
 * - AMD GPU (Windows)            → DirectML EP
 * - Intel Arc / integrated        → DirectML EP (Windows) / CPU (Linux)
 * - Qualcomm Snapdragon (Win ARM)→ DirectML EP
 * - Intel/AMD CPU only            → CPU EP with multi-threading
 *
 * @see Docs/01-architecture/06-provider-runtime.md
 */

import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

// ── Types ──────────────────────────────────────────────

export type CPUArch = 'arm64' | 'x64' | 'ia32' | 'arm' | 'unknown';
export type GPUVendor = 'apple' | 'nvidia' | 'amd' | 'intel' | 'qualcomm' | 'none';
export type ExecutionProvider = 'coreml' | 'cuda' | 'directml' | 'cpu';
export type DType = 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';

/** Apple Silicon chip tier for performance grading */
export type AppleTier = 'm1' | 'm1-pro' | 'm1-max' | 'm1-ultra'
  | 'm2' | 'm2-pro' | 'm2-max' | 'm2-ultra'
  | 'm3' | 'm3-pro' | 'm3-max'
  | 'm4' | 'm4-pro' | 'm4-max'
  | 'unknown';

/** Performance/efficiency core ratio for heterogeneous CPUs */
export interface CoreTopology {
  performanceCores: number;
  efficiencyCores: number;
  total: number;
}

export interface GPUInfo {
  vendor: GPUVendor;
  name: string;
  vramMB?: number;
  deviceId?: number;
}

export interface HardwareProfile {
  platform: NodeJS.Platform;
  cpuArch: CPUArch;
  cpuModel: string;
  cpuCores: number;
  coreTopology?: CoreTopology | undefined;
  totalMemoryMB: number;
  availableMemoryMB: number;
  gpus: GPUInfo[];
  appleTier?: AppleTier | undefined;
  hasMetal: boolean;
  hasCUDA: boolean;
  hasCoreML: boolean;
  hasDirectML: boolean;
}

export type DTypeConfig = Record<string, DType>;

/** Ordered list of (provider, dtype) pairs to try — first success wins */
export interface FallbackStep {
  provider: ExecutionProvider;
  dtype: DTypeConfig;
  label: string;
}

export interface RuntimeConfig {
  provider: ExecutionProvider;
  fallback: ExecutionProvider;
  /** Full ordered fallback chain — try each until one works */
  fallbackChain: FallbackStep[];
  threads: number;
  graphOptimizationLevel: string;
  memoryLimitMB: number;
  recommendedMaxTokens: number;
  dtype: DTypeConfig;
  notes: string[];
}

// ── Async exec helper with timeout ─────────────────────

async function execWithTimeout(cmd: string, timeoutMs = 5000): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

// ── Detection ──────────────────────────────────────────

let cachedProfile: HardwareProfile | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 300_000; // 5 minutes — hardware can change (eGPU hot-plug, memory pressure)

export async function detectHardware(force = false): Promise<HardwareProfile> {
  const now = Date.now();
  if (cachedProfile && !force && now - cacheTimestamp < CACHE_TTL) {
    return cachedProfile;
  }

  const platform = os.platform();
  const cpuArch = detectCPUArch();
  const [cpuModel, gpus] = await Promise.all([
    detectCPUModel(platform),
    detectGPUs(platform, cpuArch),
  ]);
  const cpuCores = os.cpus().length;
  const totalMemoryMB = Math.floor(os.totalmem() / 1024 / 1024);
  const availableMemoryMB = Math.floor(os.freemem() / 1024 / 1024);

  const hasMetal = cpuArch === 'arm64' && platform === 'darwin';
  const hasCUDA = gpus.some((g) => g.vendor === 'nvidia');
  const hasCoreML = hasMetal;
  // DirectML available on Windows with AMD/Intel/Qualcomm GPU
  const hasDirectML =
    platform === 'win32' &&
    gpus.some((g) => ['amd', 'intel', 'qualcomm'].includes(g.vendor));

  // Apple Silicon tier detection
  const appleTier = hasMetal ? detectAppleTier(cpuModel) : undefined;

  // Core topology (P-cores + E-cores) for heterogeneous CPUs
  const coreTopology = detectCoreTopology(cpuModel, cpuCores, platform);

  const profile: HardwareProfile = {
    platform,
    cpuArch,
    cpuModel,
    cpuCores,
    coreTopology,
    totalMemoryMB,
    availableMemoryMB,
    gpus,
    appleTier,
    hasMetal,
    hasCUDA,
    hasCoreML,
    hasDirectML,
  };

  cachedProfile = profile;
  cacheTimestamp = now;
  logger.info('Hardware detected', {
    cpuArch,
    cpuModel: cpuModel.slice(0, 40),
    cpuCores,
    totalMemoryMB,
    availableMemoryMB,
    gpus: gpus.map((g) => `${g.vendor}:${g.name}`).join(', ') || 'none',
    hasMetal,
    hasCUDA,
    hasCoreML,
    hasDirectML,
  });

  return profile;
}

function detectCPUArch(): CPUArch {
  const arch = os.arch();
  switch (arch) {
    case 'arm64':
      return 'arm64';
    case 'x64':
      return 'x64';
    case 'ia32':
      return 'ia32';
    case 'arm':
      return 'arm';
    default:
      return 'unknown';
  }
}

async function detectCPUModel(platform: NodeJS.Platform): Promise<string> {
  try {
    if (platform === 'darwin') {
      return await execWithTimeout('sysctl -n machdep.cpu.brand_string', 3000);
    }
    if (platform === 'linux') {
      const info = await execWithTimeout('cat /proc/cpuinfo 2>/dev/null | grep "model name" | head -1', 3000);
      return info.split(':').slice(1).join(':').trim() || 'Unknown';
    }
    if (platform === 'win32') {
      // wmic is deprecated on Win 11 24H2+, use PowerShell as primary
      const psResult = await execWithTimeout(
        'powershell -NoProfile -Command "(Get-CimInstance Win32_Processor).Name"',
        5000,
      );
      if (psResult) return psResult;
      // Fallback to wmic for older Windows
      const wmicResult = await execWithTimeout('wmic cpu get name', 5000);
      return wmicResult
        .split('\n')
        .filter((l) => l.trim() && !l.includes('Name'))
        .join('')
        .trim() || 'Unknown';
    }
  } catch {
    // Fallback below
  }
  return os.cpus()[0]?.model ?? 'Unknown';
}

async function detectGPUs(platform: NodeJS.Platform, cpuArch: CPUArch): Promise<GPUInfo[]> {
  const gpus: GPUInfo[] = [];

  // Apple Silicon: GPU is integrated
  if (cpuArch === 'arm64' && platform === 'darwin') {
    gpus.push({
      vendor: 'apple',
      name: await detectAppleChip(),
      // Unified memory — GPU shares system RAM; ~70% available as GPU memory
      vramMB: Math.floor(os.totalmem() / 1024 / 1024 * 0.7),
    });
    return gpus;
  }

  // Windows on ARM (Snapdragon X Elite etc.)
  if (cpuArch === 'arm64' && platform === 'win32') {
    const gpu = await detectGPUWindows('qualcomm');
    if (gpu) gpus.push(gpu);
    // May also have a discrete GPU
  }

  // NVIDIA (Linux + Windows)
  const nvidiaGPUs = await detectNVIDIA(platform);
  gpus.push(...nvidiaGPUs);

  // AMD (Linux + Windows)
  const amdGPU = await detectAMD(platform);
  if (amdGPU) gpus.push(amdGPU);

  // Intel integrated + Arc (Linux + Windows)
  const intelGPU = await detectIntel(platform);
  if (intelGPU) gpus.push(intelGPU);

  if (gpus.length === 0) {
    gpus.push({ vendor: 'none', name: 'No GPU detected' });
  }

  return gpus;
}

async function detectAppleChip(): Promise<string> {
  try {
    const output = await execWithTimeout('sysctl -n machdep.cpu.brand_string', 3000);
    if (output.includes('Apple M')) {
      const match = output.match(/Apple (M\d+(?:\s\w+)?)/);
      return match ? `Apple ${match[1]} (Metal)` : 'Apple Silicon (Metal)';
    }
    return 'Apple Silicon (Metal)';
  } catch {
    return 'Apple Silicon (Metal)';
  }
}

/**
 * Detect Apple Silicon chip tier from CPU brand string.
 * Used for performance grading: M1 vs M2 Pro vs M3 Max etc.
 *
 * Chip tiers and approximate relative performance:
 *   M1 (8-core)        : baseline
 *   M1 Pro (10-core)   : ~1.5x
 *   M1 Max (10-core)   : ~2x (more GPU cores)
 *   M1 Ultra (20-core) : ~4x (dual-die)
 *   M2 (8-core)        : ~1.2x
 *   M2 Pro (10/12)     : ~1.7x
 *   M2 Max (12-core)   : ~2.3x
 *   M3 (8-core)        : ~1.4x
 *   M3 Pro (11/12)     : ~1.9x
 *   M3 Max (14/16)     : ~2.8x
 *   M4 (10-core)       : ~1.6x
 *   M4 Pro (12/14)     : ~2.1x
 */
function detectAppleTier(cpuModel: string): AppleTier {
  const m = cpuModel.toLowerCase().replace(/\s+/g, '-');
  // Match "Apple M3 Max" → "m3-max"
  const match = m.match(/apple-(m\d)(-?(pro|max|ultra))?/);
  if (!match) return 'unknown';
  const gen = match[1]; // m1, m2, m3, m4
  const tier = match[3]?.toLowerCase(); // pro, max, ultra, or undefined
  if (tier) {
    return `${gen}-${tier}` as AppleTier;
  }
  return gen as AppleTier;
}

/**
 * Detect performance/efficiency core topology for heterogeneous CPUs.
 * - Apple Silicon: M1 = 4P+4E, M1 Pro = 6P+2E (8), M1 Max = 8P+2E (10)
 * - Intel 12th+ (Alder Lake+): P-cores + E-cores
 * - AMD: usually homogeneous
 *
 * This helps set intraOpNumThreads to use only P-cores for inference,
 * avoiding E-core slowdown.
 */
function detectCoreTopology(
  cpuModel: string,
  cpuCores: number,
  platform: NodeJS.Platform,
): CoreTopology | undefined {
  const m = cpuModel.toLowerCase();

  // Apple Silicon known configurations
  if (platform === 'darwin' && m.includes('apple m')) {
    const tier = detectAppleTier(cpuModel);

    // M1 family
    if (tier === 'm1') return { performanceCores: 4, efficiencyCores: 4, total: 8 };
    if (tier === 'm1-pro') return { performanceCores: 6, efficiencyCores: 2, total: 8 };
    if (tier === 'm1-max') return { performanceCores: 8, efficiencyCores: 2, total: 10 };
    if (tier === 'm1-ultra') return { performanceCores: 16, efficiencyCores: 4, total: 20 };

    // M2 family
    if (tier === 'm2') return { performanceCores: 4, efficiencyCores: 4, total: 8 };
    if (tier === 'm2-pro') return { performanceCores: 6, efficiencyCores: 4, total: 10 };
    if (tier === 'm2-max') return { performanceCores: 8, efficiencyCores: 4, total: 12 };
    if (tier === 'm2-ultra') return { performanceCores: 16, efficiencyCores: 8, total: 24 };

    // M3 family
    if (tier === 'm3') return { performanceCores: 4, efficiencyCores: 4, total: 8 };
    if (tier === 'm3-pro') return { performanceCores: 5, efficiencyCores: 6, total: 11 };
    if (tier === 'm3-max') return { performanceCores: 12, efficiencyCores: 4, total: 16 };

    // M4 family
    if (tier === 'm4') return { performanceCores: 4, efficiencyCores: 6, total: 10 };
    if (tier === 'm4-pro') return { performanceCores: 8, efficiencyCores: 4, total: 12 };
    if (tier === 'm4-max') return { performanceCores: 12, efficiencyCores: 4, total: 16 };
  }

  // Intel 12th gen+ (Alder Lake and newer) — detect hybrid architecture
  // Intel P-cores have HyperThreading (2 threads per P-core), E-cores have 1
  if (platform !== 'darwin' && /intel/i.test(m)) {
    // Heuristic: if logical cores > physical cores * 1.5, likely hybrid
    // We can't perfectly detect from os.cpus() alone, so use model string
    if (/i[3579]-1[3-9]|i[3579]-2\d{3}/i.test(m)) {
      // 13th gen+ or 2000 series: likely hybrid
      // Rough estimate: 2/3 P-cores, 1/3 E-cores
      const pCores = Math.floor(cpuCores / 1.5); // Account for HT
      return {
        performanceCores: pCores,
        efficiencyCores: cpuCores - pCores,
        total: cpuCores,
      };
    }
  }

  // Homogeneous (AMD, older Intel, ARM server)
  return { performanceCores: cpuCores, efficiencyCores: 0, total: cpuCores };
}

async function detectNVIDIA(platform: NodeJS.Platform): Promise<GPUInfo[]> {
  if (platform !== 'linux' && platform !== 'win32') return [];
  try {
    const output = await execWithTimeout(
      'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader',
      5000,
    );
    if (!output || output.includes('not found')) return [];

    // Handle multi-GPU: one line per GPU
    return output.split('\n').map((line, idx) => {
      const parts = line.split(',').map((s) => s.trim());
      const name = parts[0] ?? 'NVIDIA GPU';
      const vramStr = parts[1] ?? '0';
      const vramMB = parseInt(vramStr.replace(/\D/g, '') || '0', 10);
      return { vendor: 'nvidia' as const, name, vramMB, deviceId: idx };
    });
  } catch {
    return [];
  }
}

async function detectAMD(platform: NodeJS.Platform): Promise<GPUInfo | null> {
  try {
    if (platform === 'linux') {
      const output = await execWithTimeout('lspci 2>/dev/null | grep -i "vga\\|display" | grep -i amd', 5000);
      if (output) {
        const name = output.split(':').slice(-1)[0]?.trim() || 'AMD GPU';
        return { vendor: 'amd', name };
      }
    }
    if (platform === 'win32') {
      const psResult = await execWithTimeout(
        'powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController).Name"',
        5000,
      );
      const text = psResult || await execWithTimeout('wmic path win32_VideoController get name', 5000);
      if (/amd|radeon/i.test(text)) {
        const name = text.split('\n').find((l) => /amd|radeon/i.test(l))?.trim() || 'AMD GPU';
        return { vendor: 'amd', name };
      }
    }
  } catch {
    // not available
  }
  return null;
}

async function detectIntel(platform: NodeJS.Platform): Promise<GPUInfo | null> {
  try {
    if (platform === 'linux') {
      const output = await execWithTimeout('lspci 2>/dev/null | grep -i "vga\\|display" | grep -i intel', 5000);
      if (output) {
        // Distinguish Arc (discrete) from integrated
        const isArc = /arc/i.test(output);
        return {
          vendor: 'intel',
          name: isArc ? 'Intel Arc GPU' : 'Intel Integrated Graphics',
        };
      }
    }
    if (platform === 'win32') {
      const psResult = await execWithTimeout(
        'powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController).Name"',
        5000,
      );
      const text = psResult || await execWithTimeout('wmic path win32_VideoController get name', 5000);
      if (/intel|arc|iris|uhd/i.test(text)) {
        const name = text.split('\n').find((l) => /intel|arc|iris|uhd/i.test(l))?.trim() || 'Intel GPU';
        const isArc = /arc/i.test(name);
        return { vendor: 'intel', name, ...(isArc ? {} : {}) };
      }
    }
  } catch {
    // not available
  }
  return null;
}

async function detectGPUWindows(vendor: 'qualcomm'): Promise<GPUInfo | null> {
  try {
    const output = await execWithTimeout(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController).Name"',
      5000,
    );
    if (/qualcomm|adreno|snapdragon/i.test(output)) {
      return { vendor, name: 'Qualcomm Adreno GPU (DirectML)' };
    }
  } catch {
    // not available
  }
  return null;
}

// ── EP Availability Probe ───────────────────────────────

/**
 * Verify that an execution provider is actually usable by creating a
 * throwaway ONNX session. This catches cases like:
 * - CUDA EP selected but CUDA toolkit not installed
 * - CoreML EP selected but onnxruntime-node built without it
 * - DirectML EP selected but no DX12 GPU driver
 */
let epProbeCache: Map<ExecutionProvider, boolean> = new Map();

export async function probeExecutionProvider(
  ep: ExecutionProvider,
  modelPath?: string,
): Promise<boolean> {
  if (epProbeCache.has(ep)) return epProbeCache.get(ep)!;

  let isAvailable = false;
  try {
    // Use a minimal ONNX model path if provided, otherwise just check
    // if onnxruntime-node can load with that EP
    const ort = await import('onnxruntime-node');
    if (modelPath) {
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: [ep],
        graphOptimizationLevel: 'disabled',
      });
      await session.release();
    } else {
      // No model to test with — assume available if the EP name is valid
      // Real validation happens when the actual model loads
      isAvailable = true;
    }
    isAvailable = true;
  } catch (e) {
    const msg = (e as Error).message ?? '';
    logger.debug('EP probe failed', {
      ep,
      reason: msg.slice(0, 80),
    });
    isAvailable = false;
  }

  epProbeCache.set(ep, isAvailable);
  return isAvailable;
}

/**
 * Reset EP probe cache (e.g., after unload to allow re-probing).
 */
export function resetEPProbeCache(): void {
  epProbeCache = new Map();
}

// ── Runtime Config Recommendation ───────────────────────

export async function recommendRuntime(hw: HardwareProfile): Promise<RuntimeConfig> {
  const notes: string[] = [];

  // Helper: compute optimal thread count using P-core topology
  const optimalThreads = (fallback?: number): number => {
    if (hw.coreTopology && hw.coreTopology.performanceCores > 0) {
      // Use P-cores only — E-cores slow down matrix ops
      return hw.coreTopology.performanceCores;
    }
    return Math.max(1, Math.min(fallback ?? hw.cpuCores, 8));
  };

  // ── Apple Silicon → CoreML ──
  if (hw.hasCoreML) {
    const tier = hw.appleTier ?? 'unknown';
    const tierName = tier === 'unknown' ? (hw.gpus[0]?.name ?? 'Apple Silicon') : tier.toUpperCase();
    notes.push(`Apple Silicon detected: ${tierName}`);

    // Performance grading based on chip tier
    const isLowEnd = ['m1', 'm2'].includes(tier) && hw.totalMemoryMB < 16384;
    const isMidTier = ['m1-pro', 'm2-pro', 'm3', 'm3-pro', 'm4', 'm4-pro'].includes(tier);
    const isHighTier = ['m1-max', 'm2-max', 'm3-max', 'm4-max', 'm1-ultra', 'm2-ultra'].includes(tier);

    // Unified memory: GPU gets ~60% (shared with CPU)
    const gpuMemoryBudget = Math.floor(hw.totalMemoryMB * 0.6);
    notes.push(`Unified memory: ${hw.totalMemoryMB}MB total, ~${gpuMemoryBudget}MB for GPU`);

    // dtype: q4 for low-end, fp16 for mid+, fp16 for high (ample memory)
    const dtype: DTypeConfig = isLowEnd
      ? { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'q4' }
      : { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'fp16' };

    // Token limit: higher tiers get more
    const maxTokens = isHighTier ? 512 : isMidTier ? 384 : 256;
    notes.push(`CoreML EP, dtype: decoder=${dtype.decoder_model_merged}, maxTokens=${maxTokens}`);

    // Fallback chain: CoreML/fp16 → CoreML/q4 → CPU/fp16 → CPU/q4
    const fp16Dtype: DTypeConfig = { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'fp16' };
    const q4Dtype: DTypeConfig = { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'q4' };

    return {
      provider: 'coreml',
      fallback: 'cpu',
      fallbackChain: [
        { provider: 'coreml', dtype: fp16Dtype, label: 'CoreML + fp16' },
        { provider: 'coreml', dtype: q4Dtype, label: 'CoreML + q4' },
        { provider: 'cpu', dtype: fp16Dtype, label: 'CPU + fp16' },
        { provider: 'cpu', dtype: q4Dtype, label: 'CPU + q4' },
      ],
      threads: optimalThreads(),
      graphOptimizationLevel: 'disabled', // SmolVLM LayerNorm fusion bug
      memoryLimitMB: gpuMemoryBudget,
      recommendedMaxTokens: maxTokens,
      dtype,
      notes,
    };
  }

  // ── NVIDIA GPU → CUDA ──
  if (hw.hasCUDA) {
    // Pick the GPU with most VRAM if multiple
    const nvidiaGPUs = hw.gpus.filter((g) => g.vendor === 'nvidia');
    const bestGPU = nvidiaGPUs.sort((a, b) => (b.vramMB ?? 0) - (a.vramMB ?? 0))[0];
    const vramMB = bestGPU?.vramMB ?? 4096;
    const deviceId = bestGPU?.deviceId ?? 0;

    notes.push(`NVIDIA GPU detected: ${bestGPU?.name} (${vramMB}MB VRAM, device ${deviceId})`);
    if (nvidiaGPUs.length > 1) {
      notes.push(`Multi-GPU: ${nvidiaGPUs.length} GPUs found, selected device ${deviceId} (highest VRAM)`);
    }

    // dtype based on VRAM budget (model needs ~1.2GB fp16, ~500MB q4)
    const fp16Dtype: DTypeConfig = { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'fp16' };
    const q4Dtype: DTypeConfig = { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'q4' };
    const dtype = vramMB >= 4096 ? fp16Dtype : q4Dtype;
    const maxTokens = vramMB >= 8192 ? 512 : 256;
    notes.push(`CUDA EP, dtype: decoder=${dtype.decoder_model_merged}, maxTokens=${maxTokens}`);

    return {
      provider: 'cuda',
      fallback: 'cpu',
      fallbackChain: [
        { provider: 'cuda', dtype: fp16Dtype, label: 'CUDA + fp16' },
        { provider: 'cuda', dtype: q4Dtype, label: 'CUDA + q4' },
        { provider: 'cpu', dtype: fp16Dtype, label: 'CPU + fp16' },
        { provider: 'cpu', dtype: q4Dtype, label: 'CPU + q4' },
      ],
      threads: optimalThreads(),
      graphOptimizationLevel: 'disabled',
      memoryLimitMB: Math.min(vramMB, Math.floor(hw.totalMemoryMB * 0.6)),
      recommendedMaxTokens: maxTokens,
      dtype,
      notes,
    };
  }

  // ── AMD / Intel / Qualcomm GPU on Windows → DirectML ──
  if (hw.hasDirectML) {
    const gpu = hw.gpus.find((g) => ['amd', 'intel', 'qualcomm'].includes(g.vendor));
    notes.push(`${gpu?.vendor?.toUpperCase()} GPU on Windows: ${gpu?.name}`);
    notes.push('Using DirectML execution provider');

    const fp16Dtype: DTypeConfig = { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'fp16' };
    const q4Dtype: DTypeConfig = { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'q4' };

    return {
      provider: 'directml',
      fallback: 'cpu',
      fallbackChain: [
        { provider: 'directml', dtype: q4Dtype, label: 'DirectML + q4' },
        { provider: 'directml', dtype: fp16Dtype, label: 'DirectML + fp16' },
        { provider: 'cpu', dtype: q4Dtype, label: 'CPU + q4' },
      ],
      threads: optimalThreads(6),
      graphOptimizationLevel: 'disabled',
      memoryLimitMB: Math.floor(hw.totalMemoryMB * 0.5),
      recommendedMaxTokens: 128,
      dtype: q4Dtype, // Default to q4 — DirectML works better with smaller models
      notes,
    };
  }

  // ── CPU only ──
  notes.push('No GPU acceleration detected: using CPU execution provider with multi-threading');

  if (hw.coreTopology && hw.coreTopology.efficiencyCores > 0) {
    notes.push(
      `Heterogeneous CPU: ${hw.coreTopology.performanceCores}P + ${hw.coreTopology.efficiencyCores}E cores, using ${hw.coreTopology.performanceCores} P-core threads`,
    );
  } else if (hw.cpuCores >= 8) {
    notes.push(`High core count (${hw.cpuCores}): enabling ${optimalThreads()} threads`);
  } else if (hw.cpuCores <= 4) {
    notes.push(`Low core count (${hw.cpuCores}): reducing max tokens for responsiveness`);
  }

  const isLowMemory = hw.availableMemoryMB < 2048;
  if (isLowMemory) {
    notes.push(`Low available memory (${hw.availableMemoryMB}MB): using q4 quantization + reduced max tokens`);
  }

  // CPU: always q4 decoder (memory-constrained)
  const q4Dtype: DTypeConfig = { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'q4' };
  const fp16Dtype: DTypeConfig = { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'fp16' };
  notes.push(`dtype: decoder=${q4Dtype.decoder_model_merged}`);

  return {
    provider: 'cpu',
    fallback: 'cpu',
    fallbackChain: [
      { provider: 'cpu', dtype: q4Dtype, label: 'CPU + q4' },
      { provider: 'cpu', dtype: fp16Dtype, label: 'CPU + fp16 (fallback)' },
    ],
    threads: optimalThreads(),
    graphOptimizationLevel: 'disabled',
    memoryLimitMB: Math.floor(hw.totalMemoryMB * 0.5),
    recommendedMaxTokens: isLowMemory ? 32 : hw.cpuCores <= 4 ? 48 : 128,
    dtype: q4Dtype,
    notes,
  };
}

// ── ONNX Runtime Session Options ────────────────────────

export function buildSessionOptions(
  rt: RuntimeConfig,
): Record<string, unknown> {
  const providers: string[] = [rt.provider, rt.fallback].filter(
    (p, i, arr) => arr.indexOf(p) === i,
  );

  return {
    executionProviders: providers,
    intraOpNumThreads: rt.threads,
    interOpNumThreads: Math.max(1, Math.floor(rt.threads / 2)),
    graphOptimizationLevel: rt.graphOptimizationLevel,
    enableMemPattern: true,
    enableCpuMemArena: rt.provider === 'cpu',
  };
}

// ── One-shot init ───────────────────────────────────────

let cachedConfig: RuntimeConfig | null = null;

export async function getRuntimeConfig(force = false): Promise<RuntimeConfig> {
  if (cachedConfig && !force) return cachedConfig;
  const hw = await detectHardware(force);
  cachedConfig = await recommendRuntime(hw);
  for (const note of cachedConfig.notes) {
    logger.info('Runtime recommendation', { note });
  }
  return cachedConfig;
}

/**
 * Reset all caches — call after unload or when hardware may have changed.
 */
export function resetRuntimeCache(): void {
  cachedProfile = null;
  cachedConfig = null;
  cacheTimestamp = 0;
  resetEPProbeCache();
}
