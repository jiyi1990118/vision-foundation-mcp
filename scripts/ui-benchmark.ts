/**
 * P4 Benchmark runner - runs the full UI analysis pipeline over real UI
 * screenshots and emits a coverage/stability report.
 *
 * Two modes:
 *   1. Coverage mode (default): no ground-truth annotations. Computes per-image
 *      coverage, node count, render mode distribution, and determinism check.
 *   2. Annotated mode (--annotations <dir>): loads ground-truth annotation JSON
 *      files from <dir>, computes IoU/recall/precision/F1 against predictions.
 *
 * Usage:
 *   npx tsx scripts/ui-benchmark.ts [dir] [output.json]
 *   npx tsx scripts/ui-benchmark.ts --annotations <dir> [output.json]
 *   dir defaults to ~/Desktop/UI
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import sharp from 'sharp';
import { extractUiLayoutForAnalysis } from '../src/ui-analysis/adapters/index.js';
import { extractDesignTokens } from '../src/core/extractors/design-extractor.js';
import { runUiAnalysis } from '../src/ui-analysis/orchestrator.js';
import { PpuPaddleOcrProvider } from '../src/providers/ppu-paddle-ocr/provider.js';
import { ocrItemsFromInferenceResponse } from '../src/ui-analysis/annotation-workbench/generation.js';
import {
  extractPredictionsFromAst,
  astToPredictions,
  loadDatasetWithExclusions,
  annotationToGroundTruth,
  computeMetrics,
} from '../src/ui-analysis/benchmark/index.js';
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

async function runAnnotatedBenchmark(
  datasetDir: string,
  outputPath: string | undefined,
): Promise<void> {
  const { entries, excluded } = loadDatasetWithExclusions(datasetDir);
  if (entries.length === 0) {
    console.error(`no annotation+image pairs found in ${datasetDir}`);
    process.exit(1);
  }
  const excludedByReason = excluded.reduce<Record<string, number>>((counts, item) => {
    counts[item.reason] = (counts[item.reason] ?? 0) + 1;
    return counts;
  }, {});
  const exclusionCounts = {
    eligible: entries.length,
    draftExcluded: excluded.filter((item) => item.reason.startsWith('draft:')).length,
    sidecarExcluded: excluded.filter((item) => item.reason === 'sidecar').length,
    invalidExcluded: excluded.filter((item) => item.reason.startsWith('invalid:')).length,
    openHighSeverityExcluded: excluded.filter((item) => item.reason === 'open-high-severity').length,
  };
  console.log(`annotated benchmark: ${entries.length} eligible images in ${datasetDir}`);
  if (excluded.length > 0) {
    console.log(`excluded: ${excluded.length} (${Object.entries(excludedByReason).map(([reason, count]) => `${reason}=${count}`).join(', ')})`);
  }
  console.log('');

  interface AnnotatedImageResult {
    image: string;
    recall: number;
    precision: number;
    f1: number;
    matched: number;
    gtCount: number;
    predCount: number;
    error?: string;
  }

  const perImage: AnnotatedImageResult[] = [];
  let succeeded = 0;
  let failed = 0;

  const ocrProvider = new PpuPaddleOcrProvider();

  for (const { annotation, imagePath } of entries) {
    const imageName = annotation.image;
    process.stdout.write(`  ${imageName}...`);
    try {
      const buffer = await readFile(imagePath);
      const { width, height } = await getDimensions(buffer);
      const image: ImageInput = { buffer, mimeType: mimeOf(imageName), source: imageName, size: buffer.length };
      const design = await extractDesignTokens(image).catch(() => undefined);
      let ocrItems;
      try {
        const ocrResult = await ocrProvider.infer({ image, prompt: '', maxTokens: 0, temperature: 0 });
        ocrItems = ocrItemsFromInferenceResponse(ocrResult);
      } catch {
        ocrItems = undefined;
      }
      const layout = await extractUiLayoutForAnalysis(
        image,
        ocrItems,
        design?.palette.map((p) => ({ hex: p.hex, role: p.role })),
      );
      const result = await runUiAnalysis({
        uiLayoutExtraction: layout,
        ...(design ? { designExtraction: design } : {}),
        ...(ocrItems ? { ocrItems } : {}),
        image,
        options: { reconstructionMode: 'balanced' },
      });
      const recon = result.uiReconstruction;
      if (!recon) {
        perImage.push({ image: imageName, recall: 0, precision: 0, f1: 0, matched: 0, gtCount: annotation.elements.length, predCount: 0, error: 'no-reconstruction' });
        failed++;
        console.log(' ERROR: no reconstruction');
        continue;
      }
      const preds = astToPredictions({ root: recon.tree });
      const gt = annotationToGroundTruth(annotation);
      const metrics = computeMetrics(gt, preds, { iouThreshold: 0.5, imageWidth: width, imageHeight: height });
      perImage.push({
        image: imageName,
        recall: metrics.recall,
        precision: metrics.precision,
        f1: metrics.f1,
        matched: metrics.matchedCount,
        gtCount: metrics.gtCount,
        predCount: metrics.predCount,
      });
      succeeded++;
      console.log(` ok (R=${(metrics.recall * 100).toFixed(1)}%, P=${(metrics.precision * 100).toFixed(1)}%, F1=${metrics.f1.toFixed(3)})`);
    } catch (e) {
      perImage.push({ image: imageName, recall: 0, precision: 0, f1: 0, matched: 0, gtCount: 0, predCount: 0, error: String(e).slice(0, 200) });
      failed++;
      console.log(` ERROR: ${String(e).slice(0, 100)}`);
    }
  }

  const count = Math.max(1, perImage.length);
  const meanRecall = perImage.reduce((s, r) => s + r.recall, 0) / count;
  const meanPrecision = perImage.reduce((s, r) => s + r.precision, 0) / count;
  const meanF1 = perImage.reduce((s, r) => s + r.f1, 0) / count;

  const report = {
    mode: 'annotated' as const,
    totalImages: entries.length,
    exclusions: {
      ...exclusionCounts,
      totalExcluded: excluded.length,
      byReason: excludedByReason,
      items: excluded,
    },
    succeeded,
    failed,
    meanRecall,
    meanPrecision,
    meanF1,
    perImage,
  };

  const json = JSON.stringify(report, null, 2);
  if (outputPath !== undefined && outputPath.length > 0) {
    await writeFile(outputPath, json, 'utf-8');
    console.log(`\nReport written to ${outputPath}`);
  } else {
    console.log(`\n${json}`);
  }

  console.log(`\nSummary: ${succeeded}/${entries.length} succeeded, mean R=${(meanRecall * 100).toFixed(1)}%, P=${(meanPrecision * 100).toFixed(1)}%, F1=${meanF1.toFixed(3)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Filter out flag arguments and their values (e.g. --runs 1) so they
  // aren't treated as positional paths. Absolute paths (starting with /)
  // are never consumed as flag values.
  const skip = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith('--')) {
      skip.add(i);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--') && !/^\//.test(next)) {
        skip.add(i + 1);
      }
    }
  }
  const positional = args.filter((_, i) => !skip.has(i));

  const annotationsIdx = args.indexOf('--annotations');
  if (annotationsIdx !== -1) {
    const datasetDir = args[annotationsIdx + 1];
    if (!datasetDir) {
      console.error('--annotations requires a directory argument');
      process.exit(1);
    }
    await runAnnotatedBenchmark(datasetDir, positional[0]);
    return;
  }

  const dir = positional[0] ?? join(homedir(), 'Desktop', 'UI');
  const outputPath = positional[1];
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
