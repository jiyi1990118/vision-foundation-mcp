/**
 * P4 Performance & memory audit - measures per-image analysis duration,
 * peak memory usage, and pipeline throughput over real UI screenshots.
 *
 * Usage:
 *   npx tsx scripts/ui-perf-audit.ts [dir] [output.json]
 *   dir defaults to ~/Desktop/UI
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import sharp from 'sharp';
import { extractUiLayoutForAnalysis } from '../src/ui-analysis/adapters/index.js';
import { extractDesignTokens } from '../src/core/extractors/design-extractor.js';
import { runUiAnalysis } from '../src/ui-analysis/orchestrator.js';
import { generateSyntheticSample } from '../src/ui-analysis/benchmark/index.js';
import type { ImageInput } from '../src/types/domain.js';

interface PerfResult {
  image: string;
  imageSizeKB: number;
  imageWidth: number;
  imageHeight: number;
  durationMs: number;
  peakHeapMB: number;
  nodeCount: number;
  error?: string;
}

interface PerfReport {
  totalImages: number;
  succeeded: number;
  failed: number;
  meanDurationMs: number;
  medianDurationMs: number;
  p90DurationMs: number;
  meanPeakHeapMB: number;
  maxPeakHeapMB: number;
  totalDurationMs: number;
  throughputImgPerSec: number;
  perImage: PerfResult[];
}

function mimeOf(f: string): string {
  return /\.(png)$/i.test(f) ? 'image/png' : 'image/jpeg';
}

function getHeapMB(): number {
  const mem = process.memoryUsage();
  return mem.heapUsed / (1024 * 1024);
}

async function measureImage(filePath: string, fileName: string): Promise<PerfResult> {
  const buffer = await readFile(filePath);
  const meta = await sharp(buffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const startHeap = getHeapMB();
  const start = Date.now();

  const image: ImageInput = { buffer, mimeType: mimeOf(fileName), source: fileName, size: buffer.length };
  const design = await extractDesignTokens(image).catch(() => undefined);
  const layout = await extractUiLayoutForAnalysis(
    image,
    undefined,
    design?.palette.map((p) => ({ hex: p.hex, role: p.role })),
  );
  const result = await runUiAnalysis({
    uiLayoutExtraction: layout,
    ...(design ? { designExtraction: design } : {}),
    image,
  });

  const durationMs = Date.now() - start;
  const peakHeap = getHeapMB();

  return {
    image: fileName,
    imageSizeKB: Math.round(buffer.length / 1024),
    imageWidth: width,
    imageHeight: height,
    durationMs,
    peakHeapMB: Math.round(peakHeap * 100) / 100,
    nodeCount: result.uiReconstruction?.stats.nodeCount ?? 0,
  };
}

async function measureSynthetic(): Promise<PerfResult> {
  const sample = generateSyntheticSample('login', 375, 812);
  // Synthetic generator produces raw RGBA buffers; encode to PNG for sharp
  const pngBuf = await sharp(sample.image.buffer, {
    raw: { width: 375, height: 812, channels: 4 },
  }).png().toBuffer();
  const image: ImageInput = { ...sample.image, buffer: pngBuf, size: pngBuf.length };
  const start = Date.now();
  const design = await extractDesignTokens(image).catch(() => undefined);
  const layout = await extractUiLayoutForAnalysis(
    image,
    undefined,
    design?.palette.map((p) => ({ hex: p.hex, role: p.role })),
  );
  await runUiAnalysis({
    uiLayoutExtraction: layout,
    ...(design ? { designExtraction: design } : {}),
    image,
  });
  const durationMs = Date.now() - start;
  return {
    image: 'synthetic-login',
    imageSizeKB: Math.round(sample.image.size / 1024),
    imageWidth: 375,
    imageHeight: 812,
    durationMs,
    peakHeapMB: Math.round(getHeapMB() * 100) / 100,
    nodeCount: 0,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? join(homedir(), 'Desktop', 'UI');
  const outputPath = process.argv[3];
  const files = (await readdir(dir)).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).sort();

  const perImage: PerfResult[] = [];
  let succeeded = 0;
  let failed = 0;

  // Warm up with synthetic
  console.log('warming up with synthetic image...');
  await measureSynthetic();

  if (files.length > 0) {
    console.log(`\nperf audit: ${files.length} images in ${dir}\n`);
    for (const f of files) {
      process.stdout.write(`  ${f}...`);
      try {
        const r = await measureImage(join(dir, f), f);
        perImage.push(r);
        succeeded++;
        console.log(` ${r.durationMs}ms, heap=${r.peakHeapMB}MB, nodes=${r.nodeCount}`);
      } catch (e) {
        perImage.push({
          image: f, imageSizeKB: 0, imageWidth: 0, imageHeight: 0,
          durationMs: 0, peakHeapMB: 0, nodeCount: 0,
          error: String(e).slice(0, 200),
        });
        failed++;
        console.log(` ERROR`);
      }
    }
  } else {
    console.log('\nno real images found, running synthetic only');
  }

  // Also measure synthetic
  console.log('\nsynthetic login...');
  const synth = await measureSynthetic();
  synth.image = 'synthetic-login (375x812)';
  perImage.push(synth);
  succeeded++;
  console.log(` ${synth.durationMs}ms, heap=${synth.peakHeapMB}MB`);

  const durations = perImage.map((r) => r.durationMs).filter((d) => d > 0).sort((a, b) => a - b);
  const heaps = perImage.map((r) => r.peakHeapMB).filter((h) => h > 0);
  const totalDuration = durations.reduce((s, d) => s + d, 0);
  const count = Math.max(1, durations.length);

  const report: PerfReport = {
    totalImages: perImage.length,
    succeeded,
    failed,
    meanDurationMs: totalDuration / count,
    medianDurationMs: percentile(durations, 0.5),
    p90DurationMs: percentile(durations, 0.9),
    meanPeakHeapMB: heaps.length > 0 ? heaps.reduce((s, h) => s + h, 0) / heaps.length : 0,
    maxPeakHeapMB: heaps.length > 0 ? Math.max(...heaps) : 0,
    totalDurationMs: totalDuration,
    throughputImgPerSec: totalDuration > 0 ? (count / totalDuration) * 1000 : 0,
    perImage,
  };

  const json = JSON.stringify(report, null, 2);
  if (outputPath !== undefined && outputPath.length > 0) {
    await writeFile(outputPath, json, 'utf-8');
    console.log(`\nReport written to ${outputPath}`);
  } else {
    console.log(`\n${json}`);
  }

  console.log(`\nSummary: mean=${report.meanDurationMs.toFixed(0)}ms, p90=${report.p90DurationMs}ms, maxHeap=${report.maxPeakHeapMB.toFixed(0)}MB, throughput=${report.throughputImgPerSec.toFixed(1)} img/s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
