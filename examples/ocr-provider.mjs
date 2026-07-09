#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { PpuPaddleOcrProvider } from '../dist/providers/ppu-paddle-ocr/provider.js';

const imagePath = process.argv[2];
if (!imagePath) {
  console.error('Usage: node examples/ocr-provider.mjs <image-path>');
  process.exit(2);
}

const buffer = await readFile(imagePath);
const provider = new PpuPaddleOcrProvider();

try {
  await provider.load();
  const result = await provider.infer({
    image: {
      buffer,
      mimeType: imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png',
      source: imagePath,
      size: buffer.length,
    },
    prompt: 'Extract all visible text',
    maxTokens: 256,
    temperature: 0,
    cache: false,
  });
  console.log(result.text);
} finally {
  await provider.unload();
}
