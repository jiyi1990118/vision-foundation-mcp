import { readFile } from 'node:fs/promises';
import { loadDatasetWithExclusions } from '../src/ui-analysis/benchmark/annotation-loader.js';
import {
  analyzeAnnotationStructure,
  findingSubjectId,
  findingSignature,
  STRUCTURE_RULES,
} from '../src/ui-analysis/annotation-workbench/tree.js';
import {
  calibrateStructureRules,
  aggregateCalibration,
} from '../src/ui-analysis/annotation-workbench/calibration.js';
import type { ReviewSession } from '../src/ui-analysis/annotation-workbench/review-types.js';

async function main(): Promise<void> {
  const datasetDir = process.argv[2] ?? 'benchmark/datasets/dev/app';
  const { entries } = loadDatasetWithExclusions(datasetDir);
  console.log(`Eligible annotations: ${entries.length}\n`);

  const allCounts = [];
  const ruleCounts: Record<string, { raised: number; confirmed: number; suppressed: number; auto: number }> = {};

  for (const { annotation, imagePath } of entries) {
    const annotationPath = imagePath.replace(/\.(jpg|jpeg|png)$/i, '.json');
    let session: ReviewSession = { actions: [] };
    try {
      const raw = await readFile(`${annotationPath}.session.json`, 'utf-8');
      session = JSON.parse(raw) as ReviewSession;
    } catch { /* no session */ }

    const findings = analyzeAnnotationStructure(annotation);
    for (const f of findings) {
      if (!ruleCounts[f.code]) ruleCounts[f.code] = { raised: 0, confirmed: 0, suppressed: 0, auto: 0 };
      ruleCounts[f.code].raised++;
      const subj = findingSubjectId(f);
      const existing = session.actions.find((a) => a.subjectId === subj);
      if (existing) {
        if (existing.action === 'confirmed' || existing.action === 'overridden') ruleCounts[f.code].confirmed++;
        else if (existing.action === 'suppressed') ruleCounts[f.code].suppressed++;
      } else {
        ruleCounts[f.code].auto++;
      }
    }
    allCounts.push(...calibrateStructureRules(annotation, session));
  }

  const aggregated = aggregateCalibration(allCounts);
  console.log('Per-rule calibration:');
  for (const rule of STRUCTURE_RULES) {
    const r = aggregated[rule.code];
    const c = ruleCounts[rule.code] || { raised: 0, confirmed: 0, suppressed: 0, auto: 0 };
    if (!r) { console.log(`  ${rule.code}: no data`); continue; }
    const status = r.calibrated
      ? `precision=${(r.precision * 100).toFixed(1)}% (${r.reviewed} reviewed)`
      : `uncalibrated (${r.raised} raised, 0 reviewed)`;
    console.log(`  ${rule.code} v${r.version}: ${status} -> ${r.advisoryOnly ? 'advisory-only' : 'enforced'}`);
    console.log(`    raised=${c.raised} confirmed=${c.confirmed} suppressed=${c.suppressed} auto=${c.auto}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
