/**
 * Build an interactive visual report for real UI screenshots.
 *
 * Usage:
 *   npx tsx scripts/ui-visual-report.ts [image-dir] [output-html] [limit=16]
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import sharp from 'sharp';
import { extractUiLayoutForAnalysis } from '../src/ui-analysis/adapters/index.js';
import { extractDesignTokens } from '../src/core/extractors/design-extractor.js';
import { extractOcrItems, type OcrItem } from '../src/core/key-content-extractor.js';
import { runUiAnalysis } from '../src/ui-analysis/orchestrator.js';
import { PpuPaddleOcrProvider } from '../src/providers/ppu-paddle-ocr/provider.js';
import type { ImageInput } from '../src/types/domain.js';
import type { ASTNode, BBox } from '../src/ui-analysis/ir/types.js';
import type { ImageContentInfo } from '../src/ui-analysis/image-content/image-content-extractor.js';
import type { MediaArea } from '../src/core/extractors/ui-layout-extractor.js';

interface ReportCase {
  filename: string;
  width: number;
  height: number;
  thumbnail: string;
  ocr: OcrItem[];
  candidates: MediaArea[];
  images: ImageContentInfo[];
  tree: ASTNode;
  pageType: string;
  confidence: number;
  layoutType: string;
  summary: string;
  diagnostics: string[];
  componentCounts: Record<string, number>;
  nodeCount: number;
}

function mimeOf(filename: string): string {
  return /\.png$/i.test(filename) ? 'image/png' : 'image/jpeg';
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function compactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function percent(value: number, total: number): number {
  return Math.max(0, Math.min(100, value / Math.max(1, total) * 100));
}

function boxHtml(
  bbox: BBox,
  pageWidth: number,
  pageHeight: number,
  className: string,
  label: string,
): string {
  const left = percent(bbox.x, pageWidth);
  const top = percent(bbox.y, pageHeight);
  const right = percent(bbox.x + bbox.w, pageWidth);
  const bottom = percent(bbox.y + bbox.h, pageHeight);
  const width = Math.max(0.2, right - left);
  const height = Math.max(0.2, bottom - top);
  return `<span class="box ${className}" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%" data-label="${escapeHtml(label)}"></span>`;
}

function ocrBoxes(items: OcrItem[], width: number, height: number): string {
  return items.flatMap((item) => item.box
    ? [boxHtml(
        {
          x: item.box.x1,
          y: item.box.y1,
          w: item.box.x2 - item.box.x1,
          h: item.box.y2 - item.box.y1,
        },
        width,
        height,
        'layer-ocr',
        `OCR · ${item.text}`,
      )]
    : []).join('');
}

function mediaBoxes(
  areas: Array<MediaArea | ImageContentInfo>,
  width: number,
  height: number,
  stage: 'candidate' | 'final',
): string {
  return areas.map((area, index) => boxHtml(
    area.bbox,
    width,
    height,
    stage === 'candidate' ? 'layer-candidate' : `layer-final layer-final-${area.type}`,
    `${stage === 'candidate' ? 'CANDIDATE' : 'FINAL'} ${index + 1} · ${area.type}${'nearbyText' in area && area.nearbyText ? ` · ${area.nearbyText}` : ''}`,
  )).join('');
}

function flattenTree(root: ASTNode): ASTNode[] {
  const nodes: ASTNode[] = [];
  const walk = (node: ASTNode): void => {
    if (node !== root) nodes.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return nodes;
}

function astLayer(node: ASTNode): string {
  if (['icon', 'image', 'avatar'].includes(node.type)) return 'layer-ast-media';
  if (['text', 'title', 'subtitle', 'badge', 'tag'].includes(node.type)) return 'layer-ast-text';
  if (['button', 'iconButton', 'input', 'select', 'checkbox', 'radio', 'switch', 'tab'].includes(node.type)) {
    return 'layer-ast-control';
  }
  return 'layer-ast-structure';
}

function astBoxes(root: ASTNode, width: number, height: number): string {
  return flattenTree(root)
    .filter((node) => node.type !== 'container' || node.children.length > 0)
    .map((node) => boxHtml(
      node.bbox,
      width,
      height,
      astLayer(node),
      `${node.type} · ${node.text ?? node.id}`,
    ))
    .join('');
}

function treeHtml(node: ASTNode, depth = 0): string {
  const text = node.text ? ` “${escapeHtml(node.text.slice(0, 34))}”` : '';
  const line = `<span class="tree-type">${escapeHtml(node.type)}</span><span class="tree-size">${compactNumber(node.bbox.w)}×${compactNumber(node.bbox.h)}</span>${text}`;
  if (node.children.length === 0) return `<li>${line}</li>`;
  return `<li>${line}<ul>${node.children.map((child) => treeHtml(child, depth + 1)).join('')}</ul></li>`;
}

function phonePanel(title: string, subtitle: string, image: string, boxes = ''): string {
  return `<div class="visual-panel">
    <div class="panel-heading"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(subtitle)}</span></div>
    <div class="phone"><img src="${image}" alt="${escapeHtml(title)}">${boxes}</div>
  </div>`;
}

function caseHtml(item: ReportCase): string {
  const key = /_(226|229)_/.test(item.filename);
  const candidateDelta = item.candidates.length - item.images.length;
  const counts = Object.entries(item.componentCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([type, count]) => `<span>${escapeHtml(type)} <b>${count}</b></span>`)
    .join('');
  const candidateOverlay = ocrBoxes(item.ocr, item.width, item.height)
    + mediaBoxes(item.candidates, item.width, item.height, 'candidate');
  const finalOverlay = astBoxes(item.tree, item.width, item.height)
    + mediaBoxes(item.images, item.width, item.height, 'final');
  return `<details class="case${key ? ' key-case' : ''}" data-file="${escapeHtml(item.filename)}"${key ? ' open' : ''}>
    <summary>
      <span class="case-index">${key ? 'KEY' : 'CASE'}</span>
      <span class="case-name">${escapeHtml(item.filename)}</span>
      <span class="case-metric">${escapeHtml(item.pageType)} · ${item.confidence.toFixed(2)}</span>
      <span class="case-metric">candidate ${item.candidates.length} → final ${item.images.length}</span>
      <span class="delta ${candidateDelta > 0 ? 'positive' : candidateDelta < 0 ? 'negative' : ''}">${candidateDelta > 0 ? `−${candidateDelta}` : candidateDelta < 0 ? `+${Math.abs(candidateDelta)}` : 'stable'}</span>
    </summary>
    <div class="case-body">
      <div class="case-meta">
        <div><span class="eyebrow">PAGE MODEL</span><strong>${escapeHtml(item.layoutType)} / ${escapeHtml(item.pageType)}</strong></div>
        <div><span class="eyebrow">FACTS</span><strong>${item.ocr.length} OCR · ${item.nodeCount} AST nodes</strong></div>
        <div><span class="eyebrow">DIAGNOSTICS</span><strong>${escapeHtml(item.diagnostics.join(', ') || 'clean')}</strong></div>
      </div>
      <p class="summary-copy">${escapeHtml(item.summary)}</p>
      <div class="visual-grid">
        ${phonePanel('01 / source', `${item.width} × ${item.height}`, item.thumbnail)}
        ${phonePanel('02 / detector', `${item.ocr.length} OCR + ${item.candidates.length} candidates`, item.thumbnail, candidateOverlay)}
        ${phonePanel('03 / reconstruction', `${item.nodeCount} nodes + ${item.images.length} final media`, item.thumbnail, finalOverlay)}
      </div>
      <div class="component-strip">${counts}</div>
      <details class="tree-panel"><summary>Inspect semantic tree</summary><ul class="tree-root">${treeHtml(item.tree)}</ul></details>
    </div>
  </details>`;
}

function errorCaseHtml(filename: string, error: unknown): string {
  return `<article class="case error-case"><strong>${escapeHtml(filename)}</strong><code>${escapeHtml(String(error))}</code></article>`;
}

function documentHtml(cases: string[], generatedAt: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UI Reconstruction Field Report</title>
<style>
  :root { --ink:#e9ebdf; --muted:#8f968c; --paper:#101411; --panel:#171c18; --line:#313a32; --acid:#d6ff4b; --cyan:#33d6ff; --amber:#ffd166; --pink:#ff5c8a; --green:#7df2ae; --violet:#d9a3ff; }
  * { box-sizing:border-box; }
  body { margin:0; color:var(--ink); background:radial-gradient(circle at 9% -4%,#29442d 0,transparent 27rem),linear-gradient(135deg,#0c100d,#131813 55%,#0c100d); font-family:"Avenir Next","Helvetica Neue",sans-serif; min-height:100vh; }
  body::before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.13; background-image:linear-gradient(rgba(255,255,255,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.08) 1px,transparent 1px); background-size:28px 28px; mask-image:linear-gradient(to bottom,black,transparent 72%); }
  main { width:min(1580px,calc(100% - 40px)); margin:0 auto; padding:64px 0 100px; position:relative; }
  header { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:40px; align-items:end; border-bottom:1px solid var(--line); padding-bottom:28px; margin-bottom:30px; }
  .kicker,.eyebrow,.case-index { font:700 11px/1.2 "SFMono-Regular",Consolas,monospace; letter-spacing:.17em; text-transform:uppercase; color:var(--acid); }
  h1 { margin:10px 0 8px; max-width:900px; font:500 clamp(38px,6vw,82px)/.93 Georgia,serif; letter-spacing:-.055em; }
  header p { color:var(--muted); max-width:760px; margin:16px 0 0; line-height:1.65; }
  .stamp { border:1px solid var(--acid); color:var(--acid); padding:13px 16px; font:700 12px/1.4 "SFMono-Regular",Consolas,monospace; transform:rotate(-2deg); }
  .toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:0 0 22px; position:sticky; top:0; padding:12px 0; z-index:100; backdrop-filter:blur(16px); }
  button { appearance:none; border:1px solid var(--line); background:#171c18dd; color:var(--ink); border-radius:999px; padding:9px 14px; cursor:pointer; font:700 11px/1 "SFMono-Regular",Consolas,monospace; letter-spacing:.08em; text-transform:uppercase; }
  button:hover,button.active { border-color:var(--acid); color:var(--acid); }
  .legend { margin-left:auto; display:flex; flex-wrap:wrap; gap:12px; color:var(--muted); font:11px/1.2 "SFMono-Regular",Consolas,monospace; }
  .legend i { display:inline-block; width:9px; height:9px; margin-right:5px; border:2px solid currentColor; }
  .legend .ocr { color:var(--amber); } .legend .candidate { color:var(--cyan); } .legend .final { color:var(--pink); } .legend .structure { color:var(--violet); }
  .case { display:block; border:1px solid var(--line); background:rgba(23,28,24,.92); margin:0 0 14px; box-shadow:0 20px 65px rgba(0,0,0,.14); }
  .case.key-case { border-color:#677535; box-shadow:inset 4px 0 0 var(--acid),0 20px 70px rgba(0,0,0,.25); }
  .case > summary { list-style:none; display:grid; grid-template-columns:64px minmax(260px,1fr) auto auto 68px; gap:16px; align-items:center; padding:18px 20px; cursor:pointer; }
  .case > summary::-webkit-details-marker { display:none; }
  .case-name { font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .case-metric,.delta { color:var(--muted); font:12px/1.2 "SFMono-Regular",Consolas,monospace; }
  .delta { justify-self:end; color:var(--ink); } .delta.positive { color:var(--green); } .delta.negative { color:var(--pink); }
  .case[open] > summary { border-bottom:1px solid var(--line); background:#1c221d; }
  .case-body { padding:24px; }
  .case-meta { display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--line); border:1px solid var(--line); }
  .case-meta > div { background:#121713; padding:14px 16px; display:flex; gap:12px; align-items:center; justify-content:space-between; }
  .case-meta strong { font:600 12px/1.4 "SFMono-Regular",Consolas,monospace; text-align:right; }
  .summary-copy { color:#b8bdb5; line-height:1.65; margin:18px 0 22px; }
  .visual-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; align-items:start; }
  .visual-panel { min-width:0; }
  .panel-heading { display:flex; justify-content:space-between; gap:10px; color:var(--muted); margin-bottom:8px; font:11px/1.3 "SFMono-Regular",Consolas,monospace; }
  .panel-heading strong { color:var(--ink); text-transform:uppercase; letter-spacing:.1em; }
  .phone { position:relative; width:100%; overflow:hidden; background:#050705; border:1px solid #3a443b; }
  .phone img { display:block; width:100%; height:auto; }
  .box { position:absolute; display:block; border:1.5px solid; box-shadow:inset 0 0 0 1px rgba(0,0,0,.28); min-width:2px; min-height:2px; }
  .box:hover { z-index:30!important; background:rgba(214,255,75,.16); border-color:var(--acid)!important; }
  .box:hover::after { content:attr(data-label); position:absolute; left:0; top:100%; background:#080b09; color:var(--ink); padding:5px 7px; width:max-content; max-width:240px; z-index:50; font:10px/1.35 "SFMono-Regular",Consolas,monospace; white-space:normal; pointer-events:none; }
  .layer-ocr { border-color:var(--amber); z-index:4; }
  .layer-candidate { border:2px solid var(--cyan); background:rgba(51,214,255,.08); z-index:8; }
  .layer-final { border:2.5px solid var(--pink); background:rgba(255,92,138,.12); z-index:12; }
  .layer-final-image { border-color:var(--green); } .layer-final-logo { border-color:var(--violet); }
  .layer-ast-structure { border-color:rgba(217,163,255,.55); z-index:2; }
  .layer-ast-text { border-color:rgba(255,209,102,.6); z-index:4; }
  .layer-ast-control { border-color:rgba(214,255,75,.8); z-index:6; }
  .layer-ast-media { border-color:rgba(51,214,255,.65); z-index:5; }
  body.hide-ocr .layer-ocr,body.hide-ast .layer-ast-structure,body.hide-ast .layer-ast-text,body.hide-ast .layer-ast-control,body.hide-ast .layer-ast-media { display:none; }
  .component-strip { display:flex; gap:7px; flex-wrap:wrap; margin:18px 0; }
  .component-strip span { border:1px solid var(--line); padding:7px 9px; color:var(--muted); font:11px/1 "SFMono-Regular",Consolas,monospace; }
  .component-strip b { color:var(--ink); margin-left:4px; }
  .tree-panel { border-top:1px solid var(--line); padding-top:14px; }
  .tree-panel > summary { color:var(--acid); cursor:pointer; font:700 11px/1.3 "SFMono-Regular",Consolas,monospace; text-transform:uppercase; letter-spacing:.11em; }
  .tree-root,.tree-root ul { list-style:none; margin:10px 0 0; padding-left:18px; border-left:1px solid #303a31; }
  .tree-root { columns:2; column-gap:40px; }
  .tree-root li { break-inside:avoid; margin:5px 0; color:#c3c7c0; font:11px/1.45 "SFMono-Regular",Consolas,monospace; }
  .tree-type { color:var(--cyan); margin-right:9px; } .tree-size { color:var(--muted); margin-right:7px; }
  .error-case { padding:20px; border-color:#7a3041; display:flex; justify-content:space-between; gap:20px; }
  .error-case code { color:var(--pink); }
  footer { color:var(--muted); border-top:1px solid var(--line); padding-top:20px; margin-top:34px; font:11px/1.6 "SFMono-Regular",Consolas,monospace; }
  @media (max-width:900px) { main { width:min(100% - 20px,1580px); padding-top:34px; } header { grid-template-columns:1fr; } .stamp { justify-self:start; } .case > summary { grid-template-columns:50px minmax(0,1fr); } .case-metric,.delta { display:none; } .visual-grid { grid-template-columns:1fr; } .case-meta { grid-template-columns:1fr; } .legend { margin-left:0; width:100%; } .tree-root { columns:1; } }
</style>
</head>
<body>
<main>
  <header><div><span class="kicker">Vision Foundation MCP / field validation</span><h1>Reconstruction<br>evidence board</h1><p>同一截图的原图、OCR + detector 原始候选、最终语义树 + 过滤后媒体并排对照。判定依据是 bbox 是否落在真实对象上，而不是机械追求更少候选。</p></div><div class="stamp">16 REAL SCREENS<br>${escapeHtml(generatedAt)}</div></header>
  <div class="toolbar">
    <button class="active" data-filter="all">all screens</button><button data-filter="key">226 + 229</button><button data-toggle="ocr">toggle OCR</button><button data-toggle="ast">toggle AST</button>
    <div class="legend"><span class="ocr"><i></i>OCR</span><span class="candidate"><i></i>candidate</span><span class="final"><i></i>final media</span><span class="structure"><i></i>AST</span></div>
  </div>
  <section id="cases">${cases.join('')}</section>
  <footer>Pipeline: PaddleOCR → OCR-aware full-grid media detector → solidity filter → conservative media classifier → SemanticAST. Hover any box for its source/type label.</footer>
</main>
<script>
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    const keyOnly = button.dataset.filter === 'key';
    document.querySelectorAll('.case').forEach((item) => { item.hidden = keyOnly && !item.classList.contains('key-case'); });
  }));
  document.querySelector('[data-toggle="ocr"]').addEventListener('click', (event) => {
    document.body.classList.toggle('hide-ocr'); event.currentTarget.classList.toggle('active');
  });
  document.querySelector('[data-toggle="ast"]').addEventListener('click', (event) => {
    document.body.classList.toggle('hide-ast'); event.currentTarget.classList.toggle('active');
  });
</script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const imageDir = resolve(process.argv[2] ?? join(homedir(), 'Desktop', 'UI'));
  const outputPath = resolve(process.argv[3] ?? 'ui-visual-report.html');
  const limit = Number.parseInt(process.argv[4] ?? '16', 10);
  const files = (await readdir(imageDir))
    .filter((filename) => /\.(jpg|jpeg|png)$/i.test(filename))
    .sort()
    .slice(0, limit);
  if (files.length === 0) throw new Error(`No images found in ${imageDir}`);

  const provider = new PpuPaddleOcrProvider();
  const renderedCases: string[] = [];
  await provider.load();
  try {
    for (const filename of files) {
      try {
        const buffer = await readFile(join(imageDir, filename));
        const image: ImageInput = { buffer, mimeType: mimeOf(filename), source: filename, size: buffer.length };
        const metadata = await sharp(buffer).metadata();
        const width = metadata.width ?? 1;
        const height = metadata.height ?? 1;
        const thumbnailBuffer = await sharp(buffer).resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 76 }).toBuffer();
        const thumbnail = `data:image/jpeg;base64,${thumbnailBuffer.toString('base64')}`;
        const design = await extractDesignTokens(image).catch(() => undefined);
        const ocrResult = await provider.infer({ image, prompt: '', maxTokens: 0 });
        const ocr = extractOcrItems(JSON.parse(ocrResult.text), 'full');
        const layout = await extractUiLayoutForAnalysis(
          image,
          ocr,
          design?.palette.map((entry) => ({ hex: entry.hex, role: entry.role })),
        );
        const result = await runUiAnalysis({
          uiLayoutExtraction: layout,
          ...(design ? { designExtraction: design } : {}),
          ocrItems: ocr,
          image,
        });
        const reconstruction = result.uiReconstruction;
        if (!reconstruction) throw new Error('uiReconstruction was not produced');
        renderedCases.push(caseHtml({
          filename,
          width,
          height,
          thumbnail,
          ocr,
          candidates: layout.mediaAreas,
          images: reconstruction.images,
          tree: reconstruction.tree,
          pageType: reconstruction.semantics?.pageType ?? 'unknown',
          confidence: reconstruction.semantics?.confidence ?? 0,
          layoutType: reconstruction.page.layoutType,
          summary: reconstruction.semantics?.summary ?? '-',
          diagnostics: reconstruction.diagnostics?.skipped ?? [],
          componentCounts: reconstruction.stats.componentCounts,
          nodeCount: reconstruction.stats.nodeCount,
        }));
        console.log(`${filename}: OCR=${ocr.length} candidate=${layout.mediaAreas.length} final=${reconstruction.images.length}`);
      } catch (error) {
        renderedCases.push(errorCaseHtml(filename, error));
        console.error(`${filename}: ${String(error)}`);
      }
    }
  } finally {
    await provider.unload();
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, documentHtml(renderedCases, new Date().toISOString()), 'utf8');
  console.log(`Report written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
