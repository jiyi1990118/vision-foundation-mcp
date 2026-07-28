/**
 * Phase B4: Structural Rule Calibration CLI.
 *
 * Runs the structure rules over the reviewed holdout corpus, cross-references
 * findings against persisted review sessions, and reports per-rule precision
 * and advisory-only status.
 *
 * Usage:
 *   npx tsx scripts/ui-rule-calibration.ts <dataset-dir> [output.json]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { loadDatasetWithExclusions } from '../src/ui-analysis/benchmark/annotation-loader.js';
import {
  calibrateStructureRules,
  aggregateCalibration,
  type RuleCalibrationCounts,
} from '../src/ui-analysis/annotation-workbench/calibration.js';
import { STRUCTURE_RULES } from '../src/ui-analysis/annotation-workbench/tree.js';
import type { ReviewSession } from '../src/ui-analysis/annotation-workbench/review-types.js';

async function readSession(annotationPath: string): Promise<ReviewSession> {
  try {
    const raw = await readFile(`${annotationPath}.session.json`, 'utf-8');
    return JSON.parse(raw) as ReviewSession;
  } catch {
    return { actions: [] };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const datasetDir = args[0];
  const outputPath = args[1];

  if (!datasetDir) {
    console.error('usage: npx tsx scripts/ui-rule-calibration.ts <dataset-dir> [output.json]');
    process.exit(1);
  }

  const { entries, excluded } = loadDatasetWithExclusions(datasetDir);
  if (entries.length === 0) {
    console.error(`no eligible (reviewed) annotations found in ${datasetDir}`);
    process.exit(1);
  }

  console.log(`rule calibration: ${entries.length} eligible annotations in ${datasetDir}`);
  console.log(`excluded: ${excluded.length} annotations (draft/sidecar/invalid)\n`);

  const perImage: Array<{ image: string; counts: RuleCalibrationCounts[] }> = [];
  const allCounts: RuleCalibrationCounts[] = [];

  for (const { annotation, imagePath } of entries) {
    const annotationPath = join(dirname(imagePath), imagePath.replace(/\.(jpg|jpeg|png)$/i, '.json'));
    const session = await readSession(annotationPath);
    const counts = calibrateStructureRules(annotation, session);
    perImage.push({ image: annotation.image, counts });
    allCounts.push(...counts);

    const raised = counts.reduce((s, c) => s + c.raised, 0);
    const reviewed = counts.reduce((s, c) => s + c.confirmed + c.overridden + c.suppressed + c.rejected, 0);
    console.log(`  ${annotation.image}: raised=${raised} reviewed=${reviewed}`);
  }

  const aggregated = aggregateCalibration(allCounts);

  console.log('\nPer-rule calibration:');
  for (const rule of STRUCTURE_RULES) {
    const result = aggregated[rule.code];
    if (!result) {
      console.log(`  ${rule.code}: no data`);
      continue;
    }
    const status = result.calibrated
      ? `precision=${(result.precision * 100).toFixed(1)}% (${result.reviewed} reviewed)`
      : `uncalibrated (${result.raised} raised, 0 reviewed)`;
    console.log(`  ${rule.code} v${result.version}: ${status} -> ${result.advisoryOnly ? 'advisory-only' : 'enforced'}`);
  }

  const report = {
    mode: 'calibration' as const,
    datasetDir,
    eligible: entries.length,
    excluded: excluded.length,
    perImage,
    rules: aggregated,
  };

  const json = JSON.stringify(report, null, 2);
  if (outputPath) {
    await writeFile(outputPath, json, 'utf-8');
    console.log(`\nReport written to ${outputPath}`);
  } else {
    console.log(`\n${json}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
