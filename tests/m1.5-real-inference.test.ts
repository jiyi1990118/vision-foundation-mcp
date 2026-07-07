/**
 * M1.5 — Real SmolVLM ONNX inference test.
 *
 * First run will download ~800MB model files from HuggingFace Hub.
 * Subsequent runs use cached model.
 *
 * @see Docs/05-roadmap/01-roadmap.md (M1.5)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { SmolVLMProvider } from '../src/providers/smolvlm/provider.js';

// Generate a simple test image: 256x256 with some shapes
async function createTestImage(): Promise<Buffer> {
  return await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 3,
      background: { r: 200, g: 200, b: 200 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="256" height="256">
            <rect x="50" y="50" width="100" height="100" fill="red" />
            <circle cx="180" cy="180" r="30" fill="blue" />
            <text x="80" y="220" font-size="20" fill="black">TEST</text>
          </svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();
}

describe('M1.5 — Real SmolVLM inference', { timeout: 600000 }, () => {
  let provider: SmolVLMProvider;
  let testImage: Buffer;

  beforeAll(async () => {
    testImage = await createTestImage();
    writeFileSync('tests/fixtures/test-image-m15.png', testImage);

    provider = new SmolVLMProvider();
    // First load downloads model (~800MB), may take minutes
    await provider.load();
  }, 600000);

  afterAll(async () => {
    await provider.unload();
  });

  it('model is loaded', () => {
    expect(provider.isLoaded()).toBe(true);
  });

  it('generates real text description from image', async () => {
    const response = await provider.infer({
      image: {
        buffer: testImage,
        mimeType: 'image/png',
        source: 'test',
        size: testImage.length,
      },
      prompt: 'Can you describe this image?',
      maxTokens: 256,
      temperature: 0.1,
    });

    console.log('=== SmolVLM output ===');
    console.log(response.text);
    console.log('=== Duration:', response.duration, 'ms ===');

    // Verify it's real text (not skeleton JSON)
    expect(response.text).toBeTruthy();
    expect(response.text.length).toBeGreaterThan(10);
    expect(response.text).not.toContain('_skeleton');

    // It should NOT be JSON (skeleton mode returned JSON)
    const isJson = response.text.trim().startsWith('{');
    expect(isJson).toBe(false);
  }, 300000);

  it('handles different prompts', async () => {
    const response = await provider.infer({
      image: {
        buffer: testImage,
        mimeType: 'image/png',
        source: 'test',
        size: testImage.length,
      },
      prompt: 'What colors do you see in this image?',
      maxTokens: 128,
      temperature: 0.1,
    });

    console.log('=== Color analysis output ===');
    console.log(response.text);

    expect(response.text).toBeTruthy();
    expect(response.text.length).toBeGreaterThan(5);
  }, 300000);
});
