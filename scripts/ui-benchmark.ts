/**
 * P4 Benchmark runner - runs the full UI analysis pipeline over real UI
 * screenshots in no-annotation mode and emits a coverage/stability report.
 *
 * Unlike ui-realimage-check.ts (which prints per-image stats), this script:
 * - Uses the benchmark runner (extractPredictionsFromAst + runBenchmark)
 * - Computes per-image coverage, node count, render mode distribution
 * - Computes cross-image stability (determinism check: same image -> same node count)
 * - Emits a JSON report to stdout or a file
 *
 * Usage:
 *   npx tsx scripts/ui-benchmark.ts [dir] [output.json]
 *   dir defaults to ~/Desktop/UI
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import sharp from 'sharp';
import { extractUiLayoutForAnalysis } from '../src/ui-analysis/adapters/index.js';
import { extractDesignTokens } from '../src/core/extractors/design-extractor.js';
import { runUiAnalysis } from '../src/ui-analysis/orchestrator.js';
import { extractPredictionsFromAst } from '../src/ui-analysis/benchmark/index.js';
import type { ImageInput } from '../src/types/domain.js';

interface ImageResult {
  image: string;
  imageWidth: number;
  imageHeight: number;
  nodeCount: number;
  predictionCount: number;
  coverage: number;
  renderModes: Record<string, number>;
  pageType: string;
  pageTypeConfidence: number;
  componentCounts: Record<string, number>;
  diagnostics: string[];
  error?: string;
}

interface StabilityResult {
  image: string;
  run1NodeCount: number;
  run2NodeCount: number;
  stable: boolean;
}

interface BenchmarkReport {
  totalImages: number;
  succeeded: number;
  failed: number;
  meanCoverage: number;
  meanNodeCount: number;
  totalPredictions: number;
  renderModeDistribution: Record<string, number>;
  componentTypeDistribution: Record<string, number>;
  perImage: ImageResult[];
  stability: StabilityResult[];
}

function mimeOf(f: string): string {
  return /\.(png)$/i.test(f) ? 'image/png' : 'image/jpeg';
}

async function getDimensions(buf: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(buf).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

async function runSingleImage(
  filePath: string,
  fileName: string,
): Promise<ImageResult> {
  const buffer = await readFile(filePath);
  const { width, height } = await getDimensions(buffer);
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
  const recon = result.uiReconstruction;
  if (!recon) {
    return {
      image: fileName,
      imageWidth: width,
      imageHeight: height,
      nodeCount: 0,
      predictionCount: 0,
      coverage: 0,
      renderModes: {},
      pageType: 'unknown',
      pageTypeConfidence: 0,
      componentCounts: {},
      diagnostics: ['no-reconstruction'],
    };
  }
  const predictions = extractPredictionsFromAst(recon.tree);
  const totalArea = width * height;
  const coveredArea = predictions.reduce((s, p) => s + Math.max(0, p.bbox.w) * Math.max(0, p.bbox.h), 0);
  const coverage = totalArea > 0 ? Math.min(1, coveredArea / totalArea) : 0;

  const renderModes: Record<string, number> = {};
  const walkRender = (node: typeof recon.tree): void => {
    const mode = node.props.render;
    if (mode !== undefined && typeof mode === 'object' && 'mode' in mode) {
      const m = (mode as { mode: string }).mode;
      renderModes[m] = (renderModes[m] ?? 0) + 1;
    }
    for (const c of node.children) walkRender(c);
  };
  walkRender(recon.tree);

  return {
    image: fileName,
    imageWidth: width,
    imageHeight: height,
    nodeCount: recon.stats.nodeCount,
    predictionCount: predictions.length,
    coverage,
    renderModes,
    pageType: recon.semantics?.pageType ?? 'unknown',
    pageTypeConfidence: recon.semantics?.confidence ?? 0,
    componentCounts: recon.stats.componentCounts,
    diagnostics: recon.diagnostics?.skipped ?? [],
  };
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? join(homedir(), 'Desktop', 'UI');
  const outputPath = process.argv[3];
  const files = (await readdir(dir)).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).sort();
  if (files.length === 0) {
    console.error(`no images in ${dir}`);
    process.exit(1);
  }
  console.log(`benchmark: ${files.length} images in ${dir}\n`);

  const perImage: ImageResult[] = [];
  const stability: StabilityResult[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const f of files) {
    process.stdout.write(`  ${f}...`);
    try {
      const r1 = await runSingleImage(join(dir, f), f);
      // Stability: run again for determinism check
      const r2 = await runSingleImage(join(dir, f), f);
      const stable = r1.nodeCount === r2.nodeCount;
      perImage.push(r1);
      stability.push({ image: f, run1NodeCount: r1.nodeCount, run2NodeCount: r2.nodeCount, stable });
      succeeded++;
      console.log(` ok (nodes=${r1.nodeCount}, cov=${(r1.coverage * 100).toFixed(1)}%, stable=${stable})`);
    } catch (e) {
      perImage.push({
        image: f, imageWidth: 0, imageHeight: 0, nodeCount: 0, predictionCount: 0,
        coverage: 0, renderModes: {}, pageType: 'error', pageTypeConfidence: 0,
        componentCounts: {}, diagnostics: [], error: String(e).slice(0, 200),
      });
      failed++;
      console.log(` ERROR: ${String(e).slice(0, 100)}`);
    }
  }

  // Aggregate
  const totalPreds = perImage.reduce((s, r) => s + r.predictionCount, 0);
  const meanCov = perImage.length > 0 ? perImage.reduce((s, r) => s + r.coverage, 0) / perImage.length : 0;
  const meanNodes = perImage.length > 0 ? perImage.reduce((s, r) => s + r.nodeCount, 0) / perImage.length : 0;

  const renderDist: Record<string, number> = {};
  for (const r of perImage) {
    for (const [mode, count] of Object.entries(r.renderModes)) {
      renderDist[mode] = (renderDist[mode] ?? 0) + count;
    }
  }

  const typeDist: Record<string, number> = {};
  for (const r of perImage) {
    for (const [type, count] of Object.entries(r.componentCounts)) {
      typeDist[type] = (typeDist[type] ?? 0) + count;
    }
  }

  const report: BenchmarkReport = {
    totalImages: files.length,
    succeeded,
    failed,
    meanCoverage: meanCov,
    meanNodeCount: meanNodes,
    totalPredictions: totalPreds,
    renderModeDistribution: renderDist,
    componentTypeDistribution: typeDist,
    perImage,
    stability,
  };

  const json = JSON.stringify(report, null, 2);
  if (outputPath !== undefined && outputPath.length > 0) {
    await writeFile(outputPath, json, 'utf-8');
    console.log(`\nReport written to ${outputPath}`);
  } else {
    console.log(`\n${json}`);
  }

  console.log(`\nSummary: ${succeeded}/${files.length} succeeded, mean coverage=${(meanCov * 100).toFixed(1)}%, mean nodes=${meanNodes.toFixed(0)}`);
  const stableCount = stability.filter((s) => s.stable).length;
  console.log(`Stability: ${stableCount}/${stability.length} deterministic`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
