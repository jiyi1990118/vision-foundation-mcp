/**
 * Real-image validation (review item C1) - runs the full UI analysis pipeline
 * (extractUiLayout CV + extractDesignTokens + runUiAnalysis) over real UI
 * screenshots and prints per-image structural stats + degradation, to surface
 * heuristic issues invisible under synthetic fixtures.
 *
 * No VLM / no OCR provider: pure CV + algorithm path. OCR text binding is
 * skipped (texts empty), so type rules that need OCR (select/radio/checkbox)
 * will not fire here - that is expected.
 *
 * Usage:
 *   npx tsx scripts/ui-realimage-check.ts [dir]
 *   dir defaults to ~/Desktop/UI
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { extractUiLayoutForAnalysis } from '../src/ui-analysis/adapters/index.js';
import { extractDesignTokens } from '../src/core/extractors/design-extractor.js';
import { runUiAnalysis } from '../src/ui-analysis/orchestrator.js';
import type { ImageInput } from '../src/types/domain.js';

function mimeOf(f: string): string {
  return /\.(png)$/i.test(f) ? 'image/png' : 'image/jpeg';
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? join(homedir(), 'Desktop', 'UI');
  const files = (await readdir(dir)).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).sort();
  if (files.length === 0) {
    console.error(`no images in ${dir}`);
    process.exit(1);
  }
  console.log(`real-image check: ${files.length} images in ${dir}\n`);

  for (const f of files) {
    const label = f.length > 30 ? f.slice(0, 27) + '...' : f;
    try {
      const buffer = await readFile(join(dir, f));
      const image: ImageInput = { buffer, mimeType: mimeOf(f), source: f, size: buffer.length };
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
        console.log(`${label}\n  -- no uiReconstruction --`);
        continue;
      }
      const topTypes = Object.entries(recon.stats.componentCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([t, c]) => `${t}:${c}`)
        .join(' ');
      const pt = recon.semantics?.pageType ?? 'unknown';
      const conf = recon.semantics?.confidence ?? 0;
      const reps = recon.repeats?.length ?? 0;
      const slots = recon.slots?.length ?? 0;
      const imgs = recon.images.length;
      const regions = layout.structure.regions.length;
      const comps = layout.components.length;
      const diag = recon.diagnostics?.skipped.join(',') ?? '-';
      console.log(
        `${label}\n  nodes=${recon.stats.nodeCount} regions=${regions} comps=${comps} pageType=${pt}(${conf.toFixed(2)}) repeats=${reps} slots=${slots} images=${imgs} diag=${diag}`,
      );
      console.log(`  types: ${topTypes}`);
    } catch (e) {
      console.log(`${label}\n  ERROR: ${String(e).slice(0, 120)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
