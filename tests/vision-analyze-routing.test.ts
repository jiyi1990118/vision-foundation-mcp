import { describe, expect, it } from 'vitest';
import { selectProvider } from '../src/tools/vision-analyze.js';
import type { VisionProvider } from '../src/providers/types.js';
import type { ImageInput, InferenceResponse, InferenceRequest } from '../src/types/domain.js';

function fakeProvider(opts: {
  name: string;
  runtime: string;
  minMemoryMB: number;
  gpuRequired: boolean;
  skills?: string[];
}): VisionProvider {
  return {
    name: opts.name,
    runtime: opts.runtime,
    supportedRuntimes: [opts.runtime],
    supportedSkills: opts.skills ?? ['classify', 'ocr', 'summary'],
    requirements: { minMemoryMB: opts.minMemoryMB, gpuRequired: opts.gpuRequired, modelSizeMB: 100 },
    async load() {},
    async infer(_req: InferenceRequest): Promise<InferenceResponse> {
      return { text: opts.name, duration: 1 };
    },
    async unload() {},
    isLoaded() { return true; },
  };
}

const gguf = fakeProvider({ name: 'gguf-smolvlm', runtime: 'llama-cpp', minMemoryMB: 512, gpuRequired: false });
const minicpm = fakeProvider({ name: 'minicpm-v', runtime: 'llama-cpp', minMemoryMB: 4096, gpuRequired: true });

const goodResources = { memoryAvailableMB: 8192, hasGPU: true };

describe('selectProvider (vision-analyze routing)', () => {
  it('returns the fast provider by default', () => {
    const p = selectProvider([gguf, minicpm], { options: {}, resources: goodResources, requestedSkills: ['classify'] });
    expect(p.name).toBe('gguf-smolvlm');
  });

  it('returns the high-quality provider when quality=high and resources allow', () => {
    const p = selectProvider([gguf, minicpm], { options: { quality: 'high' }, resources: goodResources, requestedSkills: ['classify'] });
    expect(p.name).toBe('minicpm-v');
  });

  it('falls back to fast provider when quality=high but GPU missing', () => {
    const p = selectProvider([gguf, minicpm], {
      options: { quality: 'high' },
      resources: { memoryAvailableMB: 8192, hasGPU: false },
      requestedSkills: ['classify'],
    });
    expect(p.name).toBe('gguf-smolvlm');
  });

  it('respects explicit options.provider', () => {
    const p = selectProvider([gguf, minicpm], {
      options: { provider: 'minicpm-v' },
      resources: goodResources,
      requestedSkills: ['classify'],
    });
    expect(p.name).toBe('minicpm-v');
  });

  it('falls back when only one candidate is registered', () => {
    const p = selectProvider([gguf], { options: { quality: 'high' }, resources: goodResources, requestedSkills: ['classify'] });
    expect(p.name).toBe('gguf-smolvlm');
  });
});