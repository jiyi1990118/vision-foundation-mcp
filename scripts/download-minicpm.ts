#!/usr/bin/env tsx
import { ensureMiniCPMModel, MINICPM_MODEL_FILE, MINICPM_MMPROJ_FILE, MINICPM_MODEL_DIR } from '../src/core/model-manager.js';

console.log('Downloading MiniCPM-V 2.6 model files...');
console.log('Model dir:', MINICPM_MODEL_DIR);
console.log('Model file:', MINICPM_MODEL_FILE);
console.log('Mmproj file:', MINICPM_MMPROJ_FILE);
console.log('');

try {
  const paths = await ensureMiniCPMModel({ baseUrl: 'https://hf-mirror.com' });
  console.log('Done!');
  console.log('Model:', paths.modelPath);
  console.log('Mmproj:', paths.mmprojPath);
} catch (e) {
  console.error('Download failed:', (e as Error).message);
  process.exit(1);
}