# UI Annotation Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local browser workbench that lets a reviewer correct draft UI benchmark annotations without editing JSON by hand.

**Architecture:** A dependency-free Node HTTP server serves a static single-page workbench and a narrow JSON API rooted at one dataset directory. The browser loads paired screenshot/annotation records, converts pointer positions between display and original pixels, and submits complete annotation documents. Server-side validation, path confinement, backup creation, and atomic replacement keep benchmark data safe.

**Tech Stack:** Node.js built-ins (`node:http`, `node:fs/promises`, `node:path`), TypeScript/tsx, browser DOM/SVG/CSS, Vitest.

---

## File Structure

- Create: `src/ui-analysis/annotation-workbench/store.ts` - dataset scanning, path confinement, validation, atomic writes, and review-state updates.
- Create: `src/ui-analysis/annotation-workbench/server.ts` - local HTTP API and static-file server.
- Create: `src/ui-analysis/annotation-workbench/static/index.html` - workbench page shell.
- Create: `src/ui-analysis/annotation-workbench/static/app.js` - image canvas, element selection/editing, box creation, navigation, and save handling.
- Create: `src/ui-analysis/annotation-workbench/static/styles.css` - responsive local workbench layout.
- Create: `scripts/ui-annotation-workbench.ts` - CLI entry point for the local server.
- Create: `tests/ui-analysis/annotation-workbench-store.test.ts` - store validation, traversal, backup, and save tests.
- Create: `tests/ui-analysis/annotation-workbench-server.test.ts` - HTTP route/API tests.
- Modify: `scripts/ui-generate-annotations.ts` - emit a stable review warning recognized by the workbench; do not change generated element geometry.
- Modify: `package.json` - add `ui:annotate` script.

### Task 1: Dataset Store and Annotation Safety

**Files:**
- Create: `src/ui-analysis/annotation-workbench/store.ts`
- Test: `tests/ui-analysis/annotation-workbench-store.test.ts`

- [ ] **Step 1: Write failing store tests**

```ts
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AnnotationWorkbenchStore,
  DRAFT_WARNING,
} from '../../src/ui-analysis/annotation-workbench/store.js';

async function makeDataset(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'annotation-workbench-'));
  const app = join(root, 'app');
  await mkdir(app);
  await writeFile(join(app, 'screen.png'), Buffer.from('png'));
  await writeFile(join(app, 'screen.json'), JSON.stringify({
    image: 'screen.png',
    imageSize: { width: 100, height: 200 },
    platform: 'app', theme: 'light', language: 'en', dpi: 'standard',
    elements: [{ id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 100, h: 200 }, render: 'native' }],
    relations: [], zOrder: [], warnings: [DRAFT_WARNING],
  }));
  return root;
}

describe('AnnotationWorkbenchStore', () => {
  it('lists paired entries and reports unreviewed drafts', async () => {
    const store = new AnnotationWorkbenchStore(await makeDataset());
    await expect(store.listEntries()).resolves.toEqual([expect.objectContaining({
      annotationPath: 'app/screen.json', imagePath: 'app/screen.png', reviewed: false,
    })]);
  });

  it('rejects traversal outside the dataset root', async () => {
    const store = new AnnotationWorkbenchStore(await makeDataset());
    await expect(store.readAnnotation('../outside.json')).rejects.toThrow('outside dataset root');
  });

  it('backs up the draft and marks a saved annotation as reviewed', async () => {
    const root = await makeDataset();
    const store = new AnnotationWorkbenchStore(root);
    const annotation = await store.readAnnotation('app/screen.json');
    annotation.elements[0]!.type = 'section';
    await store.saveAnnotation('app/screen.json', annotation);
    const saved = JSON.parse(await readFile(join(root, 'app/screen.json'), 'utf-8'));
    expect(saved.elements[0].type).toBe('section');
    expect(saved.warnings).toContain('human-reviewed: local-workbench');
    await expect(readFile(join(root, 'app/screen.json.bak'), 'utf-8')).resolves.toContain(DRAFT_WARNING);
  });
});
```

- [ ] **Step 2: Run the failing store test**

Run: `npx vitest run tests/ui-analysis/annotation-workbench-store.test.ts`

Expected: FAIL because `annotation-workbench/store.ts` does not exist.

- [ ] **Step 3: Implement the store**

```ts
export const DRAFT_WARNING = 'pipeline-generated draft annotation - not human verified';
export const REVIEW_WARNING = 'human-reviewed: local-workbench';

export interface WorkbenchEntry {
  annotationPath: string;
  imagePath: string;
  image: string;
  reviewed: boolean;
}

export class AnnotationWorkbenchStore {
  constructor(private readonly rootDir: string) {}

  private resolve(relativePath: string): string {
    const root = resolve(this.rootDir);
    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error('path outside dataset root');
    }
    return target;
  }

  async listEntries(): Promise<WorkbenchEntry[]> { /* scan JSON pairs recursively */ }
  async readAnnotation(relativePath: string): Promise<AnnotationFile> { /* loader-compatible validation */ }
  async readImage(relativePath: string): Promise<Buffer> { /* extension whitelist + resolve */ }
  async saveAnnotation(relativePath: string, annotation: AnnotationFile): Promise<void> {
    /* validate required metadata/elements, make one .bak copy, replace draft warning,
       append REVIEW_WARNING, write .tmp then rename */
  }
}
```

Use `loadAnnotation`-compatible required fields: `image`, `imageSize`,
`platform`, `theme`, `language`, `dpi`, and `elements`; validate every
element's `id`, `type`, numeric bbox fields, and `render`. Sort entries by
their relative annotation path for deterministic navigation.

- [ ] **Step 4: Run store tests**

Run: `npx vitest run tests/ui-analysis/annotation-workbench-store.test.ts`

Expected: PASS with three tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui-analysis/annotation-workbench/store.ts tests/ui-analysis/annotation-workbench-store.test.ts
git commit -m "feat(benchmark): add annotation workbench store"
```

### Task 2: Local HTTP Server

**Files:**
- Create: `src/ui-analysis/annotation-workbench/server.ts`
- Test: `tests/ui-analysis/annotation-workbench-server.test.ts`

- [ ] **Step 1: Write failing route tests**

```ts
import { describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { createAnnotationWorkbenchServer } from '../../src/ui-analysis/annotation-workbench/server.js';

describe('annotation workbench server', () => {
  it('returns dataset entries and rejects invalid save payloads', async () => {
    const app = await createAnnotationWorkbenchServer('/tmp/workbench-test');
    await app.listen(0);
    const address = app.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const dataset = await fetch(`http://127.0.0.1:${port}/api/dataset`);
    expect(dataset.status).toBe(200);
    const invalid = await fetch(`http://127.0.0.1:${port}/api/annotation?file=app/screen.json`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(invalid.status).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the failing server test**

Run: `npx vitest run tests/ui-analysis/annotation-workbench-server.test.ts`

Expected: FAIL because `annotation-workbench/server.ts` does not exist.

- [ ] **Step 3: Implement server routes**

```ts
export interface AnnotationWorkbenchServer {
  listen(port: number): Promise<void>;
  close(): Promise<void>;
  address(): AddressInfo | string | null;
}

export async function createAnnotationWorkbenchServer(datasetDir: string): Promise<AnnotationWorkbenchServer> {
  // GET / -> static/index.html
  // GET /app.js and /styles.css -> static files with explicit MIME types
  // GET /api/dataset -> { entries }
  // GET /api/annotation?file=... -> annotation JSON
  // PUT /api/annotation?file=... -> validate + store.saveAnnotation
  // GET /images/<relative-image-path> -> image buffer
  // all non-matching paths -> 404
}
```

Return JSON errors as `{ "error": "..." }`; return 400 for malformed JSON or
invalid annotations, 403 for root escapes, 404 for unknown API/static/image
resources, and 500 only for unexpected server errors.

- [ ] **Step 4: Run server tests**

Run: `npx vitest run tests/ui-analysis/annotation-workbench-server.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui-analysis/annotation-workbench/server.ts tests/ui-analysis/annotation-workbench-server.test.ts
git commit -m "feat(benchmark): serve local annotation workbench"
```

### Task 3: Browser Workbench

**Files:**
- Create: `src/ui-analysis/annotation-workbench/static/index.html`
- Create: `src/ui-analysis/annotation-workbench/static/app.js`
- Create: `src/ui-analysis/annotation-workbench/static/styles.css`

- [ ] **Step 1: Create the accessible page shell**

```html
<header class="topbar">
  <button id="previous" type="button">Previous</button>
  <strong id="title">Loading annotations...</strong>
  <span id="progress"></span>
  <button id="next" type="button">Next</button>
  <button id="save" type="button">Save</button>
</header>
<main>
  <section class="canvas-panel" aria-label="Screenshot annotation canvas">
    <div id="canvas-wrap"><img id="screenshot" alt="Current UI screenshot"><svg id="overlay"></svg></div>
  </section>
  <aside class="editor-panel">
    <label>Filter <select id="type-filter"><option value="">All types</option></select></label>
    <label><input id="show-overlay" type="checkbox" checked> Show boxes</label>
    <section id="selected-editor" hidden>...</section>
    <button id="delete" type="button" disabled>Delete selected</button>
    <ol id="element-list"></ol>
  </aside>
</main>
```

- [ ] **Step 2: Implement canvas state and coordinate conversion in `app.js`**

```js
function imagePoint(event) {
  const rect = screenshot.getBoundingClientRect();
  return {
    x: Math.round((event.clientX - rect.left) * state.annotation.imageSize.width / rect.width),
    y: Math.round((event.clientY - rect.top) * state.annotation.imageSize.height / rect.height),
  };
}

function renderBox(element) {
  // SVG rect uses viewBox="0 0 imageWidth imageHeight".
  // Boxes are clickable and set state.selectedId.
}
```

Load `/api/dataset`, select the first unreviewed pilot entry if it exists,
then load `/api/annotation?file=...`. Render original-pixel boxes in SVG using
`viewBox` and only redraw changed DOM nodes through one `render()` function.

- [ ] **Step 3: Implement edit, add, delete, navigation, and save interactions**

```js
function addElement(bbox) {
  const id = `manual-${crypto.randomUUID()}`;
  state.annotation.elements.push({ id, type: 'unknown', bbox, render: 'native' });
  state.selectedId = id;
  render();
}

async function save() {
  const response = await fetch(`/api/annotation?file=${encodeURIComponent(state.entry.annotationPath)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state.annotation),
  });
  if (!response.ok) throw new Error((await response.json()).error);
  state.dirty = false;
  await loadEntries();
  render();
}
```

Dragging on blank SVG space creates a new bbox only when width and height are
at least 4 original pixels. Editing type/text/render/bbox inputs updates the
selected element in memory. Deleting removes the element and removes its id
from all `children`, `relations`, and `zOrder` records to preserve valid JSON.
Navigation prompts before discarding unsaved edits.

- [ ] **Step 4: Add responsive styling**

```css
main { display: grid; grid-template-columns: minmax(0, 1fr) 22rem; min-height: calc(100vh - 3.5rem); }
#canvas-wrap { position: relative; display: inline-block; max-width: 100%; }
#screenshot { display: block; max-width: 100%; height: auto; }
#overlay { inset: 0; position: absolute; width: 100%; height: 100%; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; } }
```

Use a restrained dark tool UI with high-contrast labels, clear selected-box
highlighting, and no external web assets.

- [ ] **Step 5: Manual browser acceptance check**

Run: `npx tsx scripts/ui-annotation-workbench.ts benchmark/datasets/dev/app --port 4317`

Expected: server prints `Annotation workbench: http://127.0.0.1:4317`.

Open the URL and verify: a pilot screenshot displays; selecting a box updates
the editor; changing type/text changes the overlay/list; dragging blank space
creates an element; deleting removes it; Save persists and refreshes reviewed
progress.

- [ ] **Step 6: Commit**

```bash
git add src/ui-analysis/annotation-workbench/static
git commit -m "feat(benchmark): add browser annotation workbench"
```

### Task 4: CLI, Draft Metadata, and Pilot Workflow

**Files:**
- Create: `scripts/ui-annotation-workbench.ts`
- Modify: `scripts/ui-generate-annotations.ts`
- Modify: `package.json`
- Test: `tests/ui-analysis/annotation-workbench-store.test.ts`

- [ ] **Step 1: Add the CLI entry point**

```ts
import { createAnnotationWorkbenchServer } from '../src/ui-analysis/annotation-workbench/server.js';

const datasetDir = process.argv[2] ?? 'benchmark/datasets/dev/app';
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 4317;
const app = await createAnnotationWorkbenchServer(datasetDir);
await app.listen(Number.isFinite(port) ? port : 4317);
console.log(`Annotation workbench: http://127.0.0.1:${port}`);
```

Handle `SIGINT` and `SIGTERM` by awaiting `app.close()` before exiting.

- [ ] **Step 2: Replace the hard-coded draft warning in generator**

```ts
import { DRAFT_WARNING } from '../src/ui-analysis/annotation-workbench/store.js';
// ...
warnings: [DRAFT_WARNING],
```

This keeps generated draft state synchronized with the workbench review logic.

- [ ] **Step 3: Add package script**

```json
{
  "scripts": {
    "ui:annotate": "tsx scripts/ui-annotation-workbench.ts"
  }
}
```

- [ ] **Step 4: Verify the CLI and pipeline**

Run: `pnpm typecheck && pnpm lint && npx vitest run --fileParallelism=false tests/ui-analysis/annotation-workbench-store.test.ts tests/ui-analysis/annotation-workbench-server.test.ts`

Expected: typecheck, lint, and both workbench test files pass.

Run: `pnpm ui:annotate -- benchmark/datasets/dev/app --port 4317`

Expected: local URL is printed; `/api/dataset` lists 16 generated App drafts.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/ui-annotation-workbench.ts scripts/ui-generate-annotations.ts
git commit -m "feat(benchmark): add annotation workbench CLI"
```

### Task 5: Pilot Annotation and Benchmark Evidence

**Files:**
- Modify: `benchmark/datasets/dev/app/微信图片_20260717191823_226_25.json`
- Modify: `benchmark/datasets/dev/app/微信图片_20260717191828_229_25.json`
- Modify: `benchmark/datasets/dev/app/微信图片_20260717191835_234_25.json`
- Modify: `benchmark/datasets/dev/app/微信图片_20260717191851_241_25.json`
- Modify: `方案/08-phase-a-验证报告.md`

- [ ] **Step 1: Start the workbench and review four pilot images**

Run: `pnpm ui:annotate -- benchmark/datasets/dev/app --port 4317`

In the browser, correct the address form (`226`), drawer/member view (`229`),
card/product view (`234`), and dense profile/settings view (`241`). Save each
only after removing obvious false positives and adding visible, reconstructable
elements missed by the draft.

- [ ] **Step 2: Run the annotated benchmark for pilot files only**

Create a temporary sibling directory containing only the four reviewed
image/JSON pairs, then run:

```bash
npx tsx scripts/ui-benchmark.ts --annotations benchmark/datasets/pilot
```

Expected: all four records load, the command reports mean recall, precision,
and F1 plus per-type metrics, and no annotation is marked with
`pipeline-generated draft annotation - not human verified`.

- [ ] **Step 3: Record benchmark scope and metrics**

Add a `Pilot annotation benchmark` section to
`方案/08-phase-a-验证报告.md` with the four filenames, benchmark command,
observed R/P/F1, and the explicit limitation that the pilot does not replace
the 60-image development set or 150-image release-lock set.

- [ ] **Step 4: Run full regression suite**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit && npx vitest run --fileParallelism=false tests/ui-analysis/`

Expected: all checks pass.

- [ ] **Step 5: Commit reviewed pilot artifacts and report**

```bash
git add benchmark/datasets/pilot benchmark/datasets/dev/app 方案/08-phase-a-验证报告.md
git commit -m "test(benchmark): add reviewed UI annotation pilot"
```

## Plan Self-Review

- Spec coverage: Tasks 1-2 implement safe local persistence and all required
  API routes. Task 3 implements the canvas, editing, filtering, save, and
  mobile layout. Task 4 adds the CLI and draft-state interoperability. Task 5
  covers the four-image pilot and benchmark evidence.
- Scope: relation/z-order/control editing remains intentionally outside the
  initial workbench; existing values are preserved. No runtime analyzer or
  legacy CV code changes are included.
- Consistency: `DRAFT_WARNING`, `REVIEW_WARNING`, `AnnotationWorkbenchStore`,
  and `createAnnotationWorkbenchServer` names are used consistently in all
  tasks. API file paths are relative to the configured dataset root.
