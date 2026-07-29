/**
 * Phase D: Active Learning - Frequency-Guided Priority CLI.
 *
 * Analyzes element type frequency across the reviewed dataset, identifies
 * underrepresented types, and ranks images by priority for next-round
 * annotation.
 *
 * Usage:
 *   npx tsx scripts/ui-active-learning.ts <dataset-dir> [output.json]
 */
import { writeFile } from 'node:fs/promises';
import {
  loadDatasetWithExclusions,
  analyzeTypeFrequency,
  buildPriorityQueue,
} from '../src/ui-analysis/benchmark/index.js';

function main(): void {
  const args = process.argv.slice(2);
  const datasetDir = args[0];
  const outputPath = args[1];

  if (!datasetDir) {
    console.error('usage: npx tsx scripts/ui-active-learning.ts <dataset-dir> [output.json]');
    process.exit(1);
  }

  const { entries, excluded } = loadDatasetWithExclusions(datasetDir);
  if (entries.length === 0) {
    console.error(`no eligible annotations found in ${datasetDir}`);
    process.exit(1);
  }

  const annotations = entries.map((e) => e.annotation);
  const freq = analyzeTypeFrequency(annotations);
  const queue = buildPriorityQueue(annotations, freq);

  console.log(`active learning: ${entries.length} eligible annotations in ${datasetDir}`);
  console.log(`excluded: ${excluded.length} sidecar files\n`);

  console.log(`Total elements (excl page): ${freq.totalElements} across ${entries.length} images`);
  console.log(`Element types: ${freq.totalTypes}`);
  console.log(`Threshold: ${freq.threshold} samples per type\n`);

  console.log('Type frequency:');
  const sorted = Object.entries(freq.counts).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sorted) {
    const mark = freq.thresholds[type] ? '✓' : '✗';
    console.log(`  ${mark} ${type}: ${count}${freq.thresholds[type] ? '' : ` (need ${freq.threshold - count} more)`}`);
  }

  console.log(`\nTypes meeting threshold: ${freq.typesMeetingThreshold.length}/${freq.totalTypes}`);
  console.log(`Types needing samples: ${freq.typesNeedingSamples.length}`);

  console.log('\nImage priority queue (top 10):');
  for (const entry of queue.slice(0, 10)) {
    console.log(`  ${entry.image}: score=${entry.score} types=[${entry.underrepresentedTypes.join(', ')}]`);
  }

  const report = {
    mode: 'active-learning' as const,
    datasetDir,
    eligible: entries.length,
    excluded: excluded.length,
    frequency: freq,
    priorityQueue: queue,
  };

  const json = JSON.stringify(report, null, 2);
  if (outputPath) {
    writeFile(outputPath, json, 'utf-8').then(() => {
      console.log(`\nReport written to ${outputPath}`);
    });
  } else {
    console.log(`\n${json}`);
  }
}

main();
