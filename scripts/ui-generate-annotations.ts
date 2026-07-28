/**
 * Generate draft annotation JSON files from the UI analysis pipeline.
 *
 * Usage:
 *   npx tsx scripts/ui-generate-annotations.ts <image-dir> <output-dir>
 *
 * For each image, runs the full pipeline (CV + OCR + orchestrator) and
 * converts the AST to annotation JSON format. Also generates a visual
 * overlay PNG showing detected bounding boxes + types for verification.
 *
 * NOTE: These are pipeline-generated draft annotations, NOT independent
 * human ground truth. They must be reviewed and corrected before use
 * as benchmark ground truth.
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import sharp from 'sharp';
import { extractUiLayoutForAnalysis } from '../src/ui-analysis/adapters/index.js';
import { extractDesignTokens } from '../src/core/extractors/design-extractor.js';
import { extractOcrItems } from '../src/core/key-content-extractor.js';
import { runUiAnalysis } from '../src/ui-analysis/orchestrator.js';
import { PpuPaddleOcrProvider } from '../src/providers/ppu-paddle-ocr/provider.js';
import type { ImageInput } from '../src/types/domain.js';
import type { ASTNode, BBox } from '../src/ui-analysis/ir/types.js';
import type { AnnotationFile, AnnotationElement } from '../src/ui-analysis/benchmark/annotation-loader.js';
import { DRAFT_WARNING } from '../src/ui-analysis/annotation-workbench/store.js';
import { normalizeAnnotationTree } from '../src/ui-analysis/annotation-workbench/tree.js';
import {
  createPipelineBaseline,
  ocrItemsFromInferenceResponse,
  shouldCopySourceImage,
} from '../src/ui-analysis/annotation-workbench/generation.js';

const COLORS: Record<string, string> = {
  page: '#ff0000',
  container: '#888888',
  header: '#ff6600',
  footer: '#ff6600',
  navbar: '#ff6600',
  sidebar: '#ff6600',
  card: '#0066ff',
  section: '#0066ff',
  list: '#0066ff',
  listItem: '#0099ff',
  table: '#0066ff',
  row: '#0099ff',
  column: '#0099ff',
  grid: '#0099ff',
  button: '#ff00ff',
  iconButton: '#ff00ff',
  input: '#00ff00',
  textarea: '#00ff00',
  select: '#00ff00',
  text: '#ffff00',
  title: '#ffaa00',
  subtitle: '#ffaa00',
  icon: '#00ffff',
  image: '#00ffff',
  avatar: '#00ffff',
  divider: '#666666',
  progress: '#666666',
  badge: '#ff00aa',
  tag: '#ff00aa',
  tab: '#ff00ff',
  dialog: '#ff0000',
  drawer: '#ff0000',
  bottomSheet: '#ff0000',
  toolbar: '#ff6600',
  unknown: '#444444',
};

function colorFor(type: string): string {
  return COLORS[type] ?? '#444444';
}

function collectNodes(node: ASTNode, elements: AnnotationElement[], parentId?: string): void {
  const el: AnnotationElement = {
    id: node.id,
    type: node.type,
    bbox: node.bbox,
    render: String((node.props as Record<string, unknown>)?.renderMode ?? 'native'),
  };
  if (node.text !== undefined) el.text = node.text;
  const semanticRole = (node.props as Record<string, unknown>)?.semanticRole;
  if (typeof semanticRole === 'string') el.semanticRole = semanticRole;
  const variant = (node.props as Record<string, unknown>)?.variant;
  if (typeof variant === 'string') el.variant = variant;
  if (node.children.length > 0) el.children = node.children.map((c) => c.id);
  elements.push(el);
  for (const child of node.children) {
    collectNodes(child, elements, node.id);
  }
}

async function generateOverlay(imageBuffer: Buffer, root: ASTNode, outputPath: string): Promise<void> {
  const metadata = await sharp(imageBuffer).metadata();
  const w = metadata.width ?? 1;
  const h = metadata.height ?? 1;

  const svgParts: string[] = [];
  const walk = (node: ASTNode, depth: number): void => {
    const { x, y, w: bw, h: bh } = node.bbox;
    if (bw > 0 && bh > 0) {
      const color = colorFor(node.type);
      const strokeW = node.type === 'page' ? 3 : Math.max(1, 2 - depth * 0.3);
      svgParts.push(
        `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="none" stroke="${color}" stroke-width="${strokeW}" opacity="0.8"/>`
      );
      const label = node.type;
      const fontSize = Math.max(8, Math.min(14, bw / 8));
      svgParts.push(
        `<rect x="${x}" y="${y - fontSize - 2}" width="${label.length * fontSize * 0.6 + 4}" height="${fontSize + 2}" fill="${color}" opacity="0.85"/>`
      );
      svgParts.push(
        `<text x="${x + 2}" y="${y - 3}" font-size="${fontSize}" fill="white" font-family="sans-serif">${label}</text>`
      );
    }
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <image href="data:image/jpeg;base64,${imageBuffer.toString('base64')}" width="${w}" height="${h}"/>
  ${svgParts.join('\n  ')}
</svg>`;

  await sharp(Buffer.from(svg)).png().toFile(outputPath);
}

async function main(): Promise<void> {
  const imageDir = process.argv[2] ?? join(homedir(), 'Desktop', 'UI');
  const outputDir = process.argv[3] ?? 'benchmark/datasets/dev/app';
  const requestedImages = new Set(process.argv.slice(4));
  const overlayDir = join(outputDir, '_overlays');

  await mkdir(outputDir, { recursive: true });
  await mkdir(overlayDir, { recursive: true });

  const files = (await readdir(imageDir))
    .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
    .filter((f) => requestedImages.size === 0 || requestedImages.has(f))
    .sort();

  console.log(`Generating annotations for ${files.length} images...`);

  const ocrProvider = new PpuPaddleOcrProvider();

  for (const file of files) {
    process.stdout.write(`  ${file}...`);
    try {
      const buffer = await readFile(join(imageDir, file));
      const metadata = await sharp(buffer).metadata();
      const image: ImageInput = {
        buffer,
        mimeType: /\.png$/i.test(file) ? 'image/png' : 'image/jpeg',
        source: file,
        size: buffer.length,
      };

      // Run OCR
      let ocrItems;
      try {
        const ocrResult = await ocrProvider.infer({ image, prompt: '', maxTokens: 0, temperature: 0 });
        ocrItems = ocrItemsFromInferenceResponse(ocrResult);
      } catch {
        ocrItems = undefined;
      }

      // Extract layout + design
      const design = await extractDesignTokens(image).catch(() => undefined);
      const layout = await extractUiLayoutForAnalysis(
        image,
        ocrItems,
        design?.palette.map((p) => ({ hex: p.hex, role: p.role })),
      );

      // Run full analysis
      const result = await runUiAnalysis({
        uiLayoutExtraction: layout,
        ...(design ? { designExtraction: design } : {}),
        ...(ocrItems ? { ocrItems } : {}),
        image,
        options: { reconstructionMode: 'balanced' },
      });

      const recon = result.uiReconstruction;
      if (!recon || !recon.tree) {
        console.log(' NO RECONSTRUCTION');
        continue;
      }

      // Convert AST to annotation elements
      const elements: AnnotationElement[] = [];
      collectNodes(recon.tree, elements);

      const baseName = basename(file, extname(file));
      const annotation: AnnotationFile = normalizeAnnotationTree({
        image: file,
        imageSize: {
          width: metadata.width ?? 1,
          height: metadata.height ?? 1,
        },
        platform: 'app',
        theme: design?.isDarkMode ? 'dark' : 'light',
        language: 'zh',
        dpi: 'standard',
        elements,
        relations: [],
        zOrder: [],
        warnings: [DRAFT_WARNING],
      });

      const jsonPath = join(outputDir, `${baseName}.json`);
      const baseline = createPipelineBaseline(annotation);
      await writeFile(jsonPath, JSON.stringify(baseline.draft, null, 2), 'utf-8');
      await writeFile(`${jsonPath}.prediction.json`, JSON.stringify(baseline.prediction, null, 2), 'utf-8');
      await writeFile(`${jsonPath}.review.json`, JSON.stringify(baseline.review, null, 2), 'utf-8');
      const sourceImagePath = join(imageDir, file);
      const destinationImagePath = join(outputDir, file);
      if (shouldCopySourceImage(sourceImagePath, destinationImagePath)) {
        await copyFile(sourceImagePath, destinationImagePath);
      }

      // Generate overlay
      const overlayPath = join(overlayDir, `${baseName}_overlay.png`);
      await generateOverlay(buffer, recon.tree, overlayPath);

      console.log(` ${elements.length} elements, OCR ${ocrItems?.length ?? 0}, baseline sidecars and overlay saved`);
    } catch (e) {
      console.log(` ERROR: ${String(e)}`);
    }
  }

  console.log(`\nDone. Annotations in ${outputDir}, overlays in ${overlayDir}`);
  console.log('Review overlays and correct annotations before benchmark use.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
