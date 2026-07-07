import { describe, expect, it } from 'vitest';
import { planExecution } from '../src/core/execution-planner.js';
import type { PlannerInput } from '../src/types/skills.js';

const baseInput = {
  image: { buffer: Buffer.from('x'), mimeType: 'image/png', source: 'test', size: 1 },
  metadata: {
    width: 256, height: 256, aspectRatio: 1, format: 'png',
    hasAlpha: false, fileSize: 1, complexity: 'low' as const,
  },
  intent: 'auto',
  options: {},
  resources: { cpuCores: 8, memoryAvailableMB: 8192, hasGPU: true },
};

describe('execution-planner active-provider defaulting', () => {
  it('uses activeProvider/activeRuntime when options.provider is unset', async () => {
    const input: PlannerInput = {
      ...baseInput,
      activeProvider: 'gguf-smolvlm',
      activeRuntime: 'llama-cpp',
    } as PlannerInput;

    const plan = await planExecution(input);
    expect(plan.provider).toBe('gguf-smolvlm');
    expect(plan.runtime).toBe('llama-cpp');
  });

  it('explicit options.provider still wins over activeProvider', async () => {
    const input: PlannerInput = {
      ...baseInput,
      options: { provider: 'qwen2.5-vl' },
      activeProvider: 'gguf-smolvlm',
      activeRuntime: 'llama-cpp',
    } as PlannerInput;

    const plan = await planExecution(input);
    expect(plan.provider).toBe('qwen2.5-vl');
  });

  it('falls back to smolvlm/onnx when no activeProvider and no options.provider', async () => {
    const input: PlannerInput = { ...baseInput } as PlannerInput;

    const plan = await planExecution(input);
    expect(plan.provider).toBe('smolvlm');
    expect(plan.runtime).toBe('onnx');
  });

  it('low memory keeps the active provider (router already chose a feasible one)', async () => {
    // Router has already filtered out infeasible high-quality providers on low
    // memory and returned this fast provider; the planner must NOT rewrite it
    // to the legacy 'smolvlm' default, which would mismatch the executed instance.
    const input: PlannerInput = {
      ...baseInput,
      resources: { cpuCores: 8, memoryAvailableMB: 256, hasGPU: false },
      activeProvider: 'gguf-smolvlm',
      activeRuntime: 'llama-cpp',
    } as PlannerInput;

    const plan = await planExecution(input);
    expect(plan.provider).toBe('gguf-smolvlm');
    expect(plan.runtime).toBe('llama-cpp');
  });

  it('quality=high without explicit provider routes plan to the active high-quality provider', async () => {
    // Simulates the router selecting MiniCPM-V for quality=high + adequate resources.
    const input: PlannerInput = {
      ...baseInput,
      options: { quality: 'high' },
      resources: { cpuCores: 8, memoryAvailableMB: 8192, hasGPU: true },
      activeProvider: 'minicpm-v',
      activeRuntime: 'llama-cpp',
    } as PlannerInput;

    const plan = await planExecution(input);
    expect(plan.provider).toBe('minicpm-v');
    expect(plan.runtime).toBe('llama-cpp');
  });
});