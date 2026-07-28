/**
 * Phase C2/C3: Dataset Export CLI with split assignment.
 *
 * Exports all eligible (reviewed) samples from a dataset directory with
 * separated fields and per-sample manifests. When --splits is passed,
 * assigns train/validation/test splits by screenshot family and verifies
 * no family-level leakage.
 *
 * Usage:
 *   npx tsx scripts/ui-dataset-export.ts <dataset-dir> [output.json] [--splits] [--seed N]
 */
import { writeFile } from 'node:fs/promises';
import {
  exportDataset,
  assignSplits,
  verifyNoLeakage,
  defaultFamilyKey,
  type SplitAssignment,
} from '../src/ui-analysis/benchmark/index.js';

function main(): void {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const datasetDir = positional[0];
  const outputPath = positional[1];
  const wantSplits = args.includes('--splits');
  const seedIdx = args.indexOf('--seed');
  const seed = seedIdx !== -1 ? Number(args[seedIdx + 1] ?? 0) : 0;

  if (!datasetDir) {
    console.error('usage: npx tsx scripts/ui-dataset-export.ts <dataset-dir> [output.json] [--splits] [--seed N]');
    process.exit(1);
  }

  const samples = exportDataset(datasetDir);
  if (samples.length === 0) {
    console.error(`no eligible (reviewed) annotations found in ${datasetDir}`);
    process.exit(1);
  }

  console.log(`dataset export: ${samples.length} eligible samples from ${datasetDir}`);

  let splitAssignment: SplitAssignment | null = null;
  let leakage = { ok: true, leakedFamilies: [] as string[] };

  if (wantSplits) {
    splitAssignment = assignSplits(samples.map((s) => s.manifest), { seed });
    for (const sample of samples) {
      sample.manifest.split = splitAssignment[sample.sampleId] ?? null;
    }
    leakage = verifyNoLeakage(samples.map((s) => s.manifest), splitAssignment);
    if (!leakage.ok) {
      console.error(`LEAKAGE DETECTED: families spanning multiple splits: ${leakage.leakedFamilies.join(', ')}`);
      process.exit(1);
    }
    console.log('split verification: no family-level leakage');
  }

  const report = {
    mode: 'export' as const,
    datasetDir,
    totalSamples: samples.length,
    splits: splitAssignment,
    leakageCheck: leakage,
    samples,
  };

  const json = JSON.stringify(report, null, 2);
  if (outputPath) {
    writeFile(outputPath, json, 'utf-8').then(() => {
      console.log(`Report written to ${outputPath}`);
      printSummary(samples, splitAssignment);
    });
  } else {
    console.log(json);
    printSummary(samples, splitAssignment);
  }
}

function printSummary(samples: ReturnType<typeof exportDataset>, splits: SplitAssignment | null): void {
  console.log(`\nSummary: ${samples.length} samples exported`);
  for (const sample of samples) {
    const fields = [
      'human-final',
      sample.pipelinePrediction ? 'prediction' : '',
      sample.aiPreReview ? 'ai-review' : '',
      sample.reviewActions ? 'review-actions' : '',
    ].filter(Boolean).join(', ');
    const split = splits?.[sample.sampleId] ?? 'n/a';
    const family = defaultFamilyKey(sample.manifest);
    console.log(`  ${sample.sampleId}: ${fields} (split=${split}, family=${family})`);
  }
}

main();
