/**
 * SmolVLM2 Provider — end-to-end tests via llama-server.
 *
 * Slow test: downloads SmolVLM2-500M GGUF on first run. Excluded from the
 * default `pnpm test` suite; run via `pnpm test:slow`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { SmolVLM2Provider } from '../src/providers/smolvlm2/provider.js';

const FIXTURE_PATH = 'tests/fixtures/smolvlm2-test.png';

describe('SmolVLM2 Provider — fast GGUF candidate', () => {
  let provider: SmolVLM2Provider;

  beforeAll(async () => {
    const img = await sharp({
      create: { width: 256, height: 256, channels: 3, background: { r: 40, g: 60, b: 100 } },
    })
      .composite([{
        input: Buffer.from(
          '<svg width="256" height="256">' +
          '<path d="M128 20 L160 220 L128 250 L96 220 Z" fill="steelblue" stroke="white" stroke-width="4"/>' +
          '<text x="80" y="40" font-size="20" fill="white">SWORD</text>' +
          '</svg>',
        ),
        top: 0, left: 0,
      }])
      .png()
      .toBuffer();
    writeFileSync(FIXTURE_PATH, img);

    provider = new SmolVLM2Provider();
    await provider.load();
  }, 120000);

  afterAll(async () => {
    if (provider?.isLoaded()) await provider.unload();
    await new Promise((r) => setTimeout(r, 1000));
  }, 30000);

  it('generates an image description', async () => {
    const buf = await sharp(FIXTURE_PATH).png().toBuffer();
    const response = await provider.infer({
      image: { buffer: buf, mimeType: 'image/png', source: 'test', size: buf.length },
      prompt: 'Describe this image in one sentence.',
      maxTokens: 64,
      temperature: 0,
    });

    expect(response.text).toBeTruthy();
    expect(response.text.length).toBeGreaterThan(5);
    console.log('SmolVLM2 description:', response.text);
  }, 30000);
});
