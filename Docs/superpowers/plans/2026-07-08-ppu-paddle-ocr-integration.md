# PPU Paddle OCR Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `ppu-paddle-ocr` provider for OCR-only requests while keeping VLM providers responsible for mixed visual understanding flows.

**Architecture:** Introduce a dedicated OCR provider implementing the existing `VisionProvider` interface and supporting only the `ocr` skill. The existing router already prefers exact skill matches for OCR-only requests, so registering the OCR provider is enough to route pure OCR calls to PaddleOCR and keep `classify + ocr + summary` on SmolVLM2/MiniCPM-V. OCR results are normalized into the existing OCR skill schema so `SkillPipeline` and `composeResult` need minimal or no changes.

**Tech Stack:** TypeScript ESM, MCP SDK, Vitest, `ppu-paddle-ocr`, existing `VisionProvider`/`SkillPipeline` architecture, optional dynamic imports for OCR dependency isolation.

---

## File Structure

- Modify `package.json`: add `ppu-paddle-ocr` as an optional runtime dependency candidate and add OCR provider tests to `test:unit`.
- Modify `src/index.ts`: register `PpuPaddleOcrProvider` when enabled and dependency is available.
- Create `src/providers/ppu-paddle-ocr/provider.ts`: dedicated OCR provider with lifecycle, lazy initialization, image temp-file handling if needed, result normalization, and JSON output.
- Create `src/providers/ppu-paddle-ocr/types.ts`: small local interfaces for OCR result normalization so tests do not depend on exact third-party types.
- Modify `src/tools/vision-analyze.ts`: ensure provider routing uses planned skills, not raw requested skills only, so intent-derived OCR-only requests can route to the OCR provider.
- Modify `src/core/execution-planner.ts`: export a small `resolveSkillNames()` helper or equivalent so `vision-analyze` and planner use the same intent mapping without duplicating logic.
- Create `tests/ppu-paddle-ocr-provider.test.ts`: unit tests for provider identity, lifecycle, normalization, and inference output schema using dependency injection/mocks.
- Modify `tests/vision-analyze-routing.test.ts`: add coverage that intent-derived OCR requests can select the OCR provider once planned skills are known.
- Optional modify `README.md` and `README.zh-CN.md`: document enabling OCR provider, model cache, limitations, and fallback behavior.

---

## Task 1: Resolve Planned Skills Before Provider Selection

**Files:**
- Modify: `src/core/execution-planner.ts`
- Modify: `src/tools/vision-analyze.ts`
- Test: `tests/vision-analyze-routing.test.ts`

- [ ] **Step 1: Write the failing test**

Append this test to `tests/vision-analyze-routing.test.ts` inside the existing `describe('selectProvider...')` block:

```ts
  it('routes intent-derived OCR-only skills to a dedicated OCR provider', () => {
    const p = selectProvider([gguf, ocr], {
      options: {},
      resources: goodResources,
      requestedSkills: ['ocr'],
    });
    expect(p.name).toBe('ppu-paddle-ocr');
  });
```

This test already resembles existing explicit-skill coverage. The implementation task must also ensure the actual tool path passes planned skills to `selectProvider`, not only raw user `skills`.

- [ ] **Step 2: Run test to verify current behavior**

Run:

```bash
npx vitest run --fileParallelism=false tests/vision-analyze-routing.test.ts
```

Expected: this specific test may already pass because prior routing prep supports explicit `['ocr']`. If it passes, continue by adding the production refactor in Step 3 and rely on full unit tests to guard no behavior change.

- [ ] **Step 3: Export a shared skill resolver**

In `src/core/execution-planner.ts`, add this function after `mapIntentToSkills()`:

```ts
export function resolveSkillNames(requestedSkills: string[] | undefined, intent: string): string[] {
  if (requestedSkills && requestedSkills.length > 0) {
    const validSkills = requestedSkills.filter((s) => getSkill(s) !== undefined);
    if (validSkills.length > 0) return validSkills;
    logger.warn('No valid skills found in requestedSkills', { requestedSkills });
    return ['classify', 'summary'];
  }

  return mapIntentToSkills(intent);
}
```

Then replace the skill-selection block in `planExecution()` with:

```ts
  const skillNames = resolveSkillNames(requestedSkills, intent);
```

- [ ] **Step 4: Use resolved skills during provider selection**

In `src/tools/vision-analyze.ts`, import `resolveSkillNames`:

```ts
import { planExecution, resolveSkillNames } from '../core/execution-planner.js';
```

Replace the current `skillNames` block before `selectProvider()` with:

```ts
            const skillNames = resolveSkillNames(requestedSkills, intent);
```

Keep the planner call unchanged; it will resolve the same skills internally.

- [ ] **Step 5: Run focused routing tests**

Run:

```bash
npx vitest run --fileParallelism=false tests/planner-active-provider.test.ts tests/vision-analyze-routing.test.ts tests/provider-router.test.ts
```

Expected: all tests pass.

---

## Task 2: Add OCR Provider Skeleton and Normalizer

**Files:**
- Create: `src/providers/ppu-paddle-ocr/types.ts`
- Create: `src/providers/ppu-paddle-ocr/provider.ts`
- Test: `tests/ppu-paddle-ocr-provider.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/ppu-paddle-ocr-provider.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { PpuPaddleOcrProvider, normalizePaddleOcrResult } from '../src/providers/ppu-paddle-ocr/provider.js';

const sampleOcrResult = {
  text: '菜单中心\n比萨配料管理\n保存',
  boxes: [
    { text: '菜单中心', score: 0.98, box: [[10, 10], [100, 10], [100, 30], [10, 30]] },
    { text: '比萨配料管理', score: 0.96, box: [[120, 10], [260, 10], [260, 30], [120, 30]] },
    { text: '保存', score: 0.95, box: [[900, 700], [950, 700], [950, 740], [900, 740]] },
  ],
};

describe('PpuPaddleOcrProvider', () => {
  it('declares OCR-only provider capabilities', () => {
    const provider = new PpuPaddleOcrProvider();
    expect(provider.name).toBe('ppu-paddle-ocr');
    expect(provider.runtime).toBe('native-ocr');
    expect(provider.supportedSkills).toEqual(['ocr']);
    expect(provider.requirements.gpuRequired).toBe(false);
  });

  it('normalizes PaddleOCR text boxes into the existing OCR schema', () => {
    const normalized = normalizePaddleOcrResult(sampleOcrResult);
    expect(normalized.language).toBe('zh');
    expect(normalized.texts).toEqual([
      { text: '菜单中心', position: '10,10,100,30', confidence: 0.98 },
      { text: '比萨配料管理', position: '120,10,260,30', confidence: 0.96 },
      { text: '保存', position: '900,700,950,740', confidence: 0.95 },
    ]);
  });

  it('falls back to line text when detailed boxes are not present', () => {
    const normalized = normalizePaddleOcrResult({ text: '取消\n保存' });
    expect(normalized.language).toBe('zh');
    expect(normalized.texts.map((item) => item.text)).toEqual(['取消', '保存']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run --fileParallelism=false tests/ppu-paddle-ocr-provider.test.ts
```

Expected: FAIL because `src/providers/ppu-paddle-ocr/provider.ts` does not exist.

- [ ] **Step 3: Create local OCR types**

Create `src/providers/ppu-paddle-ocr/types.ts`:

```ts
export interface PaddleOcrTextBox {
  text?: string;
  score?: number;
  confidence?: number;
  box?: number[][];
  bbox?: number[][];
}

export interface PaddleOcrRawResult {
  text?: string;
  boxes?: PaddleOcrTextBox[];
  result?: PaddleOcrTextBox[];
  lines?: PaddleOcrTextBox[];
}

export interface NormalizedOcrText {
  text: string;
  position?: string;
  confidence?: number;
}

export interface NormalizedOcrResult {
  texts: NormalizedOcrText[];
  language: string;
}
```

- [ ] **Step 4: Create provider skeleton and normalizer**

Create `src/providers/ppu-paddle-ocr/provider.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageInput, InferenceRequest, InferenceResponse } from '../../types/domain.js';
import type { VisionProvider } from '../types.js';
import type { NormalizedOcrResult, PaddleOcrRawResult, PaddleOcrTextBox } from './types.js';

interface PaddleOcrServiceLike {
  initialize(): Promise<void>;
  recognize(input: string | Buffer | ArrayBuffer, options?: Record<string, unknown>): Promise<PaddleOcrRawResult>;
  destroy(): Promise<void>;
}

type PaddleOcrServiceCtor = new (options?: Record<string, unknown>) => PaddleOcrServiceLike;

export class PpuPaddleOcrProvider implements VisionProvider {
  readonly name = 'ppu-paddle-ocr';
  readonly runtime = 'native-ocr';
  readonly supportedRuntimes = ['native-ocr'];
  readonly supportedSkills = ['ocr'];
  readonly requirements = {
    minMemoryMB: 256,
    gpuRequired: false,
    modelSizeMB: 80,
  };

  private loaded = false;
  private service: PaddleOcrServiceLike | null = null;

  constructor(private ServiceCtor?: PaddleOcrServiceCtor) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const ServiceCtor = this.ServiceCtor ?? await loadPaddleOcrServiceCtor();
    this.service = new ServiceCtor({
      debugging: { debug: false, verbose: false },
      recognition: { strategy: 'per-box' },
    });
    await this.service.initialize();
    this.loaded = true;
  }

  async infer(req: InferenceRequest): Promise<InferenceResponse> {
    if (!this.loaded || !this.service) {
      await this.load();
    }

    const start = Date.now();
    const raw = await recognizeImage(this.service!, req.image);
    const normalized = normalizePaddleOcrResult(raw);
    return {
      text: JSON.stringify(normalized),
      duration: Date.now() - start,
    };
  }

  async unload(): Promise<void> {
    if (this.service) {
      await this.service.destroy();
      this.service = null;
    }
    this.loaded = false;
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}

export function normalizePaddleOcrResult(raw: PaddleOcrRawResult): NormalizedOcrResult {
  const boxes = raw.boxes ?? raw.result ?? raw.lines ?? [];
  const texts = boxes
    .map((box) => normalizeTextBox(box))
    .filter((item): item is NonNullable<ReturnType<typeof normalizeTextBox>> => item !== null);

  if (texts.length === 0 && raw.text) {
    for (const line of raw.text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      texts.push({ text: line });
    }
  }

  return {
    texts,
    language: detectLanguage(texts.map((item) => item.text).join('\n')),
  };
}

function normalizeTextBox(box: PaddleOcrTextBox): { text: string; position?: string; confidence?: number } | null {
  const text = box.text?.trim();
  if (!text) return null;

  const points = box.box ?? box.bbox;
  const normalized = {
    text,
    position: points ? boxToPosition(points) : undefined,
    confidence: box.score ?? box.confidence,
  };

  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== undefined),
  ) as { text: string; position?: string; confidence?: number };
}

function boxToPosition(points: number[][]): string | undefined {
  const xs = points.map((p) => p[0]).filter((n): n is number => typeof n === 'number');
  const ys = points.map((p) => p[1]).filter((n): n is number => typeof n === 'number');
  if (xs.length === 0 || ys.length === 0) return undefined;
  return `${Math.round(Math.min(...xs))},${Math.round(Math.min(...ys))},${Math.round(Math.max(...xs))},${Math.round(Math.max(...ys))}`;
}

function detectLanguage(text: string): string {
  if (/[/u4e00-/u9fff]/u.test(text)) return 'zh';
  if (/[A-Za-z]/.test(text)) return 'en';
  return 'unknown';
}

async function loadPaddleOcrServiceCtor(): Promise<PaddleOcrServiceCtor> {
  const mod = await import('ppu-paddle-ocr');
  return mod.PaddleOcrService as PaddleOcrServiceCtor;
}

async function recognizeImage(service: PaddleOcrServiceLike, image: ImageInput): Promise<PaddleOcrRawResult> {
  const ext = image.mimeType.includes('jpeg') || image.mimeType.includes('jpg') ? 'jpg' : 'png';
  const dir = await mkdtemp(join(tmpdir(), 'vision-ocr-'));
  const file = join(dir, `input.${ext}`);
  try {
    await writeFile(file, image.buffer);
    return await service.recognize(file, { noCache: true, strategy: 'per-box' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

Important correction before implementation: the Unicode regex in `detectLanguage` must use escaped codepoint ranges exactly as `/[\u4e00-\u9fff]/u.test(text)`, not the literal text shown by Markdown escaping if copied incorrectly.

- [ ] **Step 5: Run provider tests**

Run:

```bash
npx vitest run --fileParallelism=false tests/ppu-paddle-ocr-provider.test.ts
```

Expected: PASS.

---

## Task 3: Test Inference With Mocked Service

**Files:**
- Modify: `tests/ppu-paddle-ocr-provider.test.ts`
- Modify: `src/providers/ppu-paddle-ocr/provider.ts`

- [ ] **Step 1: Add failing inference test**

Append this test to `tests/ppu-paddle-ocr-provider.test.ts`:

```ts
  it('returns JSON that matches the OCR skill schema from mocked inference', async () => {
    class MockService {
      initialized = false;
      destroyed = false;

      async initialize() {
        this.initialized = true;
      }

      async recognize() {
        return sampleOcrResult;
      }

      async destroy() {
        this.destroyed = true;
      }
    }

    const provider = new PpuPaddleOcrProvider(MockService);
    const response = await provider.infer({
      image: { buffer: Buffer.from('image'), mimeType: 'image/png', source: 'test', size: 5 },
      prompt: 'Extract text',
      maxTokens: 256,
      temperature: 0,
      cache: false,
    });

    expect(JSON.parse(response.text)).toEqual({
      texts: [
        { text: '菜单中心', position: '10,10,100,30', confidence: 0.98 },
        { text: '比萨配料管理', position: '120,10,260,30', confidence: 0.96 },
        { text: '保存', position: '900,700,950,740', confidence: 0.95 },
      ],
      language: 'zh',
    });
    expect(response.duration).toBeGreaterThanOrEqual(0);

    await provider.unload();
    expect(provider.isLoaded()).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify behavior**

Run:

```bash
npx vitest run --fileParallelism=false tests/ppu-paddle-ocr-provider.test.ts
```

Expected: PASS if Task 2 implementation already supports dependency injection. If it fails due to constructor typing, update `PpuPaddleOcrProvider` constructor to accept `PaddleOcrServiceCtor` as shown in Task 2.

---

## Task 4: Register OCR Provider Conditionally

**Files:**
- Modify: `src/index.ts`
- Test: `tests/provider-capabilities.test.ts`

- [ ] **Step 1: Inspect current provider registration**

Read `src/index.ts`. Locate the provider array where SmolVLM2, GGUF, ONNX, and MiniCPM-V are registered.

- [ ] **Step 2: Write failing registration test**

If `tests/provider-capabilities.test.ts` currently asserts registered providers indirectly, add a focused exported helper first. Prefer creating a small helper in `src/index.ts`:

```ts
export async function buildProvidersForRuntime(env: NodeJS.ProcessEnv = process.env): Promise<VisionProvider[]> {
  // implementation in Step 4
}
```

Then add this test to `tests/provider-capabilities.test.ts`:

```ts
  it('registers the OCR provider when explicitly enabled', async () => {
    const { buildProvidersForRuntime } = await import('../src/index.js');
    const providers = await buildProvidersForRuntime({
      VISION_PROVIDER: 'smolvlm2',
      VISION_OCR_PROVIDER: 'ppu-paddle-ocr',
    } as NodeJS.ProcessEnv);

    expect(providers.map((p) => p.name)).toContain('ppu-paddle-ocr');
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
npx vitest run --fileParallelism=false tests/provider-capabilities.test.ts
```

Expected: FAIL because `buildProvidersForRuntime` or OCR registration does not exist.

- [ ] **Step 4: Implement provider registration**

In `src/index.ts`, extract provider construction into `buildProvidersForRuntime()`.

Use this behavior:

```ts
const ocrProvider = env.VISION_OCR_PROVIDER;
if (ocrProvider === 'ppu-paddle-ocr') {
  const { PpuPaddleOcrProvider } = await import('./providers/ppu-paddle-ocr/provider.js');
  providers.push(new PpuPaddleOcrProvider());
}
```

Keep OCR opt-in only for the first integration. Do not auto-register until real image validation is done because the dependency downloads/caches models on first use.

- [ ] **Step 5: Run registration test**

Run:

```bash
npx vitest run --fileParallelism=false tests/provider-capabilities.test.ts
```

Expected: PASS.

---

## Task 5: Add Dependency and Unit Script Coverage

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add dependency**

Run:

```bash
pnpm add ppu-paddle-ocr@^6.0.0
```

Expected: `package.json` and `pnpm-lock.yaml` update. `onnxruntime-node` already exists in this project, so do not add it again unless pnpm requires peer resolution.

- [ ] **Step 2: Add provider test to unit suite**

Modify `package.json` `scripts.test:unit` to include:

```text
tests/ppu-paddle-ocr-provider.test.ts
```

Keep the existing `--fileParallelism=false` flag.

- [ ] **Step 3: Verify install and typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

---

## Task 6: Real OCR Smoke Test Script

**Files:**
- Create: `examples/ocr-provider.mjs`
- Optional Test: manual only, not part of unit suite

- [ ] **Step 1: Create example script**

Create `examples/ocr-provider.mjs`:

```js
#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { PpuPaddleOcrProvider } from '../dist/providers/ppu-paddle-ocr/provider.js';

const imagePath = process.argv[2];
if (!imagePath) {
  console.error('Usage: node examples/ocr-provider.mjs <image-path>');
  process.exit(2);
}

const buffer = await readFile(imagePath);
const provider = new PpuPaddleOcrProvider();
try {
  await provider.load();
  const result = await provider.infer({
    image: { buffer, mimeType: imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png', source: imagePath, size: buffer.length },
    prompt: 'Extract all visible text',
    maxTokens: 256,
    temperature: 0,
    cache: false,
  });
  console.log(result.text);
} finally {
  await provider.unload();
}
```

- [ ] **Step 2: Build before running example**

Run:

```bash
pnpm build
```

Expected: PASS and `dist/providers/ppu-paddle-ocr/provider.js` exists.

- [ ] **Step 3: Run on TAPD screenshot**

Run:

```bash
node examples/ocr-provider.mjs /Users/jary/Desktop/tapd_48801209_base64_1782368868_337.png
```

Expected: JSON output with `texts` containing at least several of these strings: `菜单中心`, `比萨配料管理`, `基础配料`, `附加配料`, `配料名称`, `POS CODE`, `取消`, `保存`.

If first run downloads models, allow extra time. If it fails due to network/model cache, document the exact error and do not hide it behind VLM fallback.

---

## Task 7: End-to-End MCP Routing Smoke Test

**Files:**
- No code changes unless this smoke test reveals a bug

- [ ] **Step 1: Build project**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 2: Run OCR-only MCP request with OCR provider enabled**

Use the existing MCP integration style or a small one-off JSON-RPC stdio script. Environment:

```bash
VISION_OCR_PROVIDER=ppu-paddle-ocr node dist/index.js
```

Call `vision.analyze` with:

```json
{
  "image": "/Users/jary/Desktop/tapd_48801209_base64_1782368868_337.png",
  "skills": ["ocr"],
  "options": { "cache": false }
}
```

Expected structured result metadata:

```json
{
  "metadata": {
    "provider": "ppu-paddle-ocr",
    "runtime": "native-ocr"
  },
  "skills": ["ocr"]
}
```

- [ ] **Step 3: Run mixed screenshot analysis request**

Call `vision.analyze` with:

```json
{
  "image": "/Users/jary/Desktop/tapd_48801209_base64_1782368868_337.png",
  "intent": "分析这个需求截图内容，提取页面字段、按钮、红框标注和图片内容",
  "options": { "cache": false }
}
```

Expected structured result metadata provider remains a VLM provider, usually:

```json
{
  "metadata": {
    "provider": "gguf-smolvlm2"
  },
  "skills": ["classify", "ocr", "summary"]
}
```

This confirms OCR-only routing does not break screenshot understanding flows.

---

## Task 8: Documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Optional Modify: `AGENTS.md`

- [ ] **Step 1: Document English OCR provider usage**

Add a section to `README.md` under provider/runtime configuration:

```md
### Optional Dedicated OCR Provider

Set `VISION_OCR_PROVIDER=ppu-paddle-ocr` to register a dedicated PaddleOCR-backed provider for OCR-only requests:

```bash
VISION_OCR_PROVIDER=ppu-paddle-ocr vision-foundation-mcp
```

Behavior:

- `skills: ["ocr"]` routes to `ppu-paddle-ocr` when available.
- Mixed visual understanding requests such as `classify + ocr + summary` stay on the active VLM provider.
- Models are cached by `ppu-paddle-ocr` under `~/.cache/ppu-paddle-ocr`.
- Table structure is not reconstructed; text boxes and lines are returned in reading/layout order when available.
```

- [ ] **Step 2: Document Chinese OCR provider usage**

Add equivalent Chinese documentation to `README.zh-CN.md`:

```md
### 可选专用 OCR Provider

设置 `VISION_OCR_PROVIDER=ppu-paddle-ocr` 后，服务会注册一个基于 PaddleOCR 的专用 OCR Provider：

```bash
VISION_OCR_PROVIDER=ppu-paddle-ocr vision-foundation-mcp
```

行为：

- `skills: ["ocr"]` 会优先路由到 `ppu-paddle-ocr`。
- `classify + ocr + summary` 这类截图理解请求仍然由 VLM Provider 处理。
- 模型默认缓存到 `~/.cache/ppu-paddle-ocr`。
- 表格结构不会自动还原；会尽量返回文本框、行文本和位置信息。
```

- [ ] **Step 3: Run doc-sensitive package check**

Run:

```bash
npm pack --dry-run
```

Expected: package includes `README.md`, `README.zh-CN.md`, `dist/`, and no local cache/model files.

---

## Final Verification

- [ ] Run focused OCR/provider/routing tests:

```bash
npx vitest run --fileParallelism=false tests/ppu-paddle-ocr-provider.test.ts tests/provider-router.test.ts tests/vision-analyze-routing.test.ts tests/provider-capabilities.test.ts
```

Expected: PASS.

- [ ] Run typecheck:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] Run full unit suite:

```bash
pnpm test:unit
```

Expected: PASS.

- [ ] Run build:

```bash
pnpm build
```

Expected: PASS and `dist/skills` copied.

- [ ] Run real OCR smoke test on TAPD screenshot:

```bash
node examples/ocr-provider.mjs /Users/jary/Desktop/tapd_48801209_base64_1782368868_337.png
```

Expected: output includes recognizable Chinese UI text from the screenshot.

---

## Execution Status

- Implemented `PpuPaddleOcrProvider` behind `VISION_OCR_PROVIDER=ppu-paddle-ocr`.
- Added OCR-only provider registration and route selection.
- Added normalization for array-point boxes and flattened `ppu-paddle-ocr` rectangle boxes.
- Added unit coverage for provider capabilities, normalization, mocked inference, registration, and routing.
- Added `examples/ocr-provider.mjs` for direct provider smoke testing.
- Updated English and Chinese README docs.
- Verified focused tests, typecheck, unit suite, build, and `npm pack --dry-run`.
- MCP OCR-only smoke test with `/Users/jary/Pictures/vision-output/123.png` routed to `ppu-paddle-ocr` with runtime `native-ocr`.
- The original TAPD Chinese UI screenshot `/Users/jary/Desktop/tapd_48801209_base64_1782368868_337.png` was not present on disk, so the intended dense Chinese UI OCR acceptance check remains blocked until that image or an equivalent screenshot is available.

---

## Risks and Decisions

- Keep `ppu-paddle-ocr` opt-in behind `VISION_OCR_PROVIDER=ppu-paddle-ocr` for first integration to avoid surprising first-run model downloads.
- Keep OCR provider `supportedSkills = ['ocr']` only. Do not make it support `summary`, `document`, or `table` until there is a separate layout/table reconstruction layer.
- Do not implement per-skill multi-provider execution in this pass. The current request-level provider routing is enough for OCR-only requests and safer for mixed VLM flows.
- If `ppu-paddle-ocr` result object shape differs from the assumed `boxes/result/lines` forms, update `normalizePaddleOcrResult()` with an additional branch and add a fixture-based unit test before changing code.
- If the package logs to stdout during MCP operation, suppress or redirect library logs. MCP stdout must stay JSON-RPC only.
