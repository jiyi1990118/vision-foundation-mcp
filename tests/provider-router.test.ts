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

    it('falls back when explicit provider lacks memory', () => {
      const choice = chooseProvider({
        candidates: [ggufCandidate, highQualityCandidate],
        options: { provider: 'minicpm-v' },
        resources: { memoryAvailableMB: 512, hasGPU: true },
        requestedSkills: ['classify'],
      });
      expect(choice.name).toBe('gguf-smolvlm');
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
  });
});
