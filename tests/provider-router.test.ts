import { describe, expect, it } from 'vitest';
import { chooseProvider, type ProviderCandidate, providerToCandidate } from '../src/core/provider-router.js';
import { GGUFProvider } from '../src/providers/gguf/provider.js';
import { MiniCPMProvider } from '../src/providers/minicpm/provider.js';
import { SmolVLM2Provider } from '../src/providers/smolvlm2/provider.js';

const ggufCandidate: ProviderCandidate = {
  name: 'gguf-smolvlm',
  runtime: 'llama-cpp',
  quality: 'fast',
  minMemoryMB: 512,
  gpuPreferred: false,
  supportedSkills: ['classify', 'ocr', 'summary', 'table', 'document', 'poster', 'moderation', 'layout'],
};

const highQualityCandidate: ProviderCandidate = {
  name: 'minicpm-v',
  runtime: 'llama-cpp',
  quality: 'high',
  minMemoryMB: 4096,
  gpuPreferred: true,
  supportedSkills: ['classify', 'ocr', 'summary', 'table', 'document', 'poster', 'moderation', 'layout'],
};

const ocrCandidate: ProviderCandidate = {
  name: 'ppu-paddle-ocr',
  runtime: 'native-ocr',
  quality: 'fast',
  minMemoryMB: 256,
  gpuPreferred: false,
  supportedSkills: ['ocr'],
};

describe('provider-router', () => {
  describe('chooseProvider', () => {
    it('returns the only candidate when one is available', () => {
      const choice = chooseProvider({
        candidates: [ggufCandidate],
        options: {},
        resources: { memoryAvailableMB: 8192, hasGPU: true },
        requestedSkills: ['classify'],
      });
      expect(choice.name).toBe('gguf-smolvlm');
    });

    it('prefers high-quality provider when quality=high and resources allow', () => {
      const choice = chooseProvider({
        candidates: [ggufCandidate, highQualityCandidate],
        options: { quality: 'high' },
        resources: { memoryAvailableMB: 8192, hasGPU: true },
        requestedSkills: ['classify'],
      });
      expect(choice.name).toBe('minicpm-v');
    });

    it('uses total memory for GPU-preferred providers when available memory is transiently low', () => {
      const choice = chooseProvider({
        candidates: [ggufCandidate, highQualityCandidate],
        options: { quality: 'high' },
        resources: { memoryAvailableMB: 64, totalMemoryMB: 16384, hasGPU: true },
        requestedSkills: ['classify'],
      });
      expect(choice.name).toBe('minicpm-v');
    });

    it('falls back to fast provider when quality=high but memory insufficient', () => {
      const choice = chooseProvider({
        candidates: [ggufCandidate, highQualityCandidate],
        options: { quality: 'high' },
        resources: { memoryAvailableMB: 1024, hasGPU: true },
        requestedSkills: ['classify'],
      });
      expect(choice.name).toBe('gguf-smolvlm');
    });

    it('falls back to fast provider when quality=high but GPU missing', () => {
      const choice = chooseProvider({
        candidates: [ggufCandidate, highQualityCandidate],
        options: { quality: 'high' },
        resources: { memoryAvailableMB: 8192, hasGPU: false },
        requestedSkills: ['classify'],
      });
      expect(choice.name).toBe('gguf-smolvlm');
    });

    it('respects explicit options.provider when candidate exists and resources allow', () => {
      const choice = chooseProvider({
        candidates: [ggufCandidate, highQualityCandidate],
        options: { provider: 'minicpm-v' },
        resources: { memoryAvailableMB: 8192, hasGPU: true },
        requestedSkills: ['classify'],
      });
      expect(choice.name).toBe('minicpm-v');
    });

    it('throws when explicit provider lacks memory', () => {
      expect(() => chooseProvider({
        candidates: [ggufCandidate, highQualityCandidate],
        options: { provider: 'minicpm-v' },
        resources: { memoryAvailableMB: 512, hasGPU: true },
        requestedSkills: ['classify'],
      })).toThrow(/requested provider/i);
    });

    it('throws when explicit provider is unknown', () => {
      expect(() => chooseProvider({
        candidates: [ggufCandidate, highQualityCandidate],
        options: { provider: 'missing-provider' },
        resources: { memoryAvailableMB: 8192, hasGPU: true },
        requestedSkills: ['classify'],
      })).toThrow(/requested provider/i);
    });

    it('filters candidates by required skills', () => {
      const limitedCandidate: ProviderCandidate = {
        name: 'ocr-only',
        runtime: 'onnx',
        quality: 'fast',
        minMemoryMB: 256,
        gpuPreferred: false,
        supportedSkills: ['ocr'],
      };
      const choice = chooseProvider({
        candidates: [limitedCandidate, ggufCandidate],
        options: {},
        resources: { memoryAvailableMB: 8192, hasGPU: true },
        requestedSkills: ['classify', 'summary'],
      });
      expect(choice.name).toBe('gguf-smolvlm');
    });

    it('throws when no candidate can satisfy the required skills', () => {
      expect(() =>
        chooseProvider({
          candidates: [],
          options: {},
          resources: { memoryAvailableMB: 8192, hasGPU: true },
          requestedSkills: ['classify'],
        }),
      ).toThrow(/no provider/i);
    });

    it('routes quality=high to MiniCPM-V built from the real provider', () => {
      const gguf = providerToCandidate(new GGUFProvider());
      const minicpm = providerToCandidate(new MiniCPMProvider());
      expect(minicpm.quality).toBe('high');
      expect(minicpm.minMemoryMB).toBeGreaterThanOrEqual(gguf.minMemoryMB);

      const choice = chooseProvider({
        candidates: [gguf, minicpm],
        options: { quality: 'high' },
        resources: { memoryAvailableMB: 8192, hasGPU: true },
        requestedSkills: ['classify'],
      });
      expect(choice.name).toBe('minicpm-v');
    });

    it('maps SmolVLM2 provider as a fast candidate', () => {
      const candidate = providerToCandidate(new SmolVLM2Provider());
      expect(candidate.name).toBe('gguf-smolvlm2');
      expect(candidate.quality).toBe('fast');
      expect(candidate.gpuPreferred).toBe(false);
    });

    it('prefers a dedicated OCR provider for OCR-only requests', () => {
      const choice = chooseProvider({
        candidates: [ggufCandidate, ocrCandidate],
        options: {},
        resources: { memoryAvailableMB: 8192, hasGPU: false },
        requestedSkills: ['ocr'],
      });
      expect(choice.name).toBe('ppu-paddle-ocr');
    });

    it('keeps a VLM provider for mixed OCR and visual understanding requests', () => {
      const choice = chooseProvider({
        candidates: [ocrCandidate, ggufCandidate],
        options: {},
        resources: { memoryAvailableMB: 8192, hasGPU: false },
        requestedSkills: ['classify', 'ocr', 'summary'],
      });
      expect(choice.name).toBe('gguf-smolvlm');
    });

    it('allows explicitly selecting a dedicated OCR provider for OCR-only requests', () => {
      const choice = chooseProvider({
        candidates: [ggufCandidate, ocrCandidate],
        options: { provider: 'ppu-paddle-ocr' },
        resources: { memoryAvailableMB: 8192, hasGPU: false },
        requestedSkills: ['ocr'],
      });
      expect(choice.name).toBe('ppu-paddle-ocr');
    });
  });
});
