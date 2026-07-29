/**
 * Phase D: Automated Structure Rule Calibration.
 *
 * Runs heuristic auto-review on all structure findings across the dataset.
 * For sibling-size-inconsistent findings, parses the deviation percentage
 * from evidence and applies:
 *   - deviation > 50%  -> confirmed (likely a real issue)
 *   - deviation <= 35% -> suppressed (marginal, likely acceptable)
 *   - 35% < dev <= 50% -> left as auto (borderline, needs human review)
 *
 * Persists review actions to session files via the workbench API, then
 * re-runs calibration to measure per-rule precision and update advisoryOnly.
 *
 * Usage:
 *   npx tsx scripts/ui-auto-calibrate.ts <dataset-dir> [--port 52000]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { loadDatasetWithExclusions } from '../src/ui-analysis/benchmark/annotation-loader.js';
import {
  analyzeAnnotationStructure,
  findingSubjectId,
  findingSignature,
  STRUCTURE_RULES,
} from '../src/ui-analysis/annotation-workbench/tree.ts';
import {
  calibrateStructureRules,
  aggregateCalibration,
} from '../src/ui-analysis/annotation-workbench/calibration.ts';
import type { ReviewSession, ReviewAction } from '../src/ui-analysis/annotation-workbench/review-types.ts';
import type { StructureIssue } from '../src/ui-analysis/annotation-workbench/tree.ts';

const CONFIRM_THRESHOLD = 50;
const SUPPRESS_THRESHOLD = 35;

function parseDeviation(evidence: string): number {
  const match = evidence.match(/(\d+)%/g);
  if (!match) return 0;
  return Math.max(...match.map(m => parseInt(m)));
}

const CONTAINER_TYPES = new Set([
  'card', 'section', 'column', 'navbar', 'header', 'footer',
  'tabbar', 'toolbar', 'container', 'row', 'grid', 'list', 'table',
  'dialog', 'bottomSheet', 'drawer',
]);

function hasContainers(annotation: { elements: Array<{ type: string }> }): boolean {
  return annotation.elements.some((e) => CONTAINER_TYPES.has(e.type));
}

function heuristicAction(finding: StructureIssue, annotation: { elements: Array<{ type: string }> }): 'confirmed' | 'suppressed' | null {
  if (finding.code === 'sibling-size-inconsistent') {
    const dev = parseDeviation(finding.evidence);
    if (dev > CONFIRM_THRESHOLD) return 'confirmed';
    if (dev <= SUPPRESS_THRESHOLD) return 'suppressed';
    return null;
  }
  if (finding.code === 'isolated-content') {
    if (!hasContainers(annotation)) return 'suppressed';
    if (finding.type === 'icon') return 'suppressed';
    return null;
  }
  return null;
}

async function readSession(annotationPath: string): Promise<ReviewSession> {
  try {
    const raw = await readFile(`${annotationPath}.session.json`, 'utf-8');
    return JSON.parse(raw) as ReviewSession;
  } catch {
    return { actions: [] };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const datasetDir = args[0];
  const portIdx = process.argv.indexOf('--port');
  const port = portIdx !== -1 ? Number(process.argv[portIdx + 1]) : 52000;
  const baseUrl = `http://127.0.0.1:${port}`;

  if (!datasetDir) {
    console.error('usage: npx tsx scripts/ui-auto-calibrate.ts <dataset-dir> [--port 52000]');
    process.exit(1);
  }

  const { entries } = loadDatasetWithExclusions(datasetDir);
  console.log(`auto-calibrate: ${entries.length} eligible annotations\n`);

  let totalFindings = 0;
  let totalConfirmed = 0;
  let totalSuppressed = 0;
  let totalAuto = 0;

  for (const { annotation, imagePath } of entries) {
    const annotationDir = dirname(imagePath);
    const annotationFileName = basename(imagePath.replace(/\.(jpg|jpeg|png)$/i, '.json'));
    const annotationPath = join(annotationDir, annotationFileName);
    const fileParam = encodeURIComponent(annotationFileName);

    const findings = analyzeAnnotationStructure(annotation);
    totalFindings += findings.length;

    const session = await readSession(annotationPath);
    const existingActions = new Set(session.actions.map(a => a.subjectId));

    for (const finding of findings) {
      const subjectId = findingSubjectId(finding);
      if (existingActions.has(subjectId)) continue;

      const action = heuristicAction(finding, annotation);
      if (!action) {
        totalAuto++;
        continue;
      }

      const signature = findingSignature(finding);
      const reviewAction: ReviewAction = {
        id: `auto-${crypto.randomUUID()}`,
        subjectKind: 'structure-finding',
        subjectId,
        action,
        signature,
        createdAt: new Date().toISOString(),
      };

      try {
        const r = await fetch(`${baseUrl}/api/review-session?file=${fileParam}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(reviewAction),
        });
        if (!r.ok) throw new Error(await r.text());
      } catch (e) {
        console.error(`  ${annotation.image}: failed to persist action for ${subjectId}: ${e}`);
      }

      if (action === 'confirmed') totalConfirmed++;
      else totalSuppressed++;
    }
  }

  console.log(`Findings: ${totalFindings}`);
  console.log(`Auto-confirmed: ${totalConfirmed}`);
  console.log(`Auto-suppressed: ${totalSuppressed}`);
  console.log(`Left as auto (borderline): ${totalAuto}`);

  // Re-run calibration with persisted actions
  console.log('\nRe-running calibration...');
  const allCounts = [];
  for (const { annotation, imagePath } of entries) {
    const annotationDir = dirname(imagePath);
    const annotationPath = join(annotationDir, basename(imagePath.replace(/\.(jpg|jpeg|png)$/i, '.json')));
    const session = await readSession(annotationPath);
    allCounts.push(...calibrateStructureRules(annotation, session));
  }

  const aggregated = aggregateCalibration(allCounts);
  console.log('\nPer-rule calibration after auto-review:');
  for (const rule of STRUCTURE_RULES) {
    const result = aggregated[rule.code];
    if (!result) continue;
    const status = result.calibrated
      ? `precision=${(result.precision * 100).toFixed(1)}% (${result.reviewed} reviewed)`
      : `uncalibrated (${result.raised} raised, 0 reviewed)`;
    console.log(`  ${rule.code} v${result.version}: ${status} -> ${result.advisoryOnly ? 'advisory-only' : 'enforced'}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
