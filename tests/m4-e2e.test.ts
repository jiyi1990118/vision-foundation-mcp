/**
 * M4 — End-to-end test: GGUF Provider + full layered architecture.
 *
 * Verifies the complete pipeline:
 *   MCP Tool → Normalizer → Planner → Policy → Pipeline → GGUF Provider → Result
 *
 * @see Docs/05-roadmap/01-roadmap.md (M4)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { GGUFProvider } from '../src/providers/gguf/provider.js';
import { SkillPipeline, composeResult } from '../src/core/skill-pipeline.js';
import { planExecution } from '../src/core/execution-planner.js';
import { evaluatePolicy } from '../src/core/policy-engine.js';
import { getSkill, listSkills } from '../src/skills/registry.js';
import { normalizeImageInput } from '../src/core/request-normalizer.js';
import { extractMetadata } from '../src/core/metadata-extractor.js';
import { Semaphore, withTimeout } from '../src/utils/concurrency.js';
import type { PlannerInput, PolicyContext } from '../src/types/skills.js';

const FIXTURE = 'tests/fixtures/m4-e2e.png';

describe('M4 — End-to-End with GGUF Provider', () => {
  let provider: GGUFProvider;

  beforeAll(async () => {
    // Create test image
    const img = await sharp({
      create: { width: 256, height: 256, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .composite([{
        input: Buffer.from(
          '<svg width="256" height="256">' +
          '<rect x="50" y="50" width="100" height="100" fill="red"/>' +
          '<circle cx="180" cy="180" r="30" fill="blue"/>' +
          '<text x="80" y="220" font-size="20" fill="black">TEST</text>' +
          '</svg>',
        ),
        top: 0, left: 0,
      }])
      .png()
      .toBuffer();
    writeFileSync(FIXTURE, img);

    provider = new GGUFProvider();
    await provider.load();
  }, 60000);

  afterAll(async () => {
    if (provider?.isLoaded()) await provider.unload();
    await new Promise(r => setTimeout(r, 1000));
  }, 30000);

  // ── Skill Registry: 8 Skills ──
  it('Skill Registry loads 8 skills', () => {
    const skills = listSkills();
    expect(skills.length).toBeGreaterThanOrEqual(8);
    for (const name of ['classify', 'ocr', 'summary', 'table', 'document', 'poster', 'moderation', 'layout']) {
      expect(getSkill(name)).toBeDefined();
    }
  });

  // ── Full Pipeline: image → structured result ──
  it('full pipeline: image → plan → policy → pipeline → structured result', async () => {
    // 1. Normalize + metadata
    const image = await normalizeImageInput(FIXTURE);
    const metadata = await extractMetadata(image);

    // 2. Plan
    const input: PlannerInput = {
      image, metadata,
      intent: 'describe',
      options: {},
      resources: { cpuCores: 8, memoryAvailableMB: 4096, hasGPU: true },
    };
    const draftPlan = await planExecution(input);

    // 3. Policy
    const ctx: PolicyContext = {
      plan: draftPlan, metadata, intent: 'describe',
      options: {}, resources: input.resources,
    };
    const plan = await evaluatePolicy(ctx);

    // 4. Pipeline
    const pipeline = new SkillPipeline(provider);
    const results = await pipeline.execute(plan, image);

    // 5. Compose
    const result = composeResult(results, provider.name, provider.runtime, 0);

    // Verify structure
    expect(result).toHaveProperty('category');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('skills');
    expect(result).toHaveProperty('result');
    expect(result).toHaveProperty('metadata');
    expect(result.metadata.provider).toBe('gguf-smolvlm');
    expect(result.metadata.runtime).toBe('llama-cpp');

    console.log('E2E Result:', JSON.stringify({
      category: result.category,
      confidence: result.confidence,
      summary: result.summary,
      skills: result.skills,
    }));
  }, 30000);

  // ── Performance: < 5s for full pipeline ──
  it('completes full pipeline within 5 seconds', async () => {
    const image = await normalizeImageInput(FIXTURE);
    const metadata = await extractMetadata(image);
    const start = Date.now();

    const input: PlannerInput = {
      image, metadata,
      intent: 'describe',
      options: {},
      resources: { cpuCores: 8, memoryAvailableMB: 4096, hasGPU: true },
    };
    const plan = await evaluatePolicy({
      plan: await planExecution(input),
      metadata, intent: 'describe', options: {}, resources: input.resources,
    });

    const pipeline = new SkillPipeline(provider);
    await pipeline.execute(plan, image);

    const duration = Date.now() - start;
    expect(duration).toBeLessThan(5000);
    console.log('Full pipeline duration:', duration, 'ms');
  }, 30000);

  // ── Cache: second call should be instant ──
  it('cache: second identical inference is near-instant', async () => {
    const buf = await sharp(FIXTURE).png().toBuffer();
    const req = {
      image: { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length },
      prompt: 'Describe in one word.',
      maxTokens: 8,
      temperature: 0,
    };

    const r1 = await provider.infer(req);
    const r2 = await provider.infer(req);

    expect(r2.duration).toBeLessThan(r1.duration);
    expect(r2.duration).toBe(0); // cached
    console.log(`1st: ${r1.duration}ms, 2nd: ${r2.duration}ms (cached)`);
  }, 30000);

  it('cache=false bypasses GGUF result cache', async () => {
    const buf = await sharp(FIXTURE).png().toBuffer();
    const req = {
      image: { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length },
      prompt: 'Describe cache bypass in one word.',
      maxTokens: 8,
      temperature: 0,
      cache: false,
    };

    const r1 = await provider.infer(req);
    const r2 = await provider.infer(req);

    expect(r1.duration).toBeGreaterThan(0);
    expect(r2.duration).toBeGreaterThan(0);
  }, 30000);

  // ── Concurrency: Semaphore limits to 4 ──
  it('semaphore limits concurrency', async () => {
    const sem = new Semaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const tasks = Array.from({ length: 6 }, () =>
      (async () => {
        await sem.acquire();
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(r => setTimeout(r, 50));
        concurrent--;
        sem.release();
      })(),
    );

    await Promise.all(tasks);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  // ── Timeout: withTimeout rejects on timeout ──
  it('withTimeout rejects slow promises', async () => {
    const slow = new Promise(r => setTimeout(r, 1000));
    await expect(withTimeout(slow, 100, 'Too slow')).rejects.toThrow('Too slow');
  });

  it('withTimeout resolves fast promises', async () => {
    const fast = Promise.resolve('ok');
    const result = await withTimeout(fast, 1000);
    expect(result).toBe('ok');
  });

  // ── Streaming ──
  it('streamInfer yields text chunks', async () => {
    const buf = await sharp(FIXTURE).png().toBuffer();
    let chunks = 0;
    let text = '';
    for await (const chunk of provider.streamInfer({
      image: { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length },
      prompt: 'Describe this image briefly.',
      maxTokens: 64,
      temperature: 0,
    })) {
      text += chunk;
      chunks++;
    }
    expect(chunks).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    console.log('Streamed:', chunks, 'chunks →', text.slice(0, 80));
  }, 30000);
});
