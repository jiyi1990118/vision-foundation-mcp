import { describe, expect, it } from 'vitest';
import { GGUFProvider } from '../src/providers/gguf/provider.js';
import { SmolVLMProvider } from '../src/providers/smolvlm/provider.js';
import { MiniCPMProvider } from '../src/providers/minicpm/provider.js';
import { SmolVLM2Provider } from '../src/providers/smolvlm2/provider.js';
import { listSkills } from '../src/skills/registry.js';

describe('provider capability declarations', () => {
  it('registers the OCR provider when explicitly enabled', async () => {
    const { buildProvidersForRuntime } = await import('../src/index.js');
    const providers = await buildProvidersForRuntime({
      VISION_PROVIDER: 'smolvlm2',
      VISION_OCR_PROVIDER: 'ppu-paddle-ocr',
    } as NodeJS.ProcessEnv);

    expect(providers.map((p) => p.name)).toContain('ppu-paddle-ocr');
  });

  it('GGUF provider declares support for every registered runtime skill', () => {
    const provider = new GGUFProvider();
    const registeredSkills = listSkills().map((skill) => skill.name).sort();

    expect([...provider.supportedSkills].sort()).toEqual(registeredSkills);
  });

  it('MiniCPM-V provider declares support for every registered runtime skill', () => {
    const provider = new MiniCPMProvider();
    const registeredSkills = listSkills().map((skill) => skill.name).sort();

    expect([...provider.supportedSkills].sort()).toEqual(registeredSkills);
  });

  it('SmolVLM2 provider declares support for every registered runtime skill', () => {
    const provider = new SmolVLM2Provider();
    const registeredSkills = listSkills().map((skill) => skill.name).sort();

    expect([...provider.supportedSkills].sort()).toEqual(registeredSkills);
  });

  it('providers do not declare skills that are not registered', () => {
    const registered = new Set(listSkills().map((skill) => skill.name));

    for (const provider of [new GGUFProvider(), new SmolVLMProvider(), new MiniCPMProvider(), new SmolVLM2Provider()]) {
      const unknown = provider.supportedSkills.filter((skill) => !registered.has(skill));
      expect(unknown).toEqual([]);
    }
  });
});
