/**
 * Real-image detail dump (C1 follow-up) - prints the actual uiReconstruction
 * tree (indented, per-node type/size/text/style) plus theme/pageType/regions
 * for each real UI screenshot, so the recognized layout & elements are
 * visible and heuristic issues can be read directly off the tree.
 *
 * Usage: npx tsx scripts/ui-realimage-detail.ts [dir] [maxDepth=5]
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { extractUiLayoutForAnalysis } from '../src/ui-analysis/adapters/index.js';
import { extractDesignTokens } from '../src/core/extractors/design-extractor.js';
import { runUiAnalysis } from '../src/ui-analysis/orchestrator.js';
import type { ImageInput } from '../src/types/domain.js';
import type { ASTNode } from '../src/ui-analysis/ir/types.js';

function mimeOf(f: string): string {
  return /\.(png)$/i.test(f) ? 'image/png' : 'image/jpeg';
}

function dumpTree(node: ASTNode, depth: number, maxDepth: number): void {
  const indent = '  '.repeat(depth);
  const w = Math.round(node.bbox.w);
  const h = Math.round(node.bbox.h);
  const text = node.text ? ` "${node.text.slice(0, 24)}"` : '';
  const s = node.props.style as
    | { backgroundColor?: string; borderRadius?: number; borderColor?: string; textColor?: string }
    | undefined;
  const bg = s?.backgroundColor ? ` bg=${s.backgroundColor}` : '';
  const r = s?.borderRadius ? ` r=${s.borderRadius}` : '';
  const bd = s?.borderColor ? ` border=${s.borderColor}` : '';
  const tc = s?.textColor ? ` tc=${s.textColor}` : '';
  const overlay = node.props.overlay ? ` [overlay z=${node.props.zIndex}]` : '';
  console.log(`${indent}${node.type} ${w}x${h}${text}${bg}${r}${bd}${tc}${overlay}`);
  if (depth < maxDepth) {
    for (const c of node.children) dumpTree(c, depth + 1, maxDepth);
  } else if (node.children.length > 0) {
    console.log(`${indent}  ...${node.children.length} children (truncated)`);
  }
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? join(homedir(), 'Desktop', 'UI');
  const maxDepth = parseInt(process.argv[3] ?? '5', 10);
  const files = (await readdir(dir)).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).sort();
  if (files.length === 0) {
    console.error(`no images in ${dir}`);
    process.exit(1);
  }

  for (const f of files) {
    console.log('\n' + '='.repeat(90));
    console.log(`IMG: ${f}`);
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
        console.log('  -- no uiReconstruction --');
        continue;
      }
      console.log(
        `layout=${recon.page.layoutType}  pageType=${recon.semantics?.pageType ?? 'unknown'}(${recon.semantics?.confidence ?? 0})  nodes=${recon.stats.nodeCount}  summary=${recon.semantics?.summary ?? '-'}`,
      );
      if (recon.theme) {
        console.log(
          `theme: primary=${recon.theme.primary} bg=${recon.theme.background} tc=${recon.theme.textColor} dark=${recon.theme.isDarkMode} contrast=${recon.theme.contrastRatio?.toFixed(1)}`,
        );
        console.log(
          `palette: ${recon.theme.palette.slice(0, 6).map((p) => `${p.hex}(${p.role})`).join(' ')}`,
        );
      }
      const regions = layout.structure.regions;
      console.log(`regions(${regions.length}): ${regions.slice(0, 8).map((r) => `${r.type}@${Math.round(r.bbox.w)}x${Math.round(r.bbox.h)}`).join(' ')}${regions.length > 8 ? ' ...' : ''}`);
      if (recon.images.length > 0) {
        console.log(`images(${recon.images.length}): ${recon.images.slice(0, 6).map((i) => `${i.type}@${Math.round(i.bbox.w)}x${Math.round(i.bbox.h)} alt="${i.altText}"`).join('  ')}`);
      }
      if (recon.repeats && recon.repeats.length > 0) {
        console.log(`repeats: ${recon.repeats.map((r) => `${r.templateType}x${r.count}`).join(' ')}`);
      }
      console.log(`tree (depth<=${maxDepth}):`);
      dumpTree(recon.tree, 0, maxDepth);
    } catch (e) {
      console.log(`  ERROR: ${String(e).slice(0, 200)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
