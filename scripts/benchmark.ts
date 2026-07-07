/**
 * Cross-provider benchmark — compare SmolVLM / SmolVLM2 / MiniCPM-V on
 * accuracy, latency, and memory across a fixed image set.
 *
 * Usage:
 *   pnpm tsx scripts/benchmark.ts [image...]
 *   VISION_HIGH_QUALITY=1 pnpm tsx scripts/benchmark.ts tests/fixtures/*.png
 *
 * Output:
 *   - Per-provider, per-skill latency + raw text
 *   - Markdown summary table printed to stdout
 *   - JSON detail written to benchmark-results.json
 *
 * Env:
 *   BENCH_PROVIDERS  comma-separated subset, e.g. "gguf,smolvlm2" (default: all available)
 *   BENCH_RUNS      number of runs per image/skill (default 1; first run includes load cost)
 */
import { GGUFProvider } from '../src/providers/gguf/provider.js';
import { SmolVLM2Provider } from '../src/providers/smolvlm2/provider.js';
import sharp from 'sharp';
import { writeFileSync, readFileSync, statSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';

interface BenchProvider {
  name: string;
  instance: { load(): Promise<void>; infer(req: { image: { buffer: Buffer; mimeType: string; source: string; size: number }; prompt: string; maxTokens: number; temperature: number; }): Promise<{ text: string; duration: number; }>; unload(): Promise<void>; isLoaded(): boolean; };
  available: boolean;
  loadError?: string;
}

interface RunResult {
  provider: string;
  image: string;
  skill: string;
  run: number;
  text: string;
  durationMs: number;
  loadedMs: number;
}

const SKILLS: Array<{ name: string; prompt: string; maxTokens: number; }> = [
  {
    name: 'classify',
    prompt: 'What is the main category of this image? Reply with one word: dashboard, chart, diagram, document, poster, ui, photo, illustration, logo, icon, screenshot, other',
    maxTokens: 16,
  },
  {
    name: 'describe',
    prompt: 'Describe this image in one or two sentences.',
    maxTokens: 64,
  },
  {
    name: 'ocr',
    prompt: 'What text do you see in this image? List each text item.',
    maxTokens: 64,
  },
];

async function buildProviders(): Promise<BenchProvider[]> {
  const want = (process.env.BENCH_PROVIDERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const candidates: BenchProvider[] = [];

  if (!want.length || want.includes('gguf')) {
    candidates.push({ name: 'gguf', instance: new GGUFProvider() as unknown as BenchProvider['instance'], available: false });
  }
  if (!want.length || want.includes('smolvlm2')) {
    candidates.push({ name: 'smolvlm2', instance: new SmolVLM2Provider() as unknown as BenchProvider['instance'], available: false });
  }
  if (!want.length || want.includes('minicpm')) {
    try {
      const mod = await import('../src/providers/minicpm/provider.js');
      candidates.push({ name: 'minicpm', instance: new mod.MiniCPMProvider() as unknown as BenchProvider['instance'], available: false });
    } catch (e) {
      candidates.push({ name: 'minicpm', instance: null as unknown as BenchProvider['instance'], available: false, loadError: (e as Error).message });
    }
  }
  return candidates;
}

async function loadImage(path: string): Promise<{ buffer: Buffer; mimeType: string; size: number; } | null> {
  try {
    statSync(path);
  } catch {
    console.error(`!! image not found: ${path}`);
    return null;
  }
  const buf = readFileSync(path);
  const mimeType = path.toLowerCase().endsWith('.png') ? 'image/png'
    : path.toLowerCase().endsWith('.webp') ? 'image/webp'
    : 'image/jpeg';
  return { buffer: buf, mimeType, size: buf.length };
}

async function runProvider(
  provider: BenchProvider,
  images: Array<{ path: string; img: { buffer: Buffer; mimeType: string; size: number; } }>,
  runs: number,
): Promise<RunResult[]> {
  const out: RunResult[] = [];

  if (provider.loadError) {
    console.log(`[${provider.name}] SKIP — import failed: ${provider.loadError}`);
    return out;
  }

  console.log(`\n=== ${provider.name} ===`);
  const tLoad = Date.now();
  try {
    await provider.instance.load();
    provider.available = true;
  } catch (e) {
    provider.loadError = (e as Error).message;
    console.log(`  LOAD FAILED: ${provider.loadError}`);
    return out;
  }
  const loadedMs = Date.now() - tLoad;
  console.log(`  loaded in ${loadedMs}ms (free RAM: ${Math.round(freemem() / 1024 / 1024)}MB / ${Math.round(totalmem() / 1024 / 1024)}MB)`);

  for (const { path, img } of images) {
    for (const skill of SKILLS) {
      for (let r = 0; r < runs; r++) {
        const t = Date.now();
        try {
          const res = await provider.instance.infer({
            image: { ...img, source: 'bench' },
            prompt: skill.prompt,
            maxTokens: skill.maxTokens,
            temperature: 0,
          });
          const dur = Date.now() - t;
          out.push({ provider: provider.name, image: path, skill: skill.name, run: r, text: res.text.trim(), durationMs: dur, loadedMs });
          console.log(`  ${skill.name.padEnd(10)} ${path.split('/').pop()?.padEnd(20)} run${r}: ${dur}ms → "${res.text.trim().slice(0, 80)}"`);
        } catch (e) {
          out.push({ provider: provider.name, image: path, skill: skill.name, run: r, text: `ERROR: ${(e as Error).message}`, durationMs: Date.now() - t, loadedMs });
          console.log(`  ${skill.name.padEnd(10)} ${path.split('/').pop()?.padEnd(20)} run${r}: ERROR ${(e as Error).message}`);
        }
      }
    }
  }

  try {
    await provider.instance.unload();
  } catch { /* ignore */ }
  return out;
}

function printMarkdownSummary(results: RunResult[]): void {
  console.log('\n\n=== Markdown Summary ===\n');
  const byProvider = new Map<string, RunResult[]>();
  for (const r of results) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, []);
    byProvider.get(r.provider)!.push(r);
  }

  console.log('| Provider | Load (ms) | Classify (avg ms) | Describe (avg ms) | OCR (avg ms) | Sample Output |');
  console.log('|----------|-----------|-------------------|-------------------|--------------|----------------|');
  for (const [name, rs] of byProvider) {
    const load = rs[0]?.loadedMs ?? 0;
    const avg = (skill: string) => {
      const xs = rs.filter(r => r.skill === skill && !r.text.startsWith('ERROR'));
      if (!xs.length) return 'n/a';
      return String(Math.round(xs.reduce((s, r) => s + r.durationMs, 0) / xs.length));
    };
    const sample = rs.find(r => r.skill === 'describe' && !r.text.startsWith('ERROR'))?.text.slice(0, 60) ?? 'n/a';
    console.log(`| ${name} | ${load} | ${avg('classify')} | ${avg('describe')} | ${avg('ocr')} | ${sample.replace(/\|/g, '\\|')} |`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let imagePaths = argv.filter(a => !a.startsWith('-'));
  if (!imagePaths.length) {
    imagePaths = ['tests/fixtures/gguf-test.png'];
    console.log(`No images provided; using default: ${imagePaths[0]}`);
    try {
      statSync(imagePaths[0]);
    } catch {
      console.log('Default fixture missing; generating it...');
      const img = await sharp({
        create: { width: 256, height: 256, channels: 3, background: { r: 100, g: 150, b: 200 } },
      })
        .composite([{
          input: Buffer.from(
            '<svg width="256" height="256">' +
            '<rect x="50" y="50" width="100" height="100" fill="red"/>' +
            '<circle cx="180" cy="180" r="30" fill="blue"/>' +
            '<text x="80" y="220" font-size="20" fill="black">TEST</text>' +
            '</svg>',
          ),
          top: 0, left: 0,
        }])
        .png()
        .toBuffer();
      writeFileSync(imagePaths[0], img);
    }
  }

  const runs = parseInt(process.env.BENCH_RUNS ?? '1', 10);

  const images: Array<{ path: string; img: { buffer: Buffer; mimeType: string; size: number; } }> = [];
  for (const p of imagePaths) {
    const img = await loadImage(p);
    if (img) images.push({ path: p, img });
  }
  if (!images.length) {
    console.error('No valid images to benchmark.');
    process.exit(2);
  }

  const providers = await buildProviders();
  const all: RunResult[] = [];
  for (const p of providers) {
    const rs = await runProvider(p, images, runs);
    all.push(...rs);
  }

  printMarkdownSummary(all);
  writeFileSync('benchmark-results.json', JSON.stringify(all, null, 2));
  console.log('\nDetail written to benchmark-results.json');
}

main().catch(e => {
  console.error('BENCHMARK FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
