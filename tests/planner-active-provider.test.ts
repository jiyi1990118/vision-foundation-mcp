import { describe, expect, it } from 'vitest';
import { planExecution, resolveSkillNames } from '../src/core/execution-planner.js';
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
  it('maps requirement screenshot analysis to classify, OCR, and summary', async () => {
    const input: PlannerInput = {
      ...baseInput,
      intent: '分析这个需求截图内容，提取页面字段、按钮、红框标注和图片内容',
    } as PlannerInput;

    const plan = await planExecution(input);
    expect(plan.skills.map((task) => task.skill)).toEqual(['classify', 'ocr', 'summary']);
  });

  it('maps TAPD requirement image analysis to classify, OCR, and summary', async () => {
    const input: PlannerInput = {
      ...baseInput,
      intent: '分析桌面上的 TAPD 需求图片，返回关键内容和总结',
    } as PlannerInput;

    const plan = await planExecution(input);
    expect(plan.skills.map((task) => task.skill)).toEqual(['classify', 'ocr', 'summary']);
  });

  it('injects target focus into OCR prompts for region extraction', async () => {
    const input: PlannerInput = {
      ...baseInput,
      options: { target: { color: 'red', position: '图片底部红色虚线框内', description: '红色虚线框包围的变动配料文字' } },
    } as PlannerInput;

    const plan = await planExecution(input);
    const ocr = plan.skills.find((task) => task.skill === 'ocr')!;

    expect(ocr.prompt).toContain('Focus on: color=red; position=图片底部红色虚线框内; description=红色虚线框包围的变动配料文字');
  });

  it('runs OCR and classify before summary for mixed screenshot analysis', async () => {
    const input: PlannerInput = {
      ...baseInput,
      intent: '分析这个需求截图内容，提取页面字段、按钮、红框标注和图片内容',
    } as PlannerInput;

    const plan = await planExecution(input);
    const classify = plan.skills.find((task) => task.skill === 'classify')!;
    const summary = plan.skills.find((task) => task.skill === 'summary')!;

    expect(classify.dependsOn).toBeUndefined();
    expect(summary.dependsOn).toEqual(['ocr', 'classify']);
  });

  it('adds OCR for target extraction on auto intent', async () => {
    const input: PlannerInput = {
      ...baseInput,
      options: { target: { color: 'red', description: '虚线红框中的内容' } },
    } as PlannerInput;

    const plan = await planExecution(input);
    expect(plan.skills.map((task) => task.skill)).toEqual(['classify', 'summary', 'ocr']);
  });

  it('keeps explicit requested skills authoritative for target extraction', async () => {
    const requestedSkills = resolveSkillNames(['classify'], '提取红框', { target: { color: 'red' } });
    expect(requestedSkills).toEqual(['classify']);

    const input: PlannerInput = {
      ...baseInput,
      intent: '提取红框',
      requestedSkills: ['classify'],
      options: { target: { color: 'red' } },
    } as PlannerInput;

    const plan = await planExecution(input);
    expect(plan.skills.map((task) => task.skill)).toEqual(['classify']);
  });

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
