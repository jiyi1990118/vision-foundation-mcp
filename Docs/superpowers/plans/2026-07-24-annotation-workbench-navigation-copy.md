# Annotation Workbench Navigation and Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the workbench three-column layout to 220/300px, add fixed two-digit ordinals to the screenshot list, and add an internal copy/paste clipboard for annotation elements with Ctrl/Cmd+C/V shortcuts and inspector buttons.

**Architecture:** Pure paste logic (offset, clamp, ID, field copy) lives in a new browser ES module `static/clipboard.js` that `app.js` imports and that vitest tests directly. Layout changes are CSS grid + list markup only. Copy/paste state is session-scoped, never persisted or sent to system clipboard.

**Tech Stack:** Vanilla ES modules (browser), Vitest (unit), Playwright (integration), existing workbench static asset conventions.

## Global Constraints

- `app.js` is loaded as `<script type="module" src="/app.js">` per `index.html:31`; new JS must be a plain ES module importable by both the browser and vitest.
- Annotation element shape: `{id,type,bbox:{x,y,w,h},render,text?,...}` per `Docs/02-contracts/05-annotation-spec.md`.
- `clamp(box)` clamps to `state.annotation.imageSize` bounds; paste must not produce out-of-bounds boxes.
- Human-reviewed `<annotation>.json` is the only ground truth; paste is an unsaved edit persisted only through `保存人工审核`.
- Keyboard guards must not intercept Ctrl/Cmd+C/V while focus is in `INPUT`, `TEXTAREA`, or `SELECT`.
- Spec: `Docs/superpowers/specs/2026-07-24-annotation-workbench-navigation-copy-design.md`.

---

### Task 1: Balanced Layout and Screenshot Ordinals

**Files:**
- Modify: `src/ui-analysis/annotation-workbench/static/styles.css` (grid columns)
- Modify: `src/ui-analysis/annotation-workbench/static/fixes.css` (screenshot item ordinal styling)
- Modify: `src/ui-analysis/annotation-workbench/static/app.js:30` (`renderScreens`)
- Test: `tests/ui-analysis/annotation-workbench-layout-ordinal.test.ts`

**Interfaces:**
- Consumes: existing `renderScreens()` and `state.entries`.
- Produces: 220px left / 300px right grid; screenshot items prefixed with two-digit ordinals.

- [ ] **Step 1: Write the failing test**

```typescript
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const stylesUrl = new URL('../../src/ui-analysis/annotation-workbench/static/styles.css', import.meta.url);
const appUrl = new URL('../../src/ui-analysis/annotation-workbench/static/app.js', import.meta.url);

describe('workbench layout and screenshot ordinals', () => {
  it('uses the balanced 220/300 three-column grid', async () => {
    const css = await readFile(stylesUrl, 'utf8');
    expect(css).toContain('grid-template-columns:220px minmax(420px,1fr) 300px');
  });

  it('renders a two-digit ordinal before each screenshot filename', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("String(i+1).padStart(2,'0')");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/annotation-workbench-layout-ordinal.test.ts`
Expected: FAIL — grid still `248px ... 342px`; no `padStart` in app.js.

- [ ] **Step 3: Update the grid columns**

In `styles.css`, replace the `.workbench` grid declaration:

Find: `grid-template-columns:248px minmax(420px,1fr) 342px`
Replace: `grid-template-columns:220px minmax(420px,1fr) 300px`

- [ ] **Step 4: Add ordinal to renderScreens**

In `app.js` line 30, update `renderScreens` to prefix the ordinal. Change the `b.innerHTML` assignment to:

```javascript
b.innerHTML=`<span class="shot-ordinal">${String(i+1).padStart(2,'0')}</span><strong>${e.image}</strong><div class="item-meta"><span class="badge ${e.reviewed?'done':''}">${e.reviewed?'已审核':'待审核'}</span><span>AI ${i===state.index?state.aiReview?.proposals?.length||0:'-'}</span></div>`;
```

- [ ] **Step 5: Add ordinal CSS**

Append to `fixes.css`:

```css
.screenshot-item { display:grid; grid-template-columns:22px 1fr; gap:6px; align-items:start; }
.shot-ordinal { font:600 12px ui-monospace,monospace; color:#94a3b8; text-align:center; padding-top:1px; }
.screenshot-item.active .shot-ordinal { color:#285ccf; }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/annotation-workbench-layout-ordinal.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui-analysis/annotation-workbench/static/styles.css src/ui-analysis/annotation-workbench/static/fixes.css src/ui-analysis/annotation-workbench/static/app.js tests/ui-analysis/annotation-workbench-layout-ordinal.test.ts
git commit -m "feat(workbench): balanced 220/300 layout with screenshot ordinals"
```

---

### Task 2: Clipboard Pure Module

**Files:**
- Create: `src/ui-analysis/annotation-workbench/static/clipboard.js`
- Test: `tests/ui-analysis/annotation-workbench-clipboard.test.ts`

**Interfaces:**
- Consumes: element shape `{id,type,bbox,render,text?}` and `{width,height}` image size.
- Produces: `createPastedElement(source, pasteCount, imageSize)` returning a new element with a fresh `id`, 12px×`pasteCount` cumulative offset, clamped bbox, and copied `type`/`text`/`render`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import { createPastedElement } from '../../src/ui-analysis/annotation-workbench/static/clipboard.js';

const source = { id: 'el-1', type: 'button', bbox: { x: 100, y: 200, w: 80, h: 32 }, render: 'native', text: '保存' };
const imageSize = { width: 1200, height: 2670 };

describe('createPastedElement', () => {
  it('copies type, text, render, and size with a new id', () => {
    const pasted = createPastedElement(source, 1, imageSize);
    expect(pasted.id).not.toBe(source.id);
    expect(pasted.type).toBe('button');
    expect(pasted.text).toBe('保存');
    expect(pasted.render).toBe('native');
    expect(pasted.bbox.w).toBe(80);
    expect(pasted.bbox.h).toBe(32);
  });

  it('offsets 12px right and down on first paste', () => {
    const pasted = createPastedElement(source, 1, imageSize);
    expect(pasted.bbox.x).toBe(112);
    expect(pasted.bbox.y).toBe(212);
  });

  it('accumulates offset across consecutive pastes', () => {
    const first = createPastedElement(source, 1, imageSize);
    const second = createPastedElement(source, 2, imageSize);
    expect(second.bbox.x).toBe(124);
    expect(second.bbox.y).toBe(224);
  });

  it('clamps to image bounds when offset exceeds width', () => {
    const edge = { ...source, bbox: { x: 1140, y: 200, w: 80, h: 32 } };
    const pasted = createPastedElement(edge, 1, imageSize);
    expect(pasted.bbox.x + pasted.bbox.w).toBeLessThanOrEqual(imageSize.width);
    expect(pasted.bbox.x).toBe(imageSize.width - 80);
  });

  it('clamps to image bounds when offset exceeds height', () => {
    const edge = { ...source, bbox: { x: 100, y: 2650, w: 80, h: 32 } };
    const pasted = createPastedElement(edge, 1, imageSize);
    expect(pasted.bbox.y + pasted.bbox.h).toBeLessThanOrEqual(imageSize.height);
    expect(pasted.bbox.y).toBe(imageSize.height - 32);
  });

  it('does not mutate the source element', () => {
    createPastedElement(source, 1, imageSize);
    expect(source.bbox.x).toBe(100);
    expect(source.bbox.y).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/annotation-workbench-clipboard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the clipboard module**

`src/ui-analysis/annotation-workbench/static/clipboard.js`:

```javascript
const PASTE_OFFSET = 12;

function clampBox(box, imageSize) {
  const w = Math.max(1, Math.min(box.w, imageSize.width));
  const h = Math.max(1, Math.min(box.h, imageSize.height));
  const x = Math.max(0, Math.min(box.x, imageSize.width - w));
  const y = Math.max(0, Math.min(box.y, imageSize.height - h));
  return { x, y, w, h };
}

export function createPastedElement(source, pasteCount, imageSize) {
  const offset = PASTE_OFFSET * pasteCount;
  const bbox = clampBox({
    x: source.bbox.x + offset,
    y: source.bbox.y + offset,
    w: source.bbox.w,
    h: source.bbox.h,
  }, imageSize);
  const pasted = {
    id: `copy-${crypto.randomUUID()}`,
    type: source.type,
    bbox,
    render: source.render,
  };
  if (source.text !== undefined) pasted.text = source.text;
  return pasted;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/annotation-workbench-clipboard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui-analysis/annotation-workbench/static/clipboard.js tests/ui-analysis/annotation-workbench-clipboard.test.ts
git commit -m "feat(workbench): add clipboard pure module for pasted elements"
```

---

### Task 3: Wire Copy/Paste into the Workbench

**Files:**
- Modify: `src/ui-analysis/annotation-workbench/static/app.js` (import, state, handlers, buttons)
- Modify: `src/ui-analysis/annotation-workbench/static/index.html:24` (add copy/paste buttons)
- Test: `tests/ui-analysis/annotation-workbench-copy-paste.test.ts`

**Interfaces:**
- Consumes: `createPastedElement` from `clipboard.js`; existing `selected()`, `snapshot()`, `changed()`, `clamp()`, `state`, `$`.
- Produces: session-scoped `state.clipboard` and `state.pasteCount`; `copyElement()` and `pasteElement()` functions; keyboard + button wiring.

- [ ] **Step 1: Write the failing test**

```typescript
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const appUrl = new URL('../../src/ui-analysis/annotation-workbench/static/app.js', import.meta.url);
const htmlUrl = new URL('../../src/ui-analysis/annotation-workbench/static/index.html', import.meta.url);

describe('workbench copy/paste wiring', () => {
  it('imports createPastedElement from the clipboard module', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain("import{createPastedElement}from'./clipboard.js'");
  });

  it('adds clipboard and pasteCount to state', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('clipboard:null');
    expect(js).toContain('pasteCount:0');
  });

  it('defines copyElement and pasteElement functions', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toContain('function copyElement()');
    expect(js).toContain('function pasteElement()');
  });

  it('guards shortcuts against editable controls', async () => {
    const js = await readFile(appUrl, 'utf8');
    expect(js).toMatch(/['"]INPUT['"]|['"]TEXTAREA['"]|['"]SELECT['"]/);
  });

  it('adds copy and paste buttons to the inspector', async () => {
    const html = await readFile(htmlUrl, 'utf8');
    expect(html).toContain('id="copy-element"');
    expect(html).toContain('id="paste-element"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/annotation-workbench-copy-paste.test.ts`
Expected: FAIL — no import, no clipboard state, no functions, no buttons.

- [ ] **Step 3: Add import and state fields**

At the very top of `app.js` (before `const COLORS`), add:

```javascript
import{createPastedElement}from'./clipboard.js';
```

In the `state` object (line 6), add `clipboard:null,pasteCount:0,` after `showSuppressed:false`.

- [ ] **Step 4: Add copyElement and pasteElement functions**

Add after the `resetElement` function definition (before `async function save`):

```javascript
function copyElement(){const el=selected();if(!el)return;state.clipboard=clone(el);state.pasteCount=0;render()}
function pasteElement(){if(!state.clipboard)return;const before=snapshot();state.pasteCount++;const pasted=createPastedElement(state.clipboard,state.pasteCount,state.annotation.imageSize);state.annotation.elements.push(pasted);state.selectedId=pasted.id;changed(before)}
```

- [ ] **Step 5: Add buttons to index.html**

In `index.html` line 24, find the `.button-stack` div in `#selected-editor`:

```html
<div class="button-stack"><button id="reset-element" type="button">恢复此元素</button><button id="delete" class="danger" type="button">删除元素</button></div>
```

Replace with:

```html
<div class="button-stack"><button id="copy-element" type="button">复制元素</button><button id="paste-element" type="button" disabled>粘贴元素</button></div><div class="button-stack"><button id="reset-element" type="button">恢复此元素</button><button id="delete" class="danger" type="button">删除元素</button></div>
```

- [ ] **Step 6: Wire button clicks and update paste button state**

In the event-binding section (line 54, after `$('reset-element').onclick=resetElement;`), add:

```javascript
$('copy-element').onclick=copyElement;$('paste-element').onclick=pasteElement;
```

In `renderObjectInspector` (line 32), after `$('selection-badge').textContent=elementState(el);`, add:

```javascript
$('paste-element').disabled=!state.clipboard;
```

- [ ] **Step 7: Add keyboard handlers**

In the `keydown` listener (end of app.js, the existing `Ctrl/Cmd+Z` handler), extend it to handle C and V. Replace the existing keydown listener with:

```javascript
document.addEventListener('keydown',e=>{const tag=document.activeElement?.tagName;if(['INPUT','TEXTAREA','SELECT'].includes(tag))return;if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?$('redo').click():$('undo').click()}else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='c'){e.preventDefault();copyElement()}else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='v'){e.preventDefault();pasteElement()}});
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run --fileParallelism=false tests/ui-analysis/annotation-workbench-copy-paste.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/ui-analysis/annotation-workbench/static/app.js src/ui-analysis/annotation-workbench/static/index.html tests/ui-analysis/annotation-workbench-copy-paste.test.ts
git commit -m "feat(workbench): add internal copy/paste with shortcuts and buttons"
```

---

### Task 4: Integration Verification and Documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `Docs/superpowers/specs/2026-07-24-annotation-mainline-supplement.md`

- [ ] **Step 1: Run full verification suite**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test:unit
```
Expected: all pass.

- [ ] **Step 2: Browser integration check**

Reload `http://127.0.0.1:52000`, select an annotation element, press Ctrl/Cmd+C, then Ctrl/Cmd+V. Confirm:
- A new box appears offset 12px right/down.
- Paste button enables after copy, disables when no clipboard.
- Ordinal `01`–`16` appears in screenshot list.
- Left panel measures 220px, right panel 300px.

- [ ] **Step 3: Update AGENTS.md**

After the AI overlay note, add:

```markdown
**Workbench layout is balanced and supports copy/paste.** The three-column grid
is 220px/300px, screenshot entries show two-digit ordinals, and annotation
elements can be copied (Ctrl/Cmd+C) and pasted (Ctrl/Cmd+V) within the current
session via an internal clipboard that never touches system clipboard or
ground-truth files.
```

- [ ] **Step 4: Update supplement spec**

Add to the Implemented Baseline list:

```markdown
- Three-column workbench uses a balanced 220px/300px layout; screenshot entries
  show fixed two-digit ordinals. Selected annotation elements can be copied and
  pasted within the session via Ctrl/Cmd+C/V or inspector buttons; paste offsets
  12px cumulatively and clamps to image bounds.
```

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md Docs/superpowers/specs/2026-07-24-annotation-mainline-supplement.md
git commit -m "docs: document workbench layout and copy/paste feature"
```
