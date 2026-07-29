/**
 * Analyze pending `isolated-content` structure findings to discover patterns
 * that distinguish legitimately-page-level elements (status bar text, nav
 * labels, full-width banners) from real isolation issues needing human review.
 *
 * Loads all eligible annotations, runs `analyzeAnnotationStructure`, filters
 * to `isolated-content` findings NOT already covered by a session action, and
 * prints aggregate statistics + samples per category.
 *
 * Usage:
 *   npx tsx scripts/ui-analyze-isolated.ts <dataset-dir>
 */
import { readFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { basename, join, extname } from 'node:path';
import { loadAnnotation, isSidecarFile } from '../src/ui-analysis/benchmark/annotation-loader.js';
import {
  analyzeAnnotationStructure,
  findingSubjectId,
} from '../src/ui-analysis/annotation-workbench/tree.ts';
import type { AnnotationFile, AnnotationElement } from '../src/ui-analysis/benchmark/annotation-loader.js';
import type { ReviewSession } from '../src/ui-analysis/annotation-workbench/review-types.ts';
import type { BBox } from '../src/ir/types.js';

const CONTAINER_TYPES = new Set([
  'card', 'section', 'column', 'navbar', 'header', 'footer',
  'tabbar', 'toolbar', 'container', 'row', 'grid', 'list', 'table',
  'dialog', 'bottomSheet', 'drawer',
]);

function hasContainers(annotation: { elements: Array<{ type: string }> }): boolean {
  return annotation.elements.some((e) => CONTAINER_TYPES.has(e.type));
}

function findPage(annotation: AnnotationFile): AnnotationElement {
  const page = annotation.elements.find((e) => e.type === 'page');
  if (page) return page;
  // Fallback: synthesize a page element from imageSize.
  return {
    id: 'page',
    type: 'page',
    bbox: { x: 0, y: 0, w: annotation.imageSize.width, h: annotation.imageSize.height },
    render: 'page',
  };
}

// Text-pattern classification for isolated elements.
function classifyText(text: string | undefined): string {
  if (text === undefined || text === '') return 'none';
  const t = text.trim();
  if (t === '') return 'none';
  if (/^\d{1,2}:\d{2}$/.test(t)) return 'time';            // 9:41
  if (/^\d+%$/.test(t)) return 'percent';                  // 100%
  if (/^(AM|PM)$/i.test(t)) return 'ampm';
  // Carrier / signal / wifi style short tokens.
  if (/^(中国移动|中国联通|中国电信|WiFi|Wi-Fi|5G|4G|LTE|GPRS)$/i.test(t)) return 'status-token';
  if (t.length <= 4) return 'short-label';                 // 消息, 我的, 好友, 接受
  return 'long-text';
}

interface Record {
  file: string;
  elementId: string;
  type: string;
  text: string | undefined;
  bbox: BBox;
  hasContainers: boolean;
  position: 'top' | 'bottom' | 'middle';
  topBand: boolean;   // within top 5% of page
  bottomBand: boolean; // within bottom 5% of page
  fullWidth: boolean;  // width > 80% of page width
  textCategory: string;
  areaRatio: number;   // element area / page area
}

async function readSession(annotationPath: string): Promise<ReviewSession> {
  try {
    const raw = await readFile(`${annotationPath}.session.json`, 'utf-8');
    return JSON.parse(raw) as ReviewSession;
  } catch {
    return { actions: [] };
  }
}

/**
 * Load every non-draft annotation, bypassing Gate #5 (open-high-severity
 * findings) which otherwise excludes the annotations whose pending
 * isolated-content findings we are analyzing here. Sidecars and drafts are
 * still skipped.
 */
function loadAllAnnotations(dir: string): Array<{ annotation: AnnotationFile; annotationPath: string; fileName: string }> {
  const out: Array<{ annotation: AnnotationFile; annotationPath: string; fileName: string }> = [];
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

function count<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function topSamples(samples: Record[], n = 6): string[] {
  return samples.slice(0, n).map((r) =>
    `    [${r.file}] ${r.type} "${r.text ?? ''}" bbox={w:${Math.round(r.bbox.w)},h:${Math.round(r.bbox.h)},y:${Math.round(r.bbox.y)}} pos=${r.position}${r.fullWidth ? ' fullW' : ''}${r.hasContainers ? '' : ' noContainer'} textCat=${r.textCategory}`,
  );
}

async function main(): Promise<void> {
  const datasetDir = process.argv[2] ?? 'benchmark/datasets/dev/app';
  const entries = loadAllAnnotations(datasetDir);
  console.log(`analyze-isolated: ${entries.length} annotations\n`);

  const records: Record[] = [];
  let totalIsolated = 0;
  let alreadyReviewed = 0;

  for (const { annotation, annotationPath, fileName } of entries) {
    const page = findPage(annotation);
    const pageW = page.bbox.w;
    const pageH = page.bbox.h;
    const pageArea = pageW * pageH;
    const containers = hasContainers(annotation);

    const findings = analyzeAnnotationStructure(annotation);
    const session = await readSession(annotationPath);
    const reviewed = new Set(session.actions.map((a) => a.subjectId));

    for (const finding of findings) {
      if (finding.code !== 'isolated-content') continue;
      totalIsolated++;
      const subjectId = findingSubjectId(finding);
      if (reviewed.has(subjectId)) {
        alreadyReviewed++;
        continue;
      }
      const el = annotation.elements.find((e) => e.id === finding.elementId);
      if (!el) continue;
      const yRatio = el.bbox.y / pageH;
      const bottomRatio = (el.bbox.y + el.bbox.h) / pageH;
      const position: Record['position'] = yRatio < 0.10 ? 'top' : bottomRatio > 0.90 ? 'bottom' : 'middle';
      records.push({
        file: fileName,
        elementId: el.id,
        type: el.type,
        text: el.text,
        bbox: el.bbox,
        hasContainers: containers,
        position,
        topBand: yRatio < 0.05,
        bottomBand: bottomRatio > 0.95,
        fullWidth: el.bbox.w / pageW > 0.80,
        textCategory: classifyText(el.text),
        areaRatio: (el.bbox.w * el.bbox.h) / pageArea,
      });
    }
  }

  const pending = records.length;
  console.log(`isolated-content findings: ${totalIsolated}`);
  console.log(`already reviewed (session): ${alreadyReviewed}`);
  console.log(`pending (unreviewed): ${pending}\n`);

  console.log('=== Count by element type ===');
  for (const [k, v] of [...count(records, (r) => r.type)].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  console.log('\n=== Count by annotation has containers ===');
  for (const [k, v] of [...count(records, (r) => (r.hasContainers ? 'has-containers' : 'no-containers'))].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  console.log('\n=== Count by position (top10/bottom10/middle) ===');
  for (const [k, v] of [...count(records, (r) => r.position)].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  const top5 = records.filter((r) => r.topBand).length;
  const bot5 = records.filter((r) => r.bottomBand).length;
  console.log(`  (top 5% band: ${top5}, bottom 5% band: ${bot5})`);

  console.log('\n=== Count by full width (>80% page width) ===');
  for (const [k, v] of [...count(records, (r) => (r.fullWidth ? 'full-width' : 'not-full-width'))].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  console.log('\n=== Count by text category ===');
  for (const [k, v] of [...count(records, (r) => r.textCategory)].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  console.log('\n=== Cross: text category x position ===');
  const cross = new Map<string, number>();
  for (const r of records) {
    const k = `${r.textCategory} @ ${r.position}`;
    cross.set(k, (cross.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...cross].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  console.log('\n=== Cross: element type x position ===');
  const cross2 = new Map<string, number>();
  for (const r of records) {
    const k = `${r.type} @ ${r.position}`;
    cross2.set(k, (cross2.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...cross2].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  console.log('\n=== Samples: status-bar text (time/percent/status-token) ===');
  console.log(topSamples(records.filter((r) => ['time', 'percent', 'ampm', 'status-token'].includes(r.textCategory))).join('\n'));

  console.log('\n=== Samples: short-label text (<=4 chars) ===');
  console.log(topSamples(records.filter((r) => r.textCategory === 'short-label')).join('\n'));

  console.log('\n=== Samples: long-text (>4 chars) ===');
  console.log(topSamples(records.filter((r) => r.textCategory === 'long-text')).join('\n'));

  console.log('\n=== Samples: no text (icons/images) ===');
  console.log(topSamples(records.filter((r) => r.textCategory === 'none')).join('\n'));

  console.log('\n=== Samples: full-width elements ===');
  console.log(topSamples(records.filter((r) => r.fullWidth)).join('\n'));

  console.log('\n=== Samples: middle-position elements (potential real findings) ===');
  console.log(topSamples(records.filter((r) => r.position === 'middle' && r.hasContainers)).join('\n'));

  // Distribution of areaRatio to spot background/decorative full-bleed images.
  const bigImg = records.filter((r) => r.areaRatio > 0.3);
  console.log(`\n=== Elements covering >30% of page (likely background/decorative): ${bigImg.length} ===`);
  console.log(topSamples(bigImg).join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
