import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { MiniCPMProvider } from '../src/providers/minicpm/provider.js';
import { GGUFProvider } from '../src/providers/gguf/provider.js';
import { listSkills } from '../src/skills/registry.js';

describe('MiniCPM-V provider skeleton', () => {
  it('declares identity for high-quality routing tier', () => {
    const p = new MiniCPMProvider();
    expect(p.name).toBe('minicpm-v');
    expect(p.runtime).toBe('llama-cpp');
    expect(p.supportedRuntimes).toContain('llama-cpp');
  });

  it('declares higher resource requirements than the fast GGUF provider', () => {
    const p = new MiniCPMProvider();
    const fast = new GGUFProvider();
    expect(p.requirements.minMemoryMB).toBeGreaterThanOrEqual(fast.requirements.minMemoryMB);
    expect(p.requirements.gpuRequired).toBe(true);
    expect(p.requirements.modelSizeMB).toBeGreaterThan(0);
  });

  it('supports every registered runtime skill', () => {
    const p = new MiniCPMProvider();
    const registeredSkills = listSkills().map((s) => s.name).sort();
    expect([...p.supportedSkills].sort()).toEqual(registeredSkills);
  });

  it('starts unloaded and reports isLoaded=false', () => {
    const p = new MiniCPMProvider();
    expect(p.isLoaded()).toBe(false);
  });

  it('preserves more screenshot detail than the fast provider resize limit', async () => {
    const p = new MiniCPMProvider();
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
      source: 'wide-ui-screenshot',
      size: input.length,
    });

    const meta = await sharp(optimized.buffer).metadata();
    expect(meta.width).toBe(2048);
    expect(meta.height).toBe(897);
  });

  it('allows longer high-quality descriptions than the fast provider token cap', async () => {
    const p = new MiniCPMProvider();
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
      prompt: 'Describe the UI screenshot in detail',
      maxTokens: 1200,
      temperature: 0,
      cache: false,
    });

    expect(capturedMaxTokens).toBe(1024);
  });
});
