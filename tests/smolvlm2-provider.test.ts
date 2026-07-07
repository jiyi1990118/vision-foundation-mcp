import { describe, expect, it } from 'vitest';
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
});
