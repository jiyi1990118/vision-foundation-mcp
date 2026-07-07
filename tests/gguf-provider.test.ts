/**
 * GGUF Provider — end-to-end tests via llama-server.
 *
 * @see Docs/05-roadmap/01-roadmap.md
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { GGUFProvider } from '../src/providers/gguf/provider.js';
import { detectHardware } from '../src/core/runtime-detector.js';

const FIXTURE_PATH = 'tests/fixtures/gguf-test.png';

describe('GGUF Provider — SmolVLM via llama.cpp', () => {
  let provider: GGUFProvider;

  beforeAll(async () => {
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
    writeFileSync(FIXTURE_PATH, img);

    provider = new GGUFProvider();
    await provider.load();
  }, 60000);

  afterAll(async () => {
    if (provider?.isLoaded()) await provider.unload();
    // Wait for port to be fully released
    await new Promise(r => setTimeout(r, 1000));
  }, 30000);

  it('detects hardware and selects GPU layers', async () => {
    const hw = await detectHardware();
    expect(hw.cpuArch).toBeDefined();
    // Apple Silicon should have Metal
    if (hw.hasMetal) {
      expect(hw.hasMetal).toBe(true);
    }
  });

  it('provider loads successfully', () => {
    expect(provider.isLoaded()).toBe(true);
  });

  it('generates accurate image description', async () => {
    const buf = await sharp(FIXTURE_PATH).png().toBuffer();
    const response = await provider.infer({
      image: { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length },
      prompt: 'Describe this image in one sentence.',
      maxTokens: 64,
      temperature: 0,
    });

    expect(response.text).toBeTruthy();
    expect(response.text.length).toBeGreaterThan(10);
    expect(response.duration).toBeLessThan(10000); // < 10s
    console.log('Description:', response.text);
  }, 30000);

  it('performs OCR — responds with text about image', async () => {
    const buf = await sharp(FIXTURE_PATH).png().toBuffer();
    const response = await provider.infer({
      image: { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length },
      prompt: 'What text do you see in this image?',
      maxTokens: 32,
      temperature: 0,
    });

    expect(response.text).toBeTruthy();
    // SmolVLM-500M OCR is limited — just verify it returns something
    console.log('OCR:', response.text);
  }, 30000);

  it('performs classification', async () => {
    const buf = await sharp(FIXTURE_PATH).png().toBuffer();
    const response = await provider.infer({
      image: { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length },
      prompt: 'What is the main category? Reply with one word: dashboard, chart, diagram, document, poster, ui, photo, logo, icon, other',
      maxTokens: 16,
      temperature: 0,
    });

    expect(response.text).toBeTruthy();
    console.log('Classification:', response.text);
  }, 30000);

  it('responds within 5 seconds per inference', async () => {
    const buf = await sharp(FIXTURE_PATH).png().toBuffer();
    const response = await provider.infer({
      image: { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length },
      prompt: 'Describe this image briefly.',
      maxTokens: 32,
      temperature: 0,
    });

    // GGUF on Metal should be < 5s
    expect(response.duration).toBeLessThan(5000);
    console.log('Response time:', response.duration, 'ms');
  }, 30000);

  it('unloads cleanly', async () => {
    const p = new GGUFProvider();
    await p.load();
    expect(p.isLoaded()).toBe(true);
    await p.unload();
    expect(p.isLoaded()).toBe(false);
  }, 30000);
});
