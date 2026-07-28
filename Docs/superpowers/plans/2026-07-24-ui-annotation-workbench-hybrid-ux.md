# UI Annotation Workbench Hybrid UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chinese canvas-first annotation workbench that combines object editing, AI pre-review proposals, and issue review without mixing AI proposals with human benchmark ground truth.

**Architecture:** `AnnotationWorkbenchStore` reads AI sidecars but excludes them from dataset entries. The HTTP server exposes read-only AI proposal data; the static app owns acceptance/rejection as edits to the current human annotation until explicit save. A three-panel browser layout makes the screenshot canvas primary, with screenshot/object navigation on the left and contextual Object, AI Pre-review, and Issues inspector tabs on the right.

**Tech Stack:** TypeScript, Node `http`, Vitest, browser-native SVG/DOM/CSS, no additional runtime dependencies.

## Global Constraints

- All operator-facing interface copy is Chinese.
- `*.ai-review.json` is read-only source data and is not a dataset entry or benchmark input.
- Human annotation JSON remains the sole saved benchmark ground truth.
- Do not change runtime visual inference behavior or add model-training code.
- Preserve original-image coordinate editing, undo/redo, and destructive action confirmation.

---

### Task 1: AI Proposal Read API

**Files:**
- Modify: `src/ui-analysis/annotation-workbench/store.ts`
- Modify: `src/ui-analysis/annotation-workbench/server.ts`
- Modify: `tests/ui-analysis/annotation-workbench-store.test.ts`
- Modify: `tests/ui-analysis/annotation-workbench-server.test.ts`

**Interfaces:**
- Produces: `AnnotationWorkbenchStore.readAiReview(relativePath): Promise<AiReview>`.
- Produces: `GET /api/ai-review?file=<annotation-path>` returning the JSON sidecar.
- Consumes: `annotation.json.ai-review.json` sidecars created by the multimodal review flow.

- [ ] Add a failing store test that writes `screen.json.ai-review.json`, calls `readAiReview('app/screen.json')`, and expects its source/status/proposals fields.
- [ ] Run `npx vitest run --fileParallelism=false tests/ui-analysis/annotation-workbench-store.test.ts` and observe failure because `readAiReview` does not exist.
- [ ] Add `AiReviewProposal` and `AiReview` interfaces plus `readAiReview()` using root-confined path resolution.
- [ ] Re-run the store test and expect PASS.
- [ ] Add a failing server test for `GET /api/ai-review?file=app%2Fscreen.json` returning proposal JSON.
- [ ] Add the guarded GET route and run `tests/ui-analysis/annotation-workbench-server.test.ts`; expect PASS.

### Task 2: Three-Panel Chinese Shell

**Files:**
- Modify: `src/ui-analysis/annotation-workbench/static/index.html`
- Modify: `src/ui-analysis/annotation-workbench/static/styles.css`
- Modify: `src/ui-analysis/annotation-workbench/static/app.js`

**Interfaces:**
- Consumes: existing `/api/dataset`, `/api/annotation`, and new `/api/ai-review` endpoints.
- Produces: left panel modes `screenshots` and `objects`; right inspector tabs `object`, `ai`, and `issues`.

- [ ] Replace the single long side panel with an accessible left navigation, central canvas stage, right inspector, and collapsed lower history drawer.
- [ ] Implement Chinese tab labels, empty states, tooltips, save status, type labels, element-state labels, and error/confirmation copy.
- [ ] Keep type codes in DOM values while rendering Chinese labels such as `输入框 input`.
- [ ] Keep screenshot list and object tree mutually exclusive in the left panel to avoid excessive vertical scroll.
- [ ] Render all existing selection, bbox, form editing, delete, reset, undo, redo, and save behavior in the Object inspector.

### Task 3: AI Proposal Layer and Actions

**Files:**
- Modify: `src/ui-analysis/annotation-workbench/static/app.js`
- Modify: `src/ui-analysis/annotation-workbench/static/styles.css`
- Modify: `src/ui-analysis/annotation-workbench/static/index.html`

**Interfaces:**
- Consumes: `AiReview.proposals`, whose items have `kind`, optional `target`, `type`, `bbox`, optional `text`, and `note`.
- Produces: `acceptAiProposal(proposal)` and `rejectAiProposal(proposal)` browser actions.

- [ ] Load the sidecar after annotation load; show an AI-empty state if it is absent.
- [ ] Draw AI proposal boxes as a dashed purple read-only layer with `AI` badge and visibility toggle.
- [ ] Render proposal cards with Chinese summary, type, position, note, and `采纳`, `编辑后采纳`, `忽略` actions.
- [ ] Implement acceptance as an undoable insertion/replacement on the human annotation only; create stable `ai-review-<uuid>` IDs for additions.
- [ ] Implement rejection as session state only; it cannot mutate the AI sidecar.
- [ ] Selecting a proposal focuses its bbox and automatically opens AI Pre-review in the right inspector.

### Task 4: Issue Queue in Canvas Context

**Files:**
- Modify: `src/ui-analysis/annotation-workbench/static/app.js`
- Modify: `src/ui-analysis/annotation-workbench/static/styles.css`

**Interfaces:**
- Consumes: existing difference report plus preview report from `/api/review-preview`.
- Produces: `focusNextUnresolvedIssue()` and issue status controls in the Issues inspector.

- [ ] Default the Issues inspector to high/unresolved differences.
- [ ] Add Chinese severity/category labels, confirm/override/resolve states, and a `下一个未解决` action.
- [ ] Focus paired human/prediction bboxes when selecting an issue; maintain existing deleted-prediction red dashed rendering.
- [ ] Show issue count badges next to screenshot entries.

### Task 5: Verification

**Files:**
- Modify: `tests/ui-analysis/annotation-workbench-store.test.ts`
- Modify: `tests/ui-analysis/annotation-workbench-server.test.ts`

- [ ] Run focused store/server/diff tests.
- [ ] Run `pnpm typecheck`, `pnpm lint`, and `pnpm build`.
- [ ] Launch `pnpm ui:annotate -- benchmark/datasets/dev/app --port 4319` after stopping any stale process.
- [ ] Browser-check Chinese labels, screenshot/object mode, inspector tab changes, AI proposal selection/accept/reject, issue traversal, element editing, and narrow viewport layout.
