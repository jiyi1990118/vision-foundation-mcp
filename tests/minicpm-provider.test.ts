import { describe, expect, it } from 'vitest';
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
});