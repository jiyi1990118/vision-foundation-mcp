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
 * For isolated-content findings, suppresses elements that are legitimately
 * page-level rather than wrongly hoisted out of a container: container-less
 * layouts, bare icons, status-bar text (time/battery/carrier, incl. OCR-garbled
 * signal+battery strings), full-width banners/dividers, large background
 * images, and short header/tab-bar text in the top/bottom 5% bands. Middle-of-
 * page content text, normal content images, and interactive controls are left
 * as auto for human review.
 *
 * Persists review actions to session files via the workbench API, then
 * re-runs calibration to measure per-rule precision and update advisoryOnly.
 *
 * Usage:
 *   npx tsx scripts/ui-auto-calibrate.ts <dataset-dir> [--port 52000]
 */
import { readFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAnnotation, isSidecarFile } from '../src/ui-analysis/benchmark/annotation-loader.js';
import type { AnnotationFile, AnnotationElement } from '../src/ui-analysis/benchmark/annotation-loader.js';
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

// Position/size thresholds for `isolated-content` heuristics, expressed as
// ratios of the page element bbox. Tuned from the 738-finding pattern
// analysis: the very top/bottom bands are status-bar / header / tab-bar
// territory, and full-width or large-area images are decorative backgrounds
// rather than content wrongly hoisted to the page root.
const TOP_BAND_RATIO = 0.05;
const BOTTOM_BAND_RATIO = 0.95;
const FULL_WIDTH_RATIO = 0.80;
const BACKGROUND_AREA_RATIO = 0.20;
const SHORT_HEADER_MAX_CHARS = 8;
const SHORT_TABBAR_MAX_CHARS = 4;

export const CONTAINER_TYPES = new Set([
  'card', 'section', 'column', 'navbar', 'header', 'footer',
  'tabbar', 'toolbar', 'container', 'row', 'grid', 'list', 'table',
  'dialog', 'bottomSheet', 'drawer',
]);

export function hasContainers(annotation: { elements: Array<{ type: string }> }): boolean {
  return annotation.elements.some((e) => CONTAINER_TYPES.has(e.type));
}

function findPageElement(annotation: AnnotationFile): AnnotationElement | undefined {
  return annotation.elements.find((e) => e.type === 'page');
}

interface CalibrationEntry {
  annotation: AnnotationFile;
  annotationPath: string;
  fileName: string;
}

/**
 * Load every non-draft annotation in the dataset, including those that
 * `loadDatasetWithExclusions` excludes via Gate #5 (open-high-severity
 * findings). Auto-calibrate is a *review* operation whose whole job is to
 * resolve exactly those open findings, so it must see them even though they
 * are not yet benchmark-eligible. Sidecars and drafts are still skipped.
 */
export function loadAnnotationsForCalibration(dir: string): CalibrationEntry[] {
  const out: CalibrationEntry[] = [];
  const scan = (d: string): void => {
    for (const item of readdirSync(d)) {
      const full = join(d, item);
      if (statSync(full).isDirectory()) { scan(full); continue; }
      if (extname(item).toLowerCase() !== '.json') continue;
      if (isSidecarFile(item)) continue;
      let annotation: AnnotationFile;
      try { annotation = loadAnnotation(full); } catch { continue; }
      if (annotation.warnings.some((w) => w.includes('not human verified'))) continue;
      out.push({ annotation, annotationPath: full, fileName: item });
    }
  };
  scan(dir);
  return out;
}

function parseDeviation(evidence: string | undefined): number {
  const match = (evidence ?? '').match(/(\d+)%/g);
  if (!match) return 0;
  return Math.max(...match.map(m => parseInt(m)));
}

/**
 * Unambiguous status-bar tokens (time, battery percent, carrier/signal).
 * Legitimately page-level regardless of vertical position.
 */
function isStatusBarText(text: string | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  if (/^\d{1,2}:\d{2}$/.test(t)) return true;                          // 9:41
  if (/^\d+%$/.test(t)) return true;                                   // 100%
  if (/^(AM|PM)$/i.test(t)) return true;
  if (/^(中国移动|中国联通|中国电信|WiFi|Wi-Fi|5G|4G|LTE|GPRS)$/i.test(t)) return true;
  return false;
}

/**
 * OCR-garbled status-bar strings (signal + battery mangled into things like
 * "5G 5GI  100" or "55 44"). Only trustworthy when the element also sits in
 * the top band of the page, which the caller verifies before suppressing.
 */
function isGarbledStatusBarText(text: string | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t || t.length > 14) return false;
  if (/(5G|4G|LTE)/i.test(t) && /\d/.test(t)) return true;             // "5G5GAI100"
  if (/^[\d\s%G]+$/.test(t) && /\d/.test(t) && t.length <= 12) return true; // "55 44"
  return false;
}

export function heuristicAction(finding: StructureIssue, annotation: AnnotationFile): 'confirmed' | 'suppressed' | null {
  if (finding.code === 'sibling-size-inconsistent') {
    const dev = parseDeviation(finding.evidence);
    if (dev > CONFIRM_THRESHOLD) return 'confirmed';
    if (dev <= SUPPRESS_THRESHOLD) return 'suppressed';
    return null;
  }
  if (finding.code === 'sibling-overlap') {
    return null;
  }
  if (finding.code !== 'isolated-content') return null;

  // Coarse rules: container-less layouts and bare icons are not real
  // isolation issues.
  if (!hasContainers(annotation)) return 'suppressed';
  if (finding.type === 'icon') return 'suppressed';

  const element = annotation.elements.find((e) => e.id === finding.elementId);
  if (!element) return null;
  const text = element.text;
  const textLen = (text ?? '').trim().length;

  // Unambiguous status-bar tokens are legitimately page-level anywhere.
  if (isStatusBarText(text)) return 'suppressed';

  const page = findPageElement(annotation);
  if (!page) return null;
  const pw = page.bbox.w;
  const ph = page.bbox.h;
  if (pw <= 0 || ph <= 0) return null;

  const yRatio = element.bbox.y / ph;
  const bottomRatio = (element.bbox.y + element.bbox.h) / ph;
  const widthRatio = element.bbox.w / pw;
  const areaRatio = (element.bbox.w * element.bbox.h) / (pw * ph);
  const fullWidth = widthRatio > FULL_WIDTH_RATIO;
  const topBand = yRatio < TOP_BAND_RATIO;
  const bottomBand = bottomRatio > BOTTOM_BAND_RATIO;

  // Full-width elements at the page root are banners / dividers / full-bleed
  // backgrounds, not content wrongly hoisted out of a container.
  if (fullWidth) return 'suppressed';

  // Large images covering >20% of the page are decorative backgrounds.
  if (element.type === 'image' && areaRatio > BACKGROUND_AREA_RATIO) return 'suppressed';

  // Top band = status bar + page header territory.
  if (topBand) {
    if (element.type === 'text' && (isGarbledStatusBarText(text) || textLen <= SHORT_HEADER_MAX_CHARS)) {
      return 'suppressed';
    }
  }

  // Bottom band = tab bar / footer action territory.
  if (bottomBand) {
    if (element.type === 'avatar') return 'suppressed';
    if (element.type === 'text' && textLen <= SHORT_TABBAR_MAX_CHARS) return 'suppressed';
  }

  // Everything else (middle-of-page content text, normal-sized content
  // images, interactive controls) is a genuine isolation candidate that
  // needs human review.
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

  const entries = loadAnnotationsForCalibration(datasetDir);
  console.log(`auto-calibrate: ${entries.length} annotations\n`);

  let totalFindings = 0;
  let totalConfirmed = 0;
  let totalSuppressed = 0;
  let totalAuto = 0;

  for (const { annotation, annotationPath, fileName } of entries) {
    const fileParam = encodeURIComponent(fileName);

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
  for (const { annotation, annotationPath } of entries) {
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

const isMainModule = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isMainModule) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
