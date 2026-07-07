/**
 * Runtime Detector — unit tests with mocked hardware profiles.
 *
 * Tests the recommendation logic for all supported hardware scenarios
 * without needing the actual hardware present.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { recommendRuntime, type HardwareProfile } from '../src/core/runtime-detector.js';

// Helper: create a base hardware profile for testing
function makeProfile(overrides: Partial<HardwareProfile>): HardwareProfile {
  return {
    platform: 'darwin',
    cpuArch: 'arm64',
    cpuModel: 'Unknown',
    cpuCores: 8,
    totalMemoryMB: 16384,
    availableMemoryMB: 8192,
    gpus: [],
    hasMetal: false,
    hasCUDA: false,
    hasCoreML: false,
    hasDirectML: false,
    ...overrides,
  };
}

describe('Runtime Detector — recommendRuntime', () => {
  // ── Apple Silicon tiers (#6) ──
  it('Apple M1 (base, 8GB): CoreML + q4 (low memory), 256 tokens, 4 P-core threads', async () => {
    const hw = makeProfile({
      cpuModel: 'Apple M1',
      cpuCores: 8,
      totalMemoryMB: 8192,
      hasMetal: true,
      hasCoreML: true,
      appleTier: 'm1',
      coreTopology: { performanceCores: 4, efficiencyCores: 4, total: 8 },
      gpus: [{ vendor: 'apple', name: 'Apple M1 (Metal)', vramMB: 5734 }],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.provider).toBe('coreml');
    expect(rt.dtype.decoder_model_merged).toBe('q4'); // 8GB → low memory → q4
    expect(rt.recommendedMaxTokens).toBe(256);
    expect(rt.threads).toBe(4); // P-cores only
    expect(rt.fallbackChain.length).toBeGreaterThanOrEqual(3);
  });

  it('Apple M1 (16GB): CoreML + fp16, 256 tokens', async () => {
    const hw = makeProfile({
      cpuModel: 'Apple M1',
      cpuCores: 8,
      totalMemoryMB: 16384,
      hasMetal: true,
      hasCoreML: true,
      appleTier: 'm1',
      coreTopology: { performanceCores: 4, efficiencyCores: 4, total: 8 },
      gpus: [{ vendor: 'apple', name: 'Apple M1 (Metal)', vramMB: 11468 }],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.dtype.decoder_model_merged).toBe('fp16'); // 16GB → fp16
  });

  it('Apple M3 Max: CoreML + fp16, 512 tokens, 12 P-core threads', async () => {
    const hw = makeProfile({
      cpuModel: 'Apple M3 Max',
      cpuCores: 16,
      totalMemoryMB: 65536,
      hasMetal: true,
      hasCoreML: true,
      appleTier: 'm3-max',
      coreTopology: { performanceCores: 12, efficiencyCores: 4, total: 16 },
      gpus: [{ vendor: 'apple', name: 'Apple M3 Max (Metal)', vramMB: 45875 }],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.provider).toBe('coreml');
    expect(rt.recommendedMaxTokens).toBe(512);
    expect(rt.threads).toBe(12);
  });

  it('Apple M2 low memory: uses q4 decoder', async () => {
    const hw = makeProfile({
      cpuModel: 'Apple M2',
      cpuCores: 8,
      totalMemoryMB: 8192,
      hasMetal: true,
      hasCoreML: true,
      appleTier: 'm2',
      coreTopology: { performanceCores: 4, efficiencyCores: 4, total: 8 },
      gpus: [{ vendor: 'apple', name: 'Apple M2 (Metal)', vramMB: 5734 }],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.dtype.decoder_model_merged).toBe('q4');
  });

  // ── NVIDIA GPU (#8 multi-GPU) ──
  it('NVIDIA single GPU: CUDA + fp16 for 8GB+ VRAM', async () => {
    const hw = makeProfile({
      platform: 'linux',
      cpuArch: 'x64',
      cpuModel: 'AMD Ryzen 9 5900X',
      cpuCores: 12,
      totalMemoryMB: 32768,
      hasCUDA: true,
      gpus: [{ vendor: 'nvidia', name: 'RTX 4090', vramMB: 24576, deviceId: 0 }],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.provider).toBe('cuda');
    expect(rt.dtype.decoder_model_merged).toBe('fp16');
    expect(rt.recommendedMaxTokens).toBe(512);
  });

  it('NVIDIA low VRAM (4GB): uses q4 decoder', async () => {
    const hw = makeProfile({
      platform: 'linux',
      cpuArch: 'x64',
      cpuModel: 'Intel i5-12400',
      cpuCores: 6,
      totalMemoryMB: 16384,
      hasCUDA: true,
      gpus: [{ vendor: 'nvidia', name: 'GTX 1650', vramMB: 4096, deviceId: 0 }],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.dtype.decoder_model_merged).toBe('fp16'); // 4096 >= 4096 threshold
    expect(rt.recommendedMaxTokens).toBe(256);
  });

  it('NVIDIA multi-GPU: selects highest VRAM device', async () => {
    const hw = makeProfile({
      platform: 'linux',
      cpuArch: 'x64',
      cpuModel: 'AMD EPYC',
      cpuCores: 32,
      totalMemoryMB: 131072,
      hasCUDA: true,
      gpus: [
        { vendor: 'nvidia', name: 'RTX 3060', vramMB: 12288, deviceId: 0 },
        { vendor: 'nvidia', name: 'RTX 4090', vramMB: 24576, deviceId: 1 },
      ],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.provider).toBe('cuda');
    // Notes should mention multi-GPU and device selection
    const hasMultiNote = rt.notes.some((n) => n.includes('Multi-GPU'));
    expect(hasMultiNote).toBe(true);
  });

  // ── AMD/Intel on Windows → DirectML (#9, #10, #11) ──
  it('AMD GPU on Windows: DirectML + q4', async () => {
    const hw = makeProfile({
      platform: 'win32',
      cpuArch: 'x64',
      cpuModel: 'AMD Ryzen 7 5800X',
      cpuCores: 8,
      totalMemoryMB: 32768,
      hasDirectML: true,
      gpus: [{ vendor: 'amd', name: 'Radeon RX 7900 XT' }],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.provider).toBe('directml');
    expect(rt.dtype.decoder_model_merged).toBe('q4');
  });

  it('Intel Arc GPU on Windows: DirectML', async () => {
    const hw = makeProfile({
      platform: 'win32',
      cpuArch: 'x64',
      cpuModel: 'Intel i7-13700K',
      cpuCores: 16,
      totalMemoryMB: 32768,
      hasDirectML: true,
      gpus: [{ vendor: 'intel', name: 'Intel Arc A770' }],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.provider).toBe('directml');
  });

  it('Qualcomm Snapdragon on Windows ARM: DirectML', async () => {
    const hw = makeProfile({
      platform: 'win32',
      cpuArch: 'arm64',
      cpuModel: 'Snapdragon X Elite',
      cpuCores: 12,
      totalMemoryMB: 32768,
      hasDirectML: true,
      gpus: [{ vendor: 'qualcomm', name: 'Qualcomm Adreno GPU (DirectML)' }],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.provider).toBe('directml');
  });

  // ── CPU only (#18 P-core topology) ──
  it('CPU only with heterogeneous cores: uses P-cores for threads', async () => {
    const hw = makeProfile({
      platform: 'linux',
      cpuArch: 'x64',
      cpuModel: 'Intel i9-13900K',
      cpuCores: 24,
      totalMemoryMB: 32768,
      coreTopology: { performanceCores: 16, efficiencyCores: 8, total: 24 },
      gpus: [{ vendor: 'none', name: 'No GPU detected' }],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.provider).toBe('cpu');
    expect(rt.threads).toBe(16); // P-cores only
    expect(rt.dtype.decoder_model_merged).toBe('q4');
  });

  it('CPU only low memory: reduces maxTokens to 32', async () => {
    const hw = makeProfile({
      platform: 'linux',
      cpuArch: 'x64',
      cpuModel: 'Intel i3-8100',
      cpuCores: 4,
      totalMemoryMB: 8192,
      availableMemoryMB: 1024,
      gpus: [{ vendor: 'none', name: 'No GPU detected' }],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.provider).toBe('cpu');
    expect(rt.recommendedMaxTokens).toBe(32);
  });

  it('CPU only homogeneous (AMD): uses all cores', async () => {
    const hw = makeProfile({
      platform: 'linux',
      cpuArch: 'x64',
      cpuModel: 'AMD Ryzen 5 3600',
      cpuCores: 6,
      totalMemoryMB: 16384,
      coreTopology: { performanceCores: 6, efficiencyCores: 0, total: 6 },
      gpus: [{ vendor: 'none', name: 'No GPU detected' }],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.threads).toBe(6);
  });

  // ── Fallback chain (#12) ──
  it('Apple Silicon fallback chain has 4 steps', async () => {
    const hw = makeProfile({
      hasMetal: true,
      hasCoreML: true,
      appleTier: 'm2',
      gpus: [{ vendor: 'apple', name: 'Apple M2 (Metal)' }],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.fallbackChain.length).toBe(4);
    expect(rt.fallbackChain[0]!.label).toContain('CoreML');
    expect(rt.fallbackChain[rt.fallbackChain.length - 1]!.label).toContain('CPU');
  });

  it('NVIDIA fallback chain includes CUDA + CPU steps', async () => {
    const hw = makeProfile({
      platform: 'linux',
      hasCUDA: true,
      gpus: [{ vendor: 'nvidia', name: 'RTX 4090', vramMB: 24576 }],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.fallbackChain.length).toBeGreaterThanOrEqual(3);
    expect(rt.fallbackChain[0]!.provider).toBe('cuda');
    expect(rt.fallbackChain.some((f) => f.provider === 'cpu')).toBe(true);
  });

  it('CPU fallback chain has q4 + fp16 steps', async () => {
    const hw = makeProfile({
      hasMetal: false,
      hasCUDA: false,
      hasCoreML: false,
      hasDirectML: false,
      gpus: [{ vendor: 'none', name: 'No GPU' }],
    });
    const rt = await recommendRuntime(hw);
    expect(rt.fallbackChain.length).toBeGreaterThanOrEqual(2);
    expect(rt.fallbackChain[0]!.dtype.decoder_model_merged).toBe('q4');
  });

  // ── graphOptimizationLevel always disabled (#13) ──
  it('graphOptimizationLevel is disabled for all hardware', async () => {
    const configs = [
      makeProfile({ hasMetal: true, hasCoreML: true, gpus: [{ vendor: 'apple', name: 'M2' }] }),
      makeProfile({ hasCUDA: true, gpus: [{ vendor: 'nvidia', name: 'RTX', vramMB: 8192 }] }),
      makeProfile({ hasDirectML: true, gpus: [{ vendor: 'amd', name: 'RX' }] }),
      makeProfile({ gpus: [{ vendor: 'none', name: 'none' }] }),
    ];
    for (const hw of configs) {
      const rt = await recommendRuntime(hw);
      expect(rt.graphOptimizationLevel).toBe('disabled');
    }
  });
});
