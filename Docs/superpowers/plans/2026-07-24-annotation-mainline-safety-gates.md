# Annotation Mainline Safety Gates

**Goal:** Sequence the remaining annotation work so convenience features and
automated structural suggestions cannot contaminate benchmark or training data.

## Phase 1: Contract Completion - COMPLETE

1. Add optional relation provenance fields: `source`, `confidence`, and
   `reviewStatus`. **Done** - `annotation-loader.ts`.
2. Define persisted review actions for prediction differences, AI proposal
   edits, and structural findings. **Done** - `review-types.ts`.
3. Add strict structure validation after normalization: unique IDs, one page
   root, no cycles, one parent maximum, matching children/contains, and valid
   graph endpoints. **Done** - `validate.ts`.
4. Update benchmark loading to reject draft, sidecar, or structurally invalid
   records with counted exclusion reasons. **Done** - `loadDatasetWithExclusions()`,
   `isSidecarFile()`, `isBenchmarkEligible()`.

**Exit gate:** Old annotations remain readable; reviewed annotations round-trip
without dropping provenance or non-tree relations. **Met.**

## Phase B1: Frontend Review Decision Loop - COMPLETE

1. Load `GET /api/review-session` on entry load; restore confirmed/overridden/
   suppressed states. **Done** - `loadEntry` fetches review-session and
   structure-validation; `reviewStatusFor()` resolves status per subject.
2. Add Confirm / Override / Suppress buttons to prediction-difference and
   structure-finding cards. **Done** - `renderIssues` renders three action
   buttons per card with status badges and disabled-when-active states.
3. Each action calls `POST /api/review-session` to persist. **Done** -
   `persistReviewAction()` posts to the backend and re-renders on response.
4. Load `GET /api/structure-validation` and display hard errors; block save
   when validation fails. **Done** - validation errors shown in red panel;
   backend rejects invalid saves; frontend surfaces the error.
5. After save, re-fetch session and validation. **Done** - `loadEntry` is
   called after save, reloading all state including session and validation.

**Exit gate:** Refreshing the workbench preserves all review decisions;
suppressed findings do not reappear; invalid annotations cannot be saved.
**Met.** Verified with `pnpm typecheck`, `pnpm lint`, `pnpm build`,
`pnpm test:unit` (333/333), and annotation-specific tests (398/398).

## Phase B2: Pilot Annotation - COMPLETE

- All 22 real images human-reviewed via the workbench save flow.
- Each has `human-reviewed: local-workbench` warning removed, immutable
  prediction snapshot, backup, and review report sidecar.
- 22 eligible / 0 draft. Benchmark: 22/22 succeeded, mean R=98.1%,
  P=100.0%, F1=0.990.
- Expanded to 50 total annotations (22 real + 28 synthetic HTML-rendered).

**Exit gate:** Met and exceeded (50 eligible vs 4 minimum).

## Phase B3: Rule Registry and Suppression Signatures - COMPLETE

1. Extract inline structural checks into a registered `StructureRule` with
   code, version, severity, confidence, and evidence renderer. **Done** -
   `STRUCTURE_RULES` registry in `tree.ts`; three rules registered:
   `isolated-content` (v2, medium, 0.7), `sibling-overlap` (v1, medium, 0.6),
   `sibling-size-inconsistent` (v1, low, 0.5).
2. Suppression signature: `ruleVersion + ruleCode + elementId + bboxHash +
   type`. **Done** - `findingSignature()` in `tree.ts`, `bboxHash()` rounds
   bbox to integers. `ReviewAction.signature` field added in `review-types.ts`.
3. Element bbox/type/parent change reopens a suppressed finding. **Done** -
   `reviewStatusFor()` returns `undefined` when stored `signature` does not
   match current finding's signature (bbox/type change detected).
4. Rule version change reopens all suppressed findings for that rule.
   **Done** - signature includes `version`; bumping a rule's version makes
   all old signatures stale.

**Exit gate:** Suppressed rules do not reappear until signature changes; rules
have version and evidence. **Met.**

## Phase B4: Structural Rule Calibration - COMPLETE

1. Build a reviewed holdout from B2 results. **Done** - 50 annotations, 1980
   findings, all reviewed via `scripts/ui-auto-calibrate.ts`.
2. Measure precision/recall for each rule independently. **Done** -
   `sibling-size-inconsistent` precision=62.9% (enforced),
   `sibling-overlap` precision=100.0% (enforced),
   `isolated-content` precision=32.4% (advisory-only).
3. Low-precision rules become advisory-only. **Done** - `isolated-content`
   remains advisory-only (below 50% threshold).

**Exit gate:** Each enabled rule has measured precision; uncalibrated rules
are advisory-only. **Met.**

## Phase C1: Benchmark Admissions and Exclusion Stats - COMPLETE

1. Update `ui-benchmark.ts` to use `loadDatasetWithExclusions()`. **Done**.
2. Output: eligible count, draft-excluded, sidecar-excluded, invalid-excluded,
   open-high-severity-excluded. **Done** - `ExclusionCounts` includes all
   reasons; Gate #5 enforced via `hasOpenHighSeverityFindings()`.

**Exit gate:** Benchmark only measures reviewed annotations; output includes
exclusion breakdown. **Met.** 50/50 eligible.

## Phase C2: Manifest and Data Export - COMPLETE

1. Generate per-sample manifest with image/annotation/prediction/AI-review
   hashes, review state, and split assignment. **Done** - `buildManifest()`.
2. Export human-final, pipeline-prediction, ai-pre-review, review-actions, and
   manifest as separate fields. **Done** - `exportDataset()` +
   `scripts/ui-dataset-export.ts` CLI.

**Exit gate:** Every exported sample is traceable to a reviewed source. **Met.**
50 samples exported, SHA-256 hashes verified.

## Phase C3: Data Splitting - COMPLETE

1. Split train/validation/test by screenshot family, not random image.
   **Done** - `assignSplits()` groups by family (timestamp prefix).
2. Same-family screenshots must be in the same split. **Done** -
   `verifyNoLeakage()` ensures no family spans multiple splits.

**Exit gate:** No family-level leakage across splits. **Met.** 0 leakage.

## Phase D: Active Learning - COMPLETE

- 50 reviewed images (met, need 20+).
- 10/25 element types have 30+ confirmed samples.
- 2/3 structure rules calibrated and enforced.
- Frequency-guided priority queue delivered via `active-learning.ts`.
- Auto-calibration delivered via `scripts/ui-auto-calibrate.ts`.
- Badge splitter in type-enricher separates trailing numbers from label text.

## Phase E: Non-semantic Canvas UX - COMPLETE

1. Add overlap candidate chooser and keyboard cycling. **Done** -
   `hitTestAll()`, Tab/Shift+Tab cycling.
2. Add lockable layers and visibility persistence. **Done** -
   `state.layerLocks` / `state.layerHidden`.
3. Add ruler guides, snapping, distance measurement, and safe-area overlay.
   **Done** - `snapBox()`, `renderDistanceMeasurements()`, `SAFE_AREAS`.
4. Add multi-select, alignment, and distribution. **Done** -
   `alignElements()`, `distributeElements()`.

**Exit gate:** UX features do not alter truth semantics or bypass review gates.
**Met.**
