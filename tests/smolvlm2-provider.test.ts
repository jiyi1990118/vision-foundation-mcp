import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { SmolVLM2Provider } from '../src/providers/smolvlm2/provider.js';
import { listSkills } from '../src/skills/registry.js';

describe('SmolVLM2 GGUF provider', () => {
  it('declares identity for the fast replacement tier', () => {
    const p = new SmolVLM2Provider();
    expect(p.name).toBe('gguf-smolvlm2');
    expect(p.runtime).toBe('llama-cpp');
    expect(p.supportedRuntimes).toContain('llama-cpp');
  });

  it('declares fast-provider resource requirements', () => {
    const p = new SmolVLM2Provider();
    expect(p.requirements.minMemoryMB).toBeLessThanOrEqual(1024);
    expect(p.requirements.gpuRequired).toBe(false);
    expect(p.requirements.modelSizeMB).toBeGreaterThan(0);
  });

  it('supports every registered runtime skill', () => {
    const p = new SmolVLM2Provider();
    const registeredSkills = listSkills().map((s) => s.name).sort();
    expect([...p.supportedSkills].sort()).toEqual(registeredSkills);
  });

  it('starts unloaded and reports isLoaded=false', () => {
    const p = new SmolVLM2Provider();
    expect(p.isLoaded()).toBe(false);
  });

  it('preserves enough detail for wide requirement screenshots', async () => {
    const p = new SmolVLM2Provider();
    const input = await sharp({
      create: {
        width: 2658,
        height: 1164,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    }).png().toBuffer();

    const optimized = await (p as unknown as {
      optimizeImage(image: { buffer: Buffer; mimeType: string; source: string; size: number }): Promise<{ buffer: Buffer }>;
    }).optimizeImage({
      buffer: input,
      mimeType: 'image/png',
      source: 'requirement-ui-screenshot',
      size: input.length,
    });

    const meta = await sharp(optimized.buffer).metadata();
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(448);
  });

  it('allows longer default descriptions for screenshot analysis', async () => {
    const p = new SmolVLM2Provider();
    let capturedMaxTokens = 0;

    (p as unknown as { loaded: boolean }).loaded = true;
    (p as unknown as {
      server: { inferWithRetry: (body: { max_tokens: number }) => Promise<{ choices: { message: { content: string } }[] }> };
    }).server = {
      async inferWithRetry(body) {
        capturedMaxTokens = body.max_tokens;
        return { choices: [{ message: { content: '{"description":"ok"}' } }] };
      },
    };

    const input = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    }).png().toBuffer();

    await p.infer({
      image: { buffer: input, mimeType: 'image/png', source: 'tiny', size: input.length },
      prompt: 'Analyze this requirement screenshot in detail',
      maxTokens: 1200,
      temperature: 0,
      cache: false,
    });

    expect(capturedMaxTokens).toBe(768);
  });
});
