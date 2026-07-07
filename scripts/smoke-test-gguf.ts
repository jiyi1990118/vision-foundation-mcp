/**
 * GGUF Provider smoke test — verify full pipeline with real SmolVLM inference.
 *
 * Tests: load → infer (describe) → infer (classify) → infer (ocr) → unload
 */
import { GGUFProvider } from '../src/providers/gguf/provider.js';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

async function main() {
  // Create test image: blue background + red square + blue circle + "TEST" text
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

  writeFileSync('tests/fixtures/gguf-test.png', img);

  const provider = new GGUFProvider();

  // ── 1. Load ──
  console.log('=== Loading GGUF Provider ===');
  const t0 = Date.now();
  await provider.load();
  console.log(`Loaded in ${Date.now() - t0}ms\n`);

  // ── 2. Describe ──
  console.log('=== Test 1: Describe ===');
  const t1 = Date.now();
  const r1 = await provider.infer({
    image: { buffer: img, mimeType: 'image/png', source: 'test', size: img.length },
    prompt: 'Describe this image in one or two sentences.',
    maxTokens: 64,
    temperature: 0,
  });
  console.log(`Output: "${r1.text}"`);
  console.log(`Duration: ${r1.duration}ms\n`);

  // ── 3. Classify ──
  console.log('=== Test 2: Classify ===');
  const t2 = Date.now();
  const r2 = await provider.infer({
    image: { buffer: img, mimeType: 'image/png', source: 'test', size: img.length },
    prompt: 'What is the main category of this image? Reply with one word: dashboard, chart, diagram, document, poster, ui, photo, logo, icon, other',
    maxTokens: 16,
    temperature: 0,
  });
  console.log(`Output: "${r2.text}"`);
  console.log(`Duration: ${r2.duration}ms\n`);

  // ── 4. OCR ──
  console.log('=== Test 3: OCR ===');
  const t3 = Date.now();
  const r3 = await provider.infer({
    image: { buffer: img, mimeType: 'image/png', source: 'test', size: img.length },
    prompt: 'What text do you see in this image? List each text item.',
    maxTokens: 32,
    temperature: 0,
  });
  console.log(`Output: "${r3.text}"`);
  console.log(`Duration: ${r3.duration}ms\n`);

  // ── 5. Unload ──
  console.log('=== Unloading ===');
  await provider.unload();
  console.log('Done!');

  // ── Summary ──
  console.log('\n=== Summary ===');
  console.log('Load time:  ', `${Date.now() - t0}ms`);
  console.log('Describe:   ', `${r1.duration}ms → "${r1.text.slice(0, 60)}"`);
  console.log('Classify:   ', `${r2.duration}ms → "${r2.text}"`);
  console.log('OCR:        ', `${r3.duration}ms → "${r3.text}"`);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
