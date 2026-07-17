/**
 * UI analysis pipeline benchmark - measures latency, determinism, and
 * structural counts of `analyzeUiPipeline` across representative synthetic
 * UiLayoutExtraction fixtures. Pure algorithm - no model / GPU / llama-server.
 *
 * Usage:
 *   npx tsx scripts/ui-benchmark.ts
 *   BENCH_RUNS=200 npx tsx scripts/ui-benchmark.ts
 *
 * Output:
 *   - Per-fixture latency (median / mean / p95 ms) and ops/sec
 *   - Determinism check (two-run JSON.stringify deep equality)
 *   - Structural counts (AST nodes, constraints, codegen/figma export success)
 *   - Markdown summary table on stdout
 *
 * Env:
 *   BENCH_RUNS  runs per fixture (default 50)
 *
 * Exit code: 0 on success, 1 if any determinism check fails.
 */
import { analyzeUiPipeline } from '../src/ui-analysis/pipeline.js';
import type { UiLayoutExtraction } from '../src/core/extractors/ui-layout-extractor.js';
import type { ASTNode } from '../src/ui-analysis/ir/types.js';

interface Fixture {
  name: string;
  layout: UiLayoutExtraction;
}

function loginPage(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'login',
      layoutType: 'centered',
      regions: [
        { id: 'h', type: 'header', bbox: { x: 0, y: 0, w: 400, h: 56 }, relativeArea: 0.05, children: [] },
        { id: 'm', type: 'main', bbox: { x: 0, y: 56, w: 400, h: 464 }, relativeArea: 0.9, children: [] },
        { id: 'c', type: 'card', bbox: { x: 100, y: 140, w: 200, h: 300 }, relativeArea: 0.4, children: [] },
      ],
    },
    components: [
      { type: 'input', bbox: { x: 120, y: 180, w: 160, h: 32 }, text: '', state: 'default', variant: 'default' },
      { type: 'input', bbox: { x: 120, y: 230, w: 160, h: 32 }, text: '', state: 'default', variant: 'default' },
      { type: 'button', bbox: { x: 120, y: 290, w: 160, h: 36 }, text: '', state: 'default', variant: 'primary' },
    ],
    texts: [
      { text: 'Welcome', bbox: { x: 150, y: 20, w: 100, h: 20 }, estimatedLevel: 'title' },
      { text: 'Sign In', bbox: { x: 140, y: 150, w: 120, h: 24 }, estimatedLevel: 'heading' },
      { text: 'Submit', bbox: { x: 160, y: 300, w: 80, h: 16 }, estimatedLevel: 'body' },
    ],
    spacing: { averageGap: 12, scale: 'comfortable', verticalGaps: [50, 50, 60], horizontalGaps: [] },
    mediaAreas: [],
    summary: 'login page',
  };
}

function adminThreeColumn(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'admin-ui',
      layoutType: 'sidebar',
      regions: [
        { id: 'h', type: 'header', bbox: { x: 0, y: 0, w: 1280, h: 56 }, relativeArea: 0.05, children: [] },
        { id: 's', type: 'sidebar', bbox: { x: 0, y: 56, w: 200, h: 744 }, relativeArea: 0.15, children: [] },
        { id: 'm', type: 'main', bbox: { x: 200, y: 56, w: 1080, h: 744 }, relativeArea: 0.7, children: [] },
        { id: 't', type: 'table', bbox: { x: 220, y: 160, w: 1040, h: 560 }, relativeArea: 0.5, children: [] },
      ],
    },
    components: [
      { type: 'button', bbox: { x: 220, y: 80, w: 90, h: 32 }, text: '', state: 'default', variant: 'primary' },
      { type: 'input', bbox: { x: 1000, y: 80, w: 100, h: 32 }, text: '', state: 'default', variant: 'default' },
      { type: 'avatar', bbox: { x: 1140, y: 80, w: 36, h: 32 }, text: '', state: 'default', variant: 'default' },
      { type: 'tab', bbox: { x: 220, y: 120, w: 60, h: 28 }, text: '', state: 'default', variant: 'default' },
      { type: 'tab', bbox: { x: 290, y: 120, w: 60, h: 28 }, text: '', state: 'default', variant: 'default' },
    ],
    texts: [
      { text: 'Admin', bbox: { x: 20, y: 18, w: 80, h: 20 }, estimatedLevel: 'heading' },
      { text: 'Users', bbox: { x: 240, y: 88, w: 60, h: 16 }, estimatedLevel: 'body' },
      { text: 'Records', bbox: { x: 240, y: 168, w: 80, h: 20 }, estimatedLevel: 'heading' },
    ],
    spacing: { averageGap: 10, scale: 'comfortable', verticalGaps: [104, 28], horizontalGaps: [70, 40] },
    mediaAreas: [],
    summary: 'admin 3-col + table',
  };
}

function cardListGrid(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'gallery',
      layoutType: 'grid',
      regions: [
        { id: 'h', type: 'header', bbox: { x: 0, y: 0, w: 600, h: 60 }, relativeArea: 0.05, children: [] },
        { id: 'm', type: 'main', bbox: { x: 0, y: 60, w: 600, h: 540 }, relativeArea: 0.9, children: [] },
        { id: 'c1', type: 'card', bbox: { x: 40, y: 100, w: 160, h: 200 }, relativeArea: 0.1, children: [] },
        { id: 'c2', type: 'card', bbox: { x: 220, y: 100, w: 160, h: 200 }, relativeArea: 0.1, children: [] },
        { id: 'c3', type: 'card', bbox: { x: 400, y: 100, w: 160, h: 200 }, relativeArea: 0.1, children: [] },
        { id: 'c4', type: 'card', bbox: { x: 40, y: 340, w: 160, h: 200 }, relativeArea: 0.1, children: [] },
        { id: 'c5', type: 'card', bbox: { x: 220, y: 340, w: 160, h: 200 }, relativeArea: 0.1, children: [] },
        { id: 'c6', type: 'card', bbox: { x: 400, y: 340, w: 160, h: 200 }, relativeArea: 0.1, children: [] },
      ],
    },
    components: [
      { type: 'badge', bbox: { x: 50, y: 110, w: 40, h: 20 }, text: '', state: 'default', variant: 'default' },
      { type: 'badge', bbox: { x: 230, y: 110, w: 40, h: 20 }, text: '', state: 'default', variant: 'default' },
      { type: 'badge', bbox: { x: 410, y: 110, w: 40, h: 20 }, text: '', state: 'default', variant: 'default' },
      { type: 'avatar', bbox: { x: 50, y: 350, w: 40, h: 40 }, text: '', state: 'default', variant: 'default' },
      { type: 'avatar', bbox: { x: 230, y: 350, w: 40, h: 40 }, text: '', state: 'default', variant: 'default' },
      { type: 'avatar', bbox: { x: 410, y: 350, w: 40, h: 40 }, text: '', state: 'default', variant: 'default' },
    ],
    texts: [
      { text: 'Products', bbox: { x: 20, y: 20, w: 100, h: 20 }, estimatedLevel: 'heading' },
      { text: 'Item 1', bbox: { x: 50, y: 160, w: 80, h: 16 }, estimatedLevel: 'body' },
      { text: 'Item 2', bbox: { x: 230, y: 160, w: 80, h: 16 }, estimatedLevel: 'body' },
      { text: 'Item 3', bbox: { x: 410, y: 160, w: 80, h: 16 }, estimatedLevel: 'body' },
    ],
    spacing: { averageGap: 20, scale: 'spacious', verticalGaps: [40, 140, 40], horizontalGaps: [20, 20] },
    mediaAreas: [],
    summary: 'card grid 3x2',
  };
}

function formVertical(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'form',
      layoutType: 'stack',
      regions: [
        { id: 'h', type: 'header', bbox: { x: 0, y: 0, w: 480, h: 60 }, relativeArea: 0.05, children: [] },
        { id: 'm', type: 'main', bbox: { x: 0, y: 60, w: 480, h: 700 }, relativeArea: 0.9, children: [] },
        { id: 'c', type: 'card', bbox: { x: 60, y: 100, w: 360, h: 620 }, relativeArea: 0.7, children: [] },
      ],
    },
    components: [
      { type: 'input', bbox: { x: 80, y: 140, w: 320, h: 36 }, text: '', state: 'default', variant: 'default' },
      { type: 'input', bbox: { x: 80, y: 200, w: 320, h: 36 }, text: '', state: 'default', variant: 'default' },
      { type: 'input', bbox: { x: 80, y: 260, w: 320, h: 80 }, text: '', state: 'default', variant: 'default' },
      { type: 'checkbox', bbox: { x: 80, y: 360, w: 20, h: 20 }, text: '', state: 'default', variant: 'default' },
      { type: 'button', bbox: { x: 80, y: 400, w: 120, h: 40 }, text: '', state: 'default', variant: 'primary' },
    ],
    texts: [
      { text: 'Contact', bbox: { x: 150, y: 20, w: 120, h: 24 }, estimatedLevel: 'title' },
      { text: 'Name', bbox: { x: 84, y: 120, w: 60, h: 14 }, estimatedLevel: 'caption' },
      { text: 'Send', bbox: { x: 100, y: 412, w: 60, h: 16 }, estimatedLevel: 'body' },
    ],
    spacing: { averageGap: 24, scale: 'comfortable', verticalGaps: [24, 24, 60, 100, 40], horizontalGaps: [] },
    mediaAreas: [],
    summary: 'vertical form',
  };
}

function complexDashboard(): UiLayoutExtraction {
  return {
    structure: {
      pageType: 'dashboard',
      layoutType: 'sidebar',
      regions: [
        { id: 'h', type: 'header', bbox: { x: 0, y: 0, w: 1440, h: 64 }, relativeArea: 0.05, children: [] },
        { id: 's', type: 'sidebar', bbox: { x: 0, y: 64, w: 220, h: 836 }, relativeArea: 0.13, children: [] },
        { id: 'm', type: 'main', bbox: { x: 220, y: 64, w: 1220, h: 836 }, relativeArea: 0.8, children: [] },
        { id: 'n', type: 'nav', bbox: { x: 240, y: 88, w: 1180, h: 44 }, relativeArea: 0.04, children: [] },
        { id: 'c1', type: 'card', bbox: { x: 240, y: 160, w: 360, h: 280 }, relativeArea: 0.1, children: [] },
        { id: 'c2', type: 'card', bbox: { x: 620, y: 160, w: 360, h: 280 }, relativeArea: 0.1, children: [] },
        { id: 'c3', type: 'card', bbox: { x: 1000, y: 160, w: 420, h: 280 }, relativeArea: 0.12, children: [] },
        { id: 't', type: 'table', bbox: { x: 240, y: 480, w: 1180, h: 380 }, relativeArea: 0.3, children: [] },
      ],
    },
    components: [
      { type: 'button', bbox: { x: 250, y: 96, w: 80, h: 32 }, text: '', state: 'default', variant: 'primary' },
      { type: 'tab', bbox: { x: 340, y: 96, w: 60, h: 28 }, text: '', state: 'default', variant: 'default' },
      { type: 'tab', bbox: { x: 410, y: 96, w: 60, h: 28 }, text: '', state: 'default', variant: 'default' },
      { type: 'input', bbox: { x: 1080, y: 96, w: 120, h: 32 }, text: '', state: 'default', variant: 'default' },
      { type: 'badge', bbox: { x: 250, y: 170, w: 50, h: 24 }, text: '', state: 'default', variant: 'default' },
      { type: 'avatar', bbox: { x: 520, y: 170, w: 40, h: 40 }, text: '', state: 'default', variant: 'default' },
      { type: 'badge', bbox: { x: 630, y: 170, w: 50, h: 24 }, text: '', state: 'default', variant: 'default' },
      { type: 'badge', bbox: { x: 1010, y: 170, w: 50, h: 24 }, text: '', state: 'default', variant: 'default' },
      { type: 'checkbox', bbox: { x: 250, y: 490, w: 20, h: 20 }, text: '', state: 'default', variant: 'default' },
      { type: 'button', bbox: { x: 250, y: 820, w: 80, h: 32 }, text: '', state: 'default', variant: 'ghost' },
    ],
    texts: [
      { text: 'Dashboard', bbox: { x: 20, y: 20, w: 140, h: 24 }, estimatedLevel: 'title' },
      { text: 'Overview', bbox: { x: 250, y: 168, w: 100, h: 20 }, estimatedLevel: 'heading' },
      { text: 'Sales', bbox: { x: 630, y: 168, w: 80, h: 20 }, estimatedLevel: 'heading' },
      { text: 'Traffic', bbox: { x: 1010, y: 168, w: 80, h: 20 }, estimatedLevel: 'heading' },
      { text: 'Records', bbox: { x: 250, y: 488, w: 80, h: 18 }, estimatedLevel: 'heading' },
    ],
    spacing: { averageGap: 20, scale: 'comfortable', verticalGaps: [72, 236, 40], horizontalGaps: [20, 20, 80] },
    mediaAreas: [],
    summary: 'complex dashboard',
  };
}

const FIXTURES: Fixture[] = [
  { name: 'login (simple)', layout: loginPage() },
  { name: 'admin (3-col+table)', layout: adminThreeColumn() },
  { name: 'card list (grid)', layout: cardListGrid() },
  { name: 'form (vertical)', layout: formVertical() },
  { name: 'dashboard (complex)', layout: complexDashboard() },
];

function countAstNodes(node: ASTNode): number {
  let n = 1;
  for (const child of node.children) n += countAstNodes(child);
  return n;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx]!;
}

interface BenchRow {
  fixture: string;
  regions: number;
  comps: number;
  astNodes: number;
  constraints: number;
  codegenOk: boolean;
  figmaOk: boolean;
  medianMs: number;
  meanMs: number;
  p95Ms: number;
  opsPerSec: number;
  deterministic: boolean;
}

const FULL_OPTS = {
  buildTree: true,
  exportCodegen: true,
  exportFigma: true,
  exportMarkdown: true,
};

function benchFixture(f: Fixture, runs: number): BenchRow {
  for (let i = 0; i < 3; i++) {
    analyzeUiPipeline({ uiLayoutExtraction: f.layout, options: FULL_OPTS });
  }

  const durs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    analyzeUiPipeline({ uiLayoutExtraction: f.layout, options: FULL_OPTS });
    durs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  durs.sort((a, b) => a - b);

  const med = median(durs);
  const mean = durs.reduce((s, x) => s + x, 0) / durs.length;
  const p95 = percentile(durs, 0.95);
  const ops = mean > 0 ? 1000 / mean : 0;

  const r1 = analyzeUiPipeline({ uiLayoutExtraction: f.layout, options: FULL_OPTS });
  const r2 = analyzeUiPipeline({ uiLayoutExtraction: f.layout, options: FULL_OPTS });
  const deterministic = JSON.stringify(r1) === JSON.stringify(r2);

  const sample = analyzeUiPipeline({ uiLayoutExtraction: f.layout, options: FULL_OPTS });
  const astNodes = sample.ui ? countAstNodes(sample.ui.root) : 0;
  const constraints = sample.codegenIr ? sample.codegenIr.constraints.length : 0;
  const codegenOk = !!sample.codegenIr;
  const figmaOk = typeof sample.figma === 'object' && sample.figma !== null && 'document' in sample.figma;

  return {
    fixture: f.name,
    regions: f.layout.structure.regions.length,
    comps: f.layout.components.length,
    astNodes,
    constraints,
    codegenOk,
    figmaOk,
    medianMs: med,
    meanMs: mean,
    p95Ms: p95,
    opsPerSec: ops,
    deterministic,
  };
}

function fmt(n: number, decimals: number): string {
  return n.toFixed(decimals);
}

function printReport(rows: BenchRow[], runs: number): void {
  console.log(`\n=== UI Pipeline Benchmark ===`);
  console.log(`runs per fixture: ${runs}  (3 warmup runs discarded)\n`);

  console.log('| Fixture                  | Regions | Comps | AST | Constr | Codegen | Figma | Median (ms) | Mean (ms) | p95 (ms) | ops/sec | Deterministic |');
  console.log('|--------------------------|---------|-------|-----|--------|---------|-------|-------------|-----------|----------|---------|---------------|');
  for (const r of rows) {
    console.log(
      `| ${r.fixture.padEnd(24)} | ${String(r.regions).padStart(7)} | ${String(r.comps).padStart(5)} | ${String(r.astNodes).padStart(3)} | ${String(r.constraints).padStart(6)} | ${(r.codegenOk ? 'ok' : 'FAIL').padStart(7)} | ${(r.figmaOk ? 'ok' : 'FAIL').padStart(5)} | ${fmt(r.medianMs, 4).padStart(11)} | ${fmt(r.meanMs, 4).padStart(9)} | ${fmt(r.p95Ms, 4).padStart(8)} | ${String(Math.round(r.opsPerSec)).padStart(7)} | ${(r.deterministic ? 'true' : 'FALSE').padEnd(13)} |`,
    );
  }

  const detOk = rows.filter((r) => r.deterministic).length;
  console.log(`\nDeterminism: ${detOk}/${rows.length} fixtures deterministic`);

  const totalMean = rows.reduce((s, r) => s + r.meanMs, 0) / rows.length;
  console.log(`Mean latency across fixtures: ${fmt(totalMean, 4)} ms (${fmt(1000 / totalMean, 0)} ops/sec aggregate mean)`);
}

function main(): void {
  const runs = parseInt(process.env.BENCH_RUNS ?? '50', 10);
  const rows: BenchRow[] = [];
  for (const f of FIXTURES) {
    const row = benchFixture(f, runs);
    rows.push(row);
    console.log(`  measured: ${f.name} -> median ${fmt(row.medianMs, 4)} ms, deterministic=${row.deterministic}`);
  }
  printReport(rows, runs);

  const failed = rows.filter((r) => !r.deterministic);
  if (failed.length > 0) {
    console.error(`\n!! determinism check FAILED for: ${failed.map((r) => r.fixture).join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
