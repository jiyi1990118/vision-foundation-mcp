/**
 * Phase C2/C3: Dataset Export CLI with split assignment.
 *
 * Exports all eligible (reviewed) samples from a dataset directory with
 * separated fields and per-sample manifests. When --splits is passed,
 * assigns train/validation/test splits by screenshot family and verifies
 * no family-level leakage.
 *
 * Usage:
 *   npx tsx scripts/ui-dataset-export.ts <dataset-dir> [--output <report.json>] [--splits] [--seed N]
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  exportDataset,
  assignSplits,
  verifyNoLeakage,
  defaultFamilyKey,
  type SplitAssignment,
} from '../src/ui-analysis/benchmark/index.js';

function parseArgs(argv: string[]): {
  datasetDir: string;
  outputPath: string | undefined;
  wantSplits: boolean;
  seed: number;
} {
  const positional: string[] = [];
  let outputPath: string | undefined;
  let wantSplits = false;
  let seed = 0;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--splits') {
      wantSplits = true;
    } else if (arg === '--seed') {
      seed = Number(argv[++i] ?? 0);
    } else if (arg.startsWith('--seed=')) {
      seed = Number(arg.slice('--seed='.length) || 0);
    } else if (arg === '--output' || arg === '-o') {
      outputPath = argv[++i];
    } else if (arg.startsWith('--output=')) {
      outputPath = arg.slice('--output='.length);
    } else if (arg.startsWith('-')) {
      console.error(`unknown flag: ${arg}`);
      process.exit(1);
    } else {
      positional.push(arg);
    }
  }

  return { datasetDir: positional[0], outputPath, wantSplits, seed };
}

function main(): void {
  const { datasetDir, outputPath, wantSplits, seed } = parseArgs(process.argv.slice(2));

  if (!datasetDir) {
    console.error('usage: npx tsx scripts/ui-dataset-export.ts <dataset-dir> [--output <report.json>] [--splits] [--seed N]');
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
    mkdir(dirname(outputPath), { recursive: true })
      .then(() => writeFile(outputPath, json, 'utf-8'))
      .then(() => {
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
