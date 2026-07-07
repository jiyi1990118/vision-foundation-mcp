/**
 * M2 — Core Engine (Planner + Policy + Skill) tests.
 *
 * Tests the layered architecture: Tool → Planner → Policy → Pipeline → Provider.
 * Uses real SmolVLM inference (slow but validates the full stack).
 *
 * @see Docs/05-roadmap/01-roadmap.md (M2)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { SmolVLMProvider } from '../src/providers/smolvlm/provider.js';
import { planExecution, mapIntentToSkills } from '../src/core/execution-planner.js';
import { evaluatePolicy, PolicyDeniedError } from '../src/core/policy-engine.js';
import { SkillPipeline, composeResult } from '../src/core/skill-pipeline.js';
import { getSkill, listSkills } from '../src/skills/registry.js';
import type { PlannerInput, PolicyContext } from '../src/types/skills.js';
import type { ImageInput, ImageMetadata } from '../src/types/domain.js';

const FIXTURE_PATH = 'tests/fixtures/m2-test.png';

describe('M2 — Core Engine', () => {
  let provider: SmolVLMProvider;
  let testImage: ImageInput;
  let testMetadata: ImageMetadata;

  beforeAll(async () => {
    // Create a test image with some visual content
    const buf = await sharp({
      create: { width: 256, height: 256, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .composite([{
        input: Buffer.from(
          '<svg width="256" height="256">' +
          '<rect x="50" y="50" width="100" height="100" fill="red"/>' +
          '<text x="60" y="120" font-size="24" fill="white">Hello</text>' +
          '</svg>',
        ),
        top: 0, left: 0,
      }])
      .png()
      .toBuffer();
    writeFileSync(FIXTURE_PATH, buf);

    testImage = { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length };
    testMetadata = {
      width: 256, height: 256, aspectRatio: 1, format: 'png',
      hasAlpha: false, fileSize: buf.length, complexity: 'low',
    };

    provider = new SmolVLMProvider();
    await provider.load();
  }, 60000);

  afterAll(async () => {
    if (provider?.isLoaded()) await provider.unload();
  }, 30000);

  // ── Skill Registry ──
  it('Skill Registry loads 3 skills: classify, ocr, summary', () => {
    const skills = listSkills();
    expect(skills.length).toBeGreaterThanOrEqual(3);
    expect(getSkill('classify')).toBeDefined();
    expect(getSkill('ocr')).toBeDefined();
    expect(getSkill('summary')).toBeDefined();
  });

  it('Each skill has prompt template and schema', () => {
    for (const name of ['classify', 'ocr', 'summary']) {
      const skill = getSkill(name)!;
      expect(skill.promptTemplate.length).toBeGreaterThan(50);
      expect(skill.schema).toBeDefined();
      expect(skill.supportedProviders).toContain('smolvlm');
    }
  });

  // ── Intent Mapping ──
  it('maps "describe" intent to classify + summary', () => {
    const skills = mapIntentToSkills('describe this image');
    expect(skills).toContain('classify');
    expect(skills).toContain('summary');
  });

  it('maps "extract text" intent to ocr', () => {
    const skills = mapIntentToSkills('extract text from this image');
    expect(skills).toContain('ocr');
  });

  it('maps "auto" intent to classify + summary (default)', () => {
    const skills = mapIntentToSkills('auto');
    expect(skills).toContain('classify');
  });

  // ── Execution Planner ──
  it('Planner creates ExecutionPlan with correct skills', async () => {
    const input: PlannerInput = {
      image: testImage,
      metadata: testMetadata,
      intent: 'describe this image',
      options: {},
      resources: { cpuCores: 8, memoryAvailableMB: 4096, hasGPU: false },
    };
    const plan = await planExecution(input);
    expect(plan.provider).toBe('smolvlm');
    expect(plan.skills.length).toBeGreaterThanOrEqual(2);
    expect(plan.skills.some((s) => s.skill === 'classify')).toBe(true);
    expect(plan.cacheKey).toBeTruthy();
    expect(plan.retry.max).toBeGreaterThanOrEqual(1);
  });

  it('Planner respects explicitly requested skills', async () => {
    const input: PlannerInput = {
      image: testImage,
      metadata: testMetadata,
      intent: 'auto',
      requestedSkills: ['ocr'],
      options: {},
      resources: { cpuCores: 8, memoryAvailableMB: 4096, hasGPU: false },
    };
    const plan = await planExecution(input);
    expect(plan.skills.length).toBe(1);
    expect(plan.skills[0]!.skill).toBe('ocr');
  });

  it('Planner adds resize for large images', async () => {
    const input: PlannerInput = {
      image: testImage,
      metadata: { ...testMetadata, width: 4000, height: 4000 },
      intent: 'auto',
      options: {},
      resources: { cpuCores: 8, memoryAvailableMB: 4096, hasGPU: false },
    };
    const plan = await planExecution(input);
    expect(plan.preprocess).toContain('resize');
  });

  // ── Policy Engine ──
  it('Policy allows normal requests', async () => {
    const plan = await planExecution({
      image: testImage,
      metadata: testMetadata,
      intent: 'auto',
      options: {},
      resources: { cpuCores: 8, memoryAvailableMB: 4096, hasGPU: false },
    });
    const ctx: PolicyContext = {
      plan,
      metadata: testMetadata,
      intent: 'auto',
      options: {},
      resources: { cpuCores: 8, memoryAvailableMB: 4096, hasGPU: false },
    };
    const result = await evaluatePolicy(ctx);
    expect(result.provider).toBe('smolvlm');
  });

  it('Policy denies huge images (>50MB)', async () => {
    const plan = await planExecution({
      image: testImage,
      metadata: { ...testMetadata, fileSize: 60_000_000 },
      intent: 'auto',
      options: {},
      resources: { cpuCores: 8, memoryAvailableMB: 4096, hasGPU: false },
    });
    const ctx: PolicyContext = {
      plan,
      metadata: { ...testMetadata, fileSize: 60_000_000 },
      intent: 'auto',
      options: {},
      resources: { cpuCores: 8, memoryAvailableMB: 4096, hasGPU: false },
    };
    await expect(evaluatePolicy(ctx)).rejects.toThrow(PolicyDeniedError);
  });

  it('Policy warns on low memory without rewriting provider', async () => {
    const plan = await planExecution({
      image: testImage,
      metadata: testMetadata,
      intent: 'auto',
      options: { provider: 'qwen2.5-vl' },
      resources: { cpuCores: 8, memoryAvailableMB: 512, hasGPU: false },
    });
    // Planner honours explicit options.provider; policy no longer hardcodes smolvlm.
    const ctx: PolicyContext = {
      plan,
      metadata: testMetadata,
      intent: 'auto',
      options: {},
      resources: { cpuCores: 8, memoryAvailableMB: 512, hasGPU: false },
    };
    const result = await evaluatePolicy(ctx);
    expect(result.provider).toBe('qwen2.5-vl');
  });

  // ── Full Pipeline (real inference, slow) ──
  it('Pipeline executes multiple skills and returns results', async () => {
    const input: PlannerInput = {
      image: testImage,
      metadata: testMetadata,
      intent: 'describe',
      options: {},
      resources: { cpuCores: 8, memoryAvailableMB: 4096, hasGPU: false },
    };
    const plan = await planExecution(input);
    const pipeline = new SkillPipeline(provider);
    const results = await pipeline.execute(plan, testImage);

    // At least classify should succeed
    expect(results['classify']).toBeDefined();
    expect(results['summary']).toBeDefined();
    console.log('Pipeline results:', JSON.stringify(results, null, 2));
  }, 120000);

  it('composeResult produces unified VisionResult', async () => {
    const input: PlannerInput = {
      image: testImage,
      metadata: testMetadata,
      intent: 'describe',
      options: {},
      resources: { cpuCores: 8, memoryAvailableMB: 4096, hasGPU: false },
    };
    const plan = await planExecution(input);
    const pipeline = new SkillPipeline(provider);
    const results = await pipeline.execute(plan, testImage);
    const visionResult = composeResult(results, provider.name, provider.runtime, 5000);

    expect(visionResult).toHaveProperty('category');
    expect(visionResult).toHaveProperty('confidence');
    expect(visionResult).toHaveProperty('summary');
    expect(visionResult).toHaveProperty('skills');
    expect(visionResult).toHaveProperty('result');
    expect(visionResult).toHaveProperty('metadata');
    expect(visionResult.metadata.provider).toBe('smolvlm');
    expect(visionResult.metadata.runtime).toBe('onnx');
    console.log('VisionResult:', JSON.stringify(visionResult, null, 2));
  }, 120000);

  it('handles partial failure gracefully', async () => {
    // Request a non-existent skill — should not crash
    const input: PlannerInput = {
      image: testImage,
      metadata: testMetadata,
      intent: 'auto',
      requestedSkills: ['classify', 'nonexistent'],
      options: {},
      resources: { cpuCores: 8, memoryAvailableMB: 4096, hasGPU: false },
    };
    const plan = await planExecution(input);
    // nonexistent skill should be filtered out by planner
    expect(plan.skills.some((s) => s.skill === 'nonexistent')).toBe(false);
  });
});
