/**
 * Real-image OCR validation - runs the full pipeline WITH OCR on real UI
 * screenshots, so detectComponents can recover button/input/text/tab elements
 * (which are invisible in the no-OCR path). Dumps the recognized tree per
 * image to show actual layout & element recognition.
 *
 * First run downloads the PaddleOCR model (~80MB) into ~/.vision-mcp.
 *
 * Usage: npx tsx scripts/ui-realimage-ocr.ts [dir] [limit=3]
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { extractUiLayoutForAnalysis } from '../src/ui-analysis/adapters/index.js';
import { extractDesignTokens } from '../src/core/extractors/design-extractor.js';
import { extractOcrItems } from '../src/core/key-content-extractor.js';
import { runUiAnalysis } from '../src/ui-analysis/orchestrator.js';
import { PpuPaddleOcrProvider } from '../src/providers/ppu-paddle-ocr/provider.js';
import type { ImageInput } from '../src/types/domain.js';
import type { ASTNode } from '../src/ui-analysis/ir/types.js';

function mimeOf(f: string): string {
  return /\.(png)$/i.test(f) ? 'image/png' : 'image/jpeg';
}

function dumpTree(node: ASTNode, depth: number, maxDepth: number): void {
  const indent = '  '.repeat(depth);
  const w = Math.round(node.bbox.w);
  const h = Math.round(node.bbox.h);
  const text = node.text ? ` "${node.text.slice(0, 20)}"` : '';
  const s = node.props.style as { backgroundColor?: string } | undefined;
  const bg = s?.backgroundColor ? ` bg=${s.backgroundColor}` : '';
  console.log(`${indent}${node.type} ${w}x${h}${text}${bg}`);
  if (depth < maxDepth) {
    for (const c of node.children) dumpTree(c, depth + 1, maxDepth);
  } else if (node.children.length > 0) {
    console.log(`${indent}  ...${node.children.length} children (truncated)`);
  }
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? join(homedir(), 'Desktop', 'UI');
  const limit = parseInt(process.argv[3] ?? '3', 10);
  const files = (await readdir(dir)).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).sort().slice(0, limit);
  if (files.length === 0) {
    console.error(`no images in ${dir}`);
    process.exit(1);
  }
  console.error(`OCR validation: ${files.length} images (loading OCR model, first run downloads ~80MB)...`);
  const ocrProvider = new PpuPaddleOcrProvider();
  await ocrProvider.load();
  console.error('OCR ready\n');

  for (const f of files) {
    console.log('='.repeat(90));
    console.log(`IMG: ${f}`);
    try {
      const buffer = await readFile(join(dir, f));
      const image: ImageInput = { buffer, mimeType: mimeOf(f), source: f, size: buffer.length };
      const design = await extractDesignTokens(image).catch(() => undefined);
      const palette = design?.palette.map((p) => ({ hex: p.hex, role: p.role }));
      const ocrRes = await ocrProvider.infer({ image, prompt: '', maxTokens: 0 });
      const normalized = JSON.parse(ocrRes.text);
      const ocrItems = extractOcrItems(normalized, 'full');
      console.log(
        `OCR: ${ocrItems.length} texts -> ${ocrItems.slice(0, 8).map((i) => `"${i.text}"`).join(' ')}${ocrItems.length > 8 ? ' ...' : ''}`,
      );
      const layout = await extractUiLayoutForAnalysis(image, ocrItems, palette);
      const result = await runUiAnalysis({
        uiLayoutExtraction: layout,
        ...(design ? { designExtraction: design } : {}),
        ocrItems,
        image,
      });
      const recon = result.uiReconstruction;
      if (!recon) {
        console.log('  -- no uiReconstruction --');
        continue;
      }
      console.log(
        `pageType=${recon.semantics?.pageType}(${recon.semantics?.confidence}) nodes=${recon.stats.nodeCount} regions=${layout.structure.regions.length} comps=${layout.components.length}`,
      );
      console.log(`summary: ${recon.semantics?.summary}`);
      console.log(
        `componentCounts: ${Object.entries(recon.stats.componentCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([t, c]) => `${t}:${c}`)
          .join(' ')}`,
      );
      console.log('tree:');
      dumpTree(recon.tree, 0, 5);
    } catch (e) {
      console.log(`  ERROR: ${String(e).slice(0, 200)}`);
    }
  }
  await ocrProvider.unload();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
