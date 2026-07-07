/**
 * MiniCPM-V Provider — end-to-end tests via llama-server.
 *
 * Slow test: triggers a ~2GB model download on first run. Excluded from the
 * default `pnpm test` suite; run via `pnpm test:slow`.
 *
 * @see Docs/05-roadmap/01-roadmap.md (M5)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { MiniCPMProvider } from '../src/providers/minicpm/provider.js';
import { detectHardware } from '../src/core/runtime-detector.js';

const FIXTURE_PATH = 'tests/fixtures/minicpm-test.png';

describe('MiniCPM-V Provider — high-quality via llama.cpp', () => {
  let provider: MiniCPMProvider;

  beforeAll(async () => {
    const img = await sharp({
      create: { width: 256, height: 256, channels: 3, background: { r: 200, g: 120, b: 80 } },
    })
      .composite([{
        input: Buffer.from(
          '<svg width="256" height="256">' +
          '<rect x="30" y="30" width="120" height="80" fill="green"/>' +
          '<text x="40" y="80" font-size="22" fill="white">CHART</text>' +
          '</svg>',
        ),
        top: 0, left: 0,
      }])
      .png()
      .toBuffer();
    writeFileSync(FIXTURE_PATH, img);

    provider = new MiniCPMProvider();
    await provider.load();
  }, 300000);

  afterAll(async () => {
    if (provider?.isLoaded()) await provider.unload();
    await new Promise((r) => setTimeout(r, 1000));
  }, 30000);

  it('requires a GPU host (skips gracefully on CPU-only)', async () => {
    const hw = await detectHardware();
    if (!hw.hasMetal && !hw.hasCUDA) {
      // On CPU-only hosts load() throws; mark skipped by passing.
      expect(provider.isLoaded()).toBe(false);
      return;
    }
    expect(provider.isLoaded()).toBe(true);
  }, 300000);

  it('generates an image description', async () => {
    if (!provider.isLoaded()) return;
    const buf = await sharp(FIXTURE_PATH).png().toBuffer();
    const response = await provider.infer({
      image: { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length },
      prompt: 'Describe this image in one sentence.',
      maxTokens: 64,
      temperature: 0,
    });

    expect(response.text).toBeTruthy();
    expect(response.text.length).toBeGreaterThan(5);
    console.log('MiniCPM-V description:', response.text);
  }, 60000);

  it('performs classification', async () => {
    if (!provider.isLoaded()) return;
    const buf = await sharp(FIXTURE_PATH).png().toBuffer();
    const response = await provider.infer({
      image: { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length },
      prompt: 'What is the main category? Reply with one word.',
      maxTokens: 16,
      temperature: 0,
    });

    expect(response.text).toBeTruthy();
    console.log('MiniCPM-V classification:', response.text);
  }, 60000);

  it('unloads cleanly', async () => {
    if (!provider.isLoaded()) return;
    await provider.unload();
    expect(provider.isLoaded()).toBe(false);
  }, 30000);
});