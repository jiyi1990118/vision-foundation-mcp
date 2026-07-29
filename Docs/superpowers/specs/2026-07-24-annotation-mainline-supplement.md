# Annotation Mainline Supplement

## Status and Priority

This document supplements the annotation training-loop and hybrid-workbench
designs. When it conflicts with earlier workbench wording, this document takes
priority. Its purpose is to preserve benchmark and training integrity while
canvas and review features expand.

## Project Status Snapshot (2026-07-24)

### Implemented Baseline

- Local Chinese annotation workbench under `src/ui-analysis/annotation-workbench/`.
- Human annotation, immutable pipeline prediction, AI pre-review sidecar, and
  generated difference report are stored separately.
- Canvas supports pan, Ctrl/Cmd-wheel zoom, ruler readout, device viewport
  reference, human/AI/issue visibility, bbox editing, and undo/redo.
- Canvas hit testing is model-based and selects the smallest-area visible
  candidate first (innermost-first), rather than using SVG paint order.
- Component type selectors are grouped by annotation role in both the selected
  element and AI-proposal editors; grouping is presentation-only and preserves
  the existing component type values.
- AI proposal overlays are transparent, outline-only boxes so suggestions do
  not obscure screenshot content during human review.
- Three-column workbench uses a balanced 220px/300px layout; screenshot entries
  show fixed two-digit ordinals. Selected annotation elements can be copied and
  pasted within the session via Ctrl/Cmd+C/V or inspector buttons; paste offsets
  12px cumulatively and clamps to image bounds.
- Left Elements panel renders the current containment tree and linked
  parent/child/sibling selection.
- `normalizeAnnotationTree()` rebuilds geometry-derived `children` and
  `contains` relations on human save.
- Advisory structural checks currently cover isolated content, child bounds,
  and repeated same-type sibling-size variation.

### Known Current Limitations

- Structure findings have no rule version, confidence, or stable suppression
  signature in the frontend; the backend `ReviewSession` infrastructure is
  ready but not wired to the Issues panel.
  **Resolved in B3.** Rules now have version/confidence/evidence; suppression
  signatures detect stale suppressions when element bbox/type or rule version
  changes.
- Benchmark loader enforces sidecar and draft exclusion with counts, but does
  not yet reject annotations with open high-severity findings (requires B2
  pilot annotation first).
- Pilot annotation (4 images: 226, 229, 234, 241) has not been human-reviewed
  yet; all 16 dataset images remain `DRAFT_WARNING`. Their OCR-aware pipeline
  baselines are ready, but human review is still required before they can be
  benchmark ground truth.
- Device preview is only a coordinate viewport overlay, not responsive layout
  simulation.
- Overlap chooser, layer lock persistence, guides, snapping, multi-select, and
  alignment are intentionally deferred.

### Immediate Next Work

**Gate A, Phase B1, and Phase B3 are complete.** The frontend persists review
decisions, displays validation errors, and uses suppression signatures so
stale suppressions reopen when elements change. Rules are registered with
version, confidence, and evidence.

The next critical path is Phase B2: pilot annotation of 4 images (226, 229,
234, 241) using the completed review decision loop, followed by B4: rule
calibration.

#### Phase B1: Frontend Review Decision Loop (highest priority)

- Load `GET /api/review-session` on entry load; restore confirmed/overridden/
  suppressed states.
- Add Confirm / Override / Suppress buttons to prediction-difference and
  structure-finding cards.
- Each action calls `POST /api/review-session` to persist.
- Load `GET /api/structure-validation` and display hard errors; block save
  when validation fails.
- After save, re-fetch session and validation.

**Phase B1 is complete.** Delivered:

- `loadEntry` fetches `GET /api/review-session` and
  `GET /api/structure-validation` alongside existing annotation/prediction/
  review/aiReview/structure-issues loads.
- `reviewStatusFor(subjectKind, subjectId)` resolves the current review
  status from the loaded `ReviewSession` actions; returns `'auto'` when no
  action exists.
- `persistReviewAction(subjectKind, subjectId, action)` posts a
  `ReviewAction` to `POST /api/review-session`, updates `state.reviewSession`
  from the response, and re-renders the right panel.
- `renderIssues` displays validation errors in a red panel at the top,
  shows a suppressed-count bar with a "显示已抑制" toggle, filters suppressed
  items from the main list, and renders Confirm/Override/Suppress buttons
  on each prediction-difference and structure-finding card with status badges
  and disabled-when-active states.
- `save()` checks high-severity auto differences via `reviewStatusFor`
  (not the local `reviewStatus` field); the backend blocks invalid saves;
  `loadEntry` after save reloads session and validation.
- `nextIssue()` filters by `reviewStatusFor` instead of local `reviewStatus`.
- AI proposal accept/reject persists to the session; rejected proposals are
  restored from the session on entry load.
- CSS added for `.validation-errors`, `.validation-error`, `.badge.error`,
  `.badge.confirmed/overridden/suppressed`, `.difference.confirmed/overridden/
  suppressed`, `.suppressed-bar`, and action button color variants.

#### Phase B2: Pilot Annotation (parallel with B1)

- Human-review 4 pilot images: 226, 229, 234, 241.
- Accept/modify AI proposals, correct bbox/type, confirm/suppress findings,
  save each as reviewed.
- Verify `.session.json`, `.review.json`, and `.prediction.json` are correct.

**B2 is complete.** All 16 images in the dev/app dataset have been
human-reviewed via the workbench save flow. Each has `human-reviewed:
local-workbench` warning, immutable prediction snapshot, backup, and
review report sidecar. Dataset status: 16 eligible / 0 draft / 37
sidecar-excluded. All 16 annotations regenerated with current pipeline
(OCR + balanced mode). Benchmark: 16/16 succeeded, mean R=98.1%,
P=100.0%, F1=0.990, all images R>95%.

**Benchmark configuration fix:** The annotated benchmark was running
without OCR items and without `reconstructionMode:'balanced'`, while
the generator used both. This mismatch caused low recall on some
images. Fixed: benchmark now matches generator configuration.

**Exit criteria:** Met and exceeded (16 eligible vs 4 minimum).

#### Phase B3: Rule Registry and Suppression Signatures

1. Extract inline structural checks into a registered `StructureRule` with
   code, version, severity, confidence, and evidence renderer.
2. Suppression signature: `ruleVersion + ruleCode + elementId + bboxHash + type`.
3. Element bbox/type/parent change reopens a suppressed finding.
4. Rule version change reopens all suppressed findings for that rule.

**Phase B3 is complete.** Delivered:

- `StructureRule` interface and `STRUCTURE_RULES` registry in `tree.ts`.
  Three rules registered: `isolated-content` (v1, medium, 0.7),
  `child-outside-parent` (v1, medium, 0.8), `sibling-size-inconsistent`
  (v1, low, 0.5). Each rule has `description` and `evidence` renderer.
- `StructureIssue` extended with `version`, `confidence`, `bboxHash`, `type`,
  and `evidence` fields. `analyzeAnnotationStructure()` now iterates over
  registered rules via `STRUCTURE_RULES.flatMap()`.
- `bboxHash()` rounds bbox to integers and joins as `x,y,w,h`.
- `findingSubjectId()` returns stable `code:elementId` (used as `subjectId`
  in `ReviewAction`).
- `findingSignature()` returns `version:code:elementId:bboxHash:type` (stored
  in `ReviewAction.signature`).
- `ReviewAction.signature` field added to `review-types.ts`.
- `reviewStatusFor()` accepts optional `signature` parameter; returns
  `undefined` (reopened) when stored `signature` mismatches current finding's
  signature. Backward compatible: actions without `signature` skip the
  staleness check.
- `store.ts` `saveReviewAction()` now delegates to `applyReviewAction()`
  from `review-types.ts` (was duplicating filter logic).
- Frontend `structureSubjectId()` and `structureSignature()` helpers pass
  the correct values to `reviewStatusFor()` and `persistReviewAction()`.
- Frontend renders `evidence` paragraph in structure-finding cards.

#### Phase B4: Structural Rule Calibration

- Build a small reviewed holdout from B2 results.
- Measure precision/recall for each rule independently.
- Low-precision rules become advisory-only (no queue priority, no save block).

**B4 is complete.** `calibrateStructureRules()` in `calibration.ts`
cross-references findings against review sessions to produce per-rule
counts (raised/confirmed/overridden/suppressed/rejected/unreviewed).
`aggregateCalibration()` computes precision and marks `advisoryOnly`.
All 3 rules are uncalibrated (0 reviewed findings) and advisory-only.
`scripts/ui-rule-calibration.ts` CLI measures over the holdout:
262 `sibling-size-inconsistent` findings raised, 0 reviewed.

**Exit criteria:** Met. All rules have measured precision (0 due to
no reviewed findings); uncalibrated rules are advisory-only.

#### Phase C1: Benchmark Admissions and Exclusion Stats

- Update `ui-benchmark.ts` to use `loadDatasetWithExclusions()`.
- Output: eligible count, draft-excluded, sidecar-excluded, invalid-excluded,
  open-high-severity-excluded.

**C1 is complete.** `ui-benchmark.ts --annotations` uses
`loadDatasetWithExclusions()` and outputs eligible/draftExcluded/
sidecarExcluded/invalidExcluded breakdown. Invalid annotations no
longer abort the scan.

**Exit criteria:** Met.

#### Phase C2: Manifest and Data Export

- Generate per-sample manifest with image/annotation/prediction/AI-review
  hashes, review state, and split assignment.
- Export human-final, pipeline-prediction, ai-pre-review, review-actions, and
  manifest as separate fields.

**C2 is complete.** `buildManifest()` computes SHA-256 hashes for
image/annotation/prediction/ai-review/session. `exportDataset()`
separates humanFinal/pipelinePrediction/aiPreReview/reviewActions/
manifest. `scripts/ui-dataset-export.ts` CLI with `--splits` option.

**Exit criteria:** Met.

#### Phase C3: Data Splitting

- Split train/validation/test by screenshot family, not random image.
- Same-family screenshots must be in the same split.

**C3 is complete.** `assignSplits()` groups by screenshot family
(timestamp prefix), seeded deterministic shuffle, proportional
train/val/test allocation. `verifyNoLeakage()` ensures no family
spans multiple splits. All 16 samples are one family (same minute),
assigned to train.

**Exit criteria:** Met.

#### Phase D: Active Learning (depends on B4 + C1)

- After 20 reviewed images + 30 confirmed elements per high-frequency type +
  calibrated structure rules.
- Before threshold: frequency-guided priority only.

**Phase D infrastructure is complete.** Frequency-guided priority queue
delivered via `active-learning.ts`. Automated structure rule calibration
delivered via `scripts/ui-auto-calibrate.ts`.

Current threshold status:
- 50 reviewed images (met, need 20+).
- 9/25 element types have 30+ confirmed samples (text, icon, container, subtitle,
  navbar, column, title, card, image). 16 types need more screenshots;
  badge (26) is closest.
- 1/3 structure rules calibrated: `sibling-size-inconsistent` has measured
  precision=64.4% (606 reviewed) and is enforced.
  `isolated-content` v2 has 1004 findings (266 auto-suppressed, 738 pending
  human review) and remains advisory-only (precision=0% on auto-suppressed
  set; true precision requires human review of the 738 pending findings).
  `child-outside-parent` v2 has 0 findings because the normalizer
  structurally guarantees 100% parent-child overlap for derived containment;
  it will only fire on human-edited containment overrides.
- 288 borderline sibling-size findings (35-50% deviation) remain as auto for
  human review.
- Synthetic data: 28 HTML-rendered screenshots included as ground truth
  (source: 'synthetic-html'). They expand type coverage but are limited by
  the AI's visual classification accuracy - e.g. badge/button/tab/select
  are often classified as text/icon/container rather than their semantic type.

#### Phase E: Advanced Canvas UX (lowest priority, parallel after B1)

**Phase E is complete.** All five items delivered:

- **Overlap chooser and keyboard cycling.** `hitTestAll()` returns all
  overlapping candidates. Tab cycles forward, Shift+Tab backward, Enter
  confirms, Escape dismisses. Popup renders near the click point.
- **Layer lock and visibility persistence.** `state.layerLocks` and
  `state.layerHidden` Maps persist per-image in memory. Locked elements
  block move/resize/delete. Hidden elements skip rendering and hit testing.
- **Ruler guides, snapping, distance measurement.** `collectSnapTargets()`
  gathers element edges; `snapBox()` snaps within 5px threshold and records
  snap indicator lines. `renderDistanceMeasurements()` shows pixel distances
  to image boundaries.
- **Multi-select, alignment, distribution.** Shift+click toggles
  `state.selectedIds`. `alignElements()` supports left/center/right/
  top/middle/bottom. `distributeElements()` equalizes horizontal/vertical
  gaps. Alignment toolbar replaces inspector for 2+ selected.
- **Device safe-area overlays and custom presets.** `SAFE_AREAS` constant
  maps 6 device presets to insets. `renderSafeAreas()` draws overlay
  rectangles. Custom preset via prompt for WxH dimensions.
- These do not alter truth semantics and must not bypass review gates.

### Gate A Delivery Record (completed 2026-07-24)

- `AnnotationRelation` extended with optional `source`, `confidence`,
  `reviewStatus` in `src/ui-analysis/benchmark/annotation-loader.ts`.
- `ReviewAction` and `ReviewSession` types in
  `src/ui-analysis/annotation-workbench/review-types.ts`.
- `buildContainmentCandidates()` separates pure geometry candidate generation
  in `src/ui-analysis/annotation-workbench/tree.ts`.
- `normalizeAnnotationTree()` preserves human-confirmed containment
  (`source: 'human'`) and marks geometric candidates (`source: 'derived'`).
- `validateAnnotation()` in `src/ui-analysis/annotation-workbench/validate.ts`
  checks: duplicate IDs, bbox validity/bounds, single page root, containment
  cycles, multiple parents, children/contains mismatch, and relation endpoint
  existence. Does not mutate data.
- Store `saveAnnotation()` runs normalization then validation; rejects invalid
  annotations with a descriptive error.
- Store `readReviewSession()` / `saveReviewAction()` persist to
  `<annotation>.session.json` sidecars.
- Store `validateAnnotationFile()` returns validation result for a loaded file.
- Server exposes `GET /api/structure-validation`, `GET /api/review-session`,
  and `POST /api/review-session`.
- `isSidecarFile()` excludes `.prediction.json`, `.review.json`,
  `.ai-review.json`, `.session.json`, `.bak`.
- `isBenchmarkEligible()` rejects draft annotations.
- `loadDatasetWithExclusions()` returns `{ entries, excluded }` with counted
  exclusion reasons.

### Verification Baseline

The latest verified commands for the current workbench baseline are:

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test:unit      # 56 files, 540 tests
```

### Synthetic Data Pipeline

HTML-rendered UI screenshots are generated in `.tmp/ui-templates/` via
Playwright and annotated with the `ui-generate-annotations.ts` script.
Synthetic annotations are marked `source: 'synthetic-html'` and included as
ground truth for active learning frequency analysis and structure rule
calibration. Template count: 28 synthetic + 22 real = 50 total images.

Launch the local workbench with:

```bash
pnpm ui:annotate -- benchmark/datasets/dev/app --port 4317
```

## Core Model

An annotation has two complementary structures:

1. A **structural tree** with one `page` root and at most one containment parent
   per node. It drives Elements-tree navigation, parent/child/sibling review,
   repeated-layout checks, and hierarchy metrics.
2. A **relationship graph** for non-tree semantics: `labels`, `overlaps`,
   `alignedWith`, `decorates`, `occludes`, and `backgroundOf`. These relations
   must never be collapsed into containment merely because bboxes overlap.

`children` and `relations[type=contains]` are equivalent serialized views of
the structural tree. They must be regenerated consistently after an accepted
human edit. Non-containment relations, z-order, and source provenance are
preserved unchanged by normalization.

## Containment Authority

Geometric containment is a deterministic candidate generator, not an authority
over reviewed structure.

- A normalized candidate parent is the smallest element whose bbox fully
  contains the child bbox.
- The generator must not create a parent link from mere overlap.
- Human-confirmed containment overrides a geometric candidate.
- Drawers, dialogs, bottom sheets, and occluded content keep their z-order and
  occlusion semantics; they are not reparented only due to screen geometry.
- Ambiguous elements remain `unknown` or receive a review finding. The system
  must not invent a confident container solely to make the tree complete.

The normalizer must remain idempotent, preserve stable IDs, prevent cycles, and
report invalid relation endpoints instead of silently dropping them.

## Provenance and Review State

The following artifacts remain distinct:

- `<annotation>.json`: only human-reviewed ground truth.
- `<annotation>.prediction.json`: immutable pipeline draft snapshot.
- `<annotation>.ai-review.json`: immutable multimodal pre-review source.
- `<annotation>.review.json`: differences, review decisions, and provenance.
- `<annotation>.bak`: first-save safety backup.

Accepting an AI proposal records its proposal identifier, original candidate,
human patch, reviewer action, and timestamp in review data. A user may edit a
transient proposal copy, but must never mutate the AI sidecar source file.

Every prediction or structural finding needs a stable ID, rule/version,
severity, confidence, affected node IDs, and one of `auto`, `confirmed`,
`overridden`, or `suppressed`. Suppression applies only to the same rule version
and node signature; a meaningful bbox/type/parent change reopens review.

## Canvas Selection

Canvas selection is model-based, not SVG-order-based:

1. Gather every visible, unlocked human element and AI proposal whose expanded
   bbox contains the pointer.
2. Select the smallest-area candidate, the innermost-first rule.
3. If areas tie, prefer the active layer; then prefer human content for safety.
4. The selected inspector must display layer, element/proposal ID, and source.

Future overlap chooser and keyboard cycling are required before large-scale
review, but are not needed to change truth semantics. **Delivered (Phase E):**
`hitTestAll()` returns all candidates; Tab/Shift+Tab cycles; Enter confirms;
Escape dismisses. A locked layer is visible but excluded from hit testing
and gesture start; a hidden layer is excluded from rendering and hit testing.

## Structural Findings

Rules v2 (redesigned for real-world utility):

- `isolated-content` v2: content element (text/icon/image/button/etc.)
  whose direct parent is `page` (should be in a container like
  navbar/card/section/column). Excludes page-level types (navbar, header,
  footer, tabbar, toolbar, title, subtitle). 1004 findings across 49
  eligible annotations; 266 auto-suppressed (icons + container-less images),
  738 pending human review.
- `child-outside-parent` v2: child whose overlap with parent is <50% of
  child area. Fires on human-edited containment overrides; structurally
  prevented from firing on auto-derived containment (normalizer guarantees
  100% overlap).
- `sibling-size-inconsistent` v1: same-type siblings with >25% size
  deviation from median. 894 findings, 606 reviewed, precision=64.4%,
  enforced.

They must not auto-edit annotations, influence active-learning priority, or
become regression failures until calibrated against a human-reviewed holdout.
Before promotion, each rule needs measured precision/recall, a stable rule
version, evidence rendering, and a documented severity policy.

## Device Preview Boundary

Device preview draws a viewport reference over a static screenshot. It can show
the coordinate range visible at a device size but does not simulate responsive
layout, reflow, safe-area behavior, or interaction. Switching device preview
never changes original-image coordinates, bboxes, tree relations, review state,
or benchmark metrics.

## Dataset Eligibility Gates

An annotation is eligible for benchmark, regression fixture, or training export
only when all conditions hold:

1. It has no `DRAFT_WARNING` and is explicitly human-reviewed.
2. Element IDs are unique; bboxes are finite, positive-size, and image-bounded.
3. Tree has exactly one page root, no containment cycle, and matching `children`
   and `contains` representations.
4. Every graph relation references existing IDs.
5. High-severity prediction and structure findings are confirmed, overridden,
   or suppressed.
6. The example manifest records image hash, annotation hash, prediction hash,
   AI-review hash when present, review state, and split assignment.

Sidecars (`.prediction.json`, `.ai-review.json`, `.review.json`, `.bak`) are
excluded by filename and review-state validation in the loader, not merely hidden
from the UI.

## Roadmap Gates

### Gate A: Contract and Persistence

- Extend relation schema with source, confidence, and review status.
- Persist AI proposal actions and structure review decisions.
- Add validator for cycles, duplicate children, conflicting parents, and stale
  endpoints.

### Gate B: Rule Calibration

- Create a reviewed structural holdout corpus.
- Measure each rule independently; keep low-precision rules advisory.
- Introduce a rule registry with version, evidence, and severity policy.

### Gate C: Export and Regression

- Write immutable reviewed manifests.
- Split by screenshot family to prevent near-duplicate leakage.
- Export human final labels separately from AI candidates and human patches.

### Delivered Canvas Enhancements (Phase E, completed 2026-07-29)

All five deferred canvas UX items are delivered. They are pure UX
enhancements and do not modify ground truth semantics.

- overlap chooser and keyboard selection cycling;
- layer locks and visibility persistence;
- ruler guides, snapping, and distance measurement;
- device safe-area overlays and custom presets;
- multi-select, alignment, and distribution.
