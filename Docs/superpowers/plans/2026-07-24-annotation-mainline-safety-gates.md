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

## Phase B2: Pilot Annotation - READY FOR HUMAN REVIEW

- Human-review 4 pilot images: 226, 229, 234, 241.
- Accept/modify AI proposals, correct bbox/type, confirm/suppress findings,
  save each as reviewed.
- Verify `.session.json`, `.review.json`, and `.prediction.json` are correct.

**Preparation complete:** the generator previously read a nonexistent
`ocrResult.ocrItems` field, silently discarding OCR text. It now parses the
provider's JSON response through `extractOcrItems()`, passes the resulting
positioned items to layout extraction and UI analysis, and persists a separate
immutable `.prediction.json` plus zero-difference `.review.json` before any
human edit. Only pilots 226/229/234/241 were regenerated. Their draft/prediction
text-node counts are 17/17, 43/43, 28/28, and 51/51 respectively.

**Exit gate:** 4 images reviewed, no `DRAFT_WARNING`, benchmark loader counts
4 eligible / 12 draft-excluded.

## Phase B3: Rule Registry and Suppression Signatures - COMPLETE

1. Extract inline structural checks into a registered `StructureRule` with
   code, version, severity, confidence, and evidence renderer. **Done** -
   `STRUCTURE_RULES` registry in `tree.ts`; three rules registered:
   `isolated-content` (v1, medium, 0.7), `child-outside-parent` (v1, medium,
   0.8), `sibling-size-inconsistent` (v1, low, 0.5).
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
have version and evidence. **Met.** Verified with `pnpm typecheck`, `pnpm lint`,
`pnpm build`, `pnpm test:unit` (333/333), and annotation tests (47/47).

## Phase B4: Structural Rule Calibration - NOT STARTED

1. Build a small reviewed holdout from B2 results.
2. Measure precision/recall for each rule independently.
3. Low-precision rules become advisory-only (no queue priority, no save block).

**Exit gate:** Each enabled rule has measured precision; uncalibrated rules
are advisory-only.

## Phase C1: Benchmark Admissions and Exclusion Stats - NOT STARTED

1. Update `ui-benchmark.ts` to use `loadDatasetWithExclusions()`.
2. Output: eligible count, draft-excluded, sidecar-excluded, invalid-excluded,
   open-high-severity-excluded.

**Exit gate:** Benchmark only measures reviewed annotations; output includes
exclusion breakdown.

## Phase C2: Manifest and Data Export - NOT STARTED

1. Generate per-sample manifest with image/annotation/prediction/AI-review
   hashes, review state, and split assignment.
2. Export human-final, pipeline-prediction, ai-pre-review, review-actions, and
   manifest as separate fields.

**Exit gate:** Every exported sample is traceable to a reviewed source.

## Phase C3: Data Splitting - NOT STARTED

1. Split train/validation/test by screenshot family, not random image.
2. Same-family screenshots must be in the same split.

**Exit gate:** No family-level leakage across splits.

## Phase D: Active Learning - NOT STARTED (depends on B4 + C1)

- After 20 reviewed images + 30 confirmed elements per high-frequency type +
  calibrated structure rules.
- Before threshold: frequency-guided priority only.

## Phase E: Non-semantic Canvas UX - NOT STARTED (lowest priority, parallel after B1)

1. Add overlap candidate chooser and keyboard cycling.
2. Add lockable layers and visibility persistence.
3. Add ruler guides, snapping, distance measurement, and safe-area overlay.
4. Add multi-select, alignment, and distribution.

**Exit gate:** UX features do not alter truth semantics or bypass review gates.
