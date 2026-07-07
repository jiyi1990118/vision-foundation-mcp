import { describe, expect, it } from 'vitest';
import { SkillPipeline } from '../src/core/skill-pipeline.js';
import type { VisionProvider } from '../src/providers/types.js';
import type { ExecutionPlan } from '../src/types/skills.js';
import type { ImageInput, InferenceRequest, InferenceResponse } from '../src/types/domain.js';

class RecordingProvider implements VisionProvider {
  readonly name = 'recording';
  readonly runtime = 'test';
  readonly supportedRuntimes = ['test'];
  readonly supportedSkills = ['summary'];
  readonly requirements = { minMemoryMB: 0, gpuRequired: false, modelSizeMB: 0 };
  requests: InferenceRequest[] = [];

  async load(): Promise<void> {}
  async unload(): Promise<void> {}
  isLoaded(): boolean { return true; }
  async infer(req: InferenceRequest): Promise<InferenceResponse> {
    this.requests.push(req);
    return { text: 'plain summary', duration: 1 };
  }
}

const image: ImageInput = {
  buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  mimeType: 'image/png',
  source: 'test',
  size: 4,
};

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    provider: 'recording',
    runtime: 'test',
    preprocess: [],
    skills: [
      {
        skill: 'summary',
        prompt: 'Summarize',
        schema: { required: ['description'] },
        priority: 0,
      },
    ],
    postprocess: ['merge'],
    cacheKey: 'test',
    timeout: 30000,
    retry: { max: 0, strategy: 'none' },
    ...overrides,
  };
}

describe('request option propagation', () => {
  it('passes plan maxTokens to provider inference requests', async () => {
    const provider = new RecordingProvider();
    const pipeline = new SkillPipeline(provider);

    await pipeline.execute(makePlan({ maxTokens: 42 }), image);

    expect(provider.requests[0]?.maxTokens).toBe(42);
  });

  it('passes plan cache flag to provider inference requests', async () => {
    const provider = new RecordingProvider();
    const pipeline = new SkillPipeline(provider);

    await pipeline.execute(makePlan({ cache: false }), image);

    expect(provider.requests[0]?.cache).toBe(false);
  });
});
