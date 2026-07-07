/**
 * M1 Walking Skeleton — image to text (with real SmolVLM inference).
 *
 * @see Docs/05-roadmap/01-roadmap.md (M1 + M1.5)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { writeFileSync, readFileSync } from 'node:fs';
import { normalizeImageInput } from '../src/core/request-normalizer.js';
import { extractMetadata } from '../src/core/metadata-extractor.js';
import { SmolVLMProvider } from '../src/providers/smolvlm/provider.js';
import { detectHardware, recommendRuntime } from '../src/core/runtime-detector.js';

const FIXTURE_PATH = 'tests/fixtures/test-image.png';

describe('M1 Walking Skeleton — image to text', () => {
  let provider: SmolVLMProvider;

  beforeAll(async () => {
    const png = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 30, g: 60, b: 120 } },
    }).png().toBuffer();
    writeFileSync(FIXTURE_PATH, png);
    provider = new SmolVLMProvider();
    await provider.load();
  }, 60000);

  afterAll(async () => {
    if (provider?.isLoaded()) await provider.unload();
  }, 30000);

  it('normalizes file path input', async () => {
    const image = await normalizeImageInput(FIXTURE_PATH);
    expect(image.buffer.length).toBeGreaterThan(0);
    expect(image.mimeType).toBe('image/png');
  });

  it('normalizes base64 input', async () => {
    const buf = readFileSync(FIXTURE_PATH);
    const image = await normalizeImageInput(buf.toString('base64'));
    expect(image.mimeType).toBe('image/png');
  });

  it('normalizes data URI input', async () => {
    const buf = readFileSync(FIXTURE_PATH);
    const image = await normalizeImageInput(`data:image/png;base64,${buf.toString('base64')}`);
    expect(image.mimeType).toBe('image/png');
  });

  it('rejects invalid input', async () => {
    await expect(normalizeImageInput('')).rejects.toThrow();
  });

  it('extracts metadata correctly', async () => {
    const image = await normalizeImageInput(FIXTURE_PATH);
    const meta = await extractMetadata(image);
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(100);
    expect(meta.format).toBe('png');
  });

  it('detects hardware and recommends runtime', async () => {
    const hw = await detectHardware();
    expect(hw.cpuArch).toBeDefined();
    expect(hw.cpuCores).toBeGreaterThan(0);
    expect(hw.totalMemoryMB).toBeGreaterThan(0);

    const rt = await recommendRuntime(hw);
    expect(rt.provider).toBeDefined();
    expect(rt.threads).toBeGreaterThan(0);
    expect(rt.recommendedMaxTokens).toBeGreaterThan(0);
    expect(rt.dtype).toBeDefined();
    expect(rt.dtype.decoder_model_merged).toBeDefined();
  });

  it('runs provider inference and returns text', async () => {
    const image = await normalizeImageInput(FIXTURE_PATH);
    const response = await provider.infer({
      image,
      prompt: 'Describe this image',
      maxTokens: 8,
      temperature: 0.1,
    });
    expect(response.text).toBeTruthy();
    expect(response.duration).toBeGreaterThanOrEqual(0);
  }, 60000);

  it('completes full pipeline: image → text result', async () => {
    const image = await normalizeImageInput(FIXTURE_PATH);
    const metadata = await extractMetadata(image);
    const response = await provider.infer({
      image,
      prompt: `Analyze this image. Image: ${metadata.width}x${metadata.height}.`,
      maxTokens: 8,
      temperature: 0.1,
    });
    expect(response.text).toBeTruthy();
    expect(response.duration).toBeGreaterThanOrEqual(0);
    console.log('Result:', { text: response.text, duration: response.duration });
  }, 60000);

  it('provider load/unload lifecycle', async () => {
    const p = new SmolVLMProvider();
    expect(p.isLoaded()).toBe(false);
    await p.load();
    expect(p.isLoaded()).toBe(true);
    await p.unload();
    expect(p.isLoaded()).toBe(false);
  }, 30000);
});
