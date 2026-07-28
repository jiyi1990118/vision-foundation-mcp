# UI Annotation Training Loop Design

## Goal

Extend the local annotation workbench into a human-in-the-loop quality system.
Human-reviewed annotations remain the benchmark ground truth; immutable AI
predictions and automatically generated differences form a reusable error,
regression, and future-training dataset.

## Scope

The first delivery builds a review-first interface with embedded prediction vs
human difference cards. It adds direct mouse bbox editing, complete edit
history, automatic error attribution, and local review artifacts. It does not
train a model or alter the runtime analyzer directly.

## Ground Truth and Snapshots

For each dataset annotation, the workbench maintains:

1. `annotation.json`: the current human-edited annotation. It is the only
   benchmark ground truth.
2. `annotation.json.prediction.json`: immutable original AI draft captured on
   first human save. It is never overwritten by subsequent saves.
3. `annotation.json.review.json`: regenerated difference report from the
   prediction snapshot and current human annotation.
4. `annotation.json.bak`: the existing first-save safety backup.

An unreviewed annotation remains marked with `DRAFT_WARNING`. Saving removes
that warning and adds `REVIEW_WARNING`; no explanation is required. Human
annotations are accepted as correct even when no note is provided.

## Difference Model

Each review report has a stable prediction-element identifier, optional human
element identifier, automatic category, severity, confidence, confirmation
status, optional note, and optimization hints.

```ts
type DifferenceCategory =
  | 'missed'
  | 'false_positive'
  | 'wrong_type'
  | 'wrong_bbox'
  | 'wrong_text'
  | 'wrong_structure'
  | 'unknown';

interface AnnotationDifference {
  id: string;
  category: DifferenceCategory;
  predictionId?: string;
  annotationId?: string;
  iou?: number;
  severity: 'high' | 'medium' | 'low';
  confidence: number;
  reviewStatus: 'auto' | 'confirmed' | 'overridden';
  note?: string;
  ruleHints: string[];
}
```

Matching is one-to-one using IoU >= 0.5 regardless of type, choosing the
highest IoU unmatched pair. This permits a type change to be classified as
`wrong_type` rather than a misleading missed plus false positive pair.

Classification order for a matched pair is: structure change, type change,
text change, then bbox change. A bbox is `wrong_bbox` when IoU is below 0.85.
Unmatched human elements are `missed`; unmatched prediction elements are
`false_positive`.

`severity` gives high priority to missed/false-positive editable controls,
wrong types across known confused pairs (`icon/text`, `navbar/header/footer`,
`container/card/section/row`, `input/button`), and IoU below 0.5. Structural
or other low-confidence classifications are medium. Small bbox-only changes
with IoU >= 0.7 are low.

## Review-first Interface

The workbench adds a review queue above the element editor. It defaults to
high severity differences and supports filtering by category, severity, and
element state.

Selecting a difference focuses both related boxes in the canvas:

- Green solid box: human-added element (`missed`).
- Yellow solid box: human-modified element.
- Red dashed box: prediction deleted by the reviewer (`false_positive`).
- Gray box: unchanged prediction.

The difference card shows predicted type/bbox beside current human type/bbox,
the inferred category, confidence, severity, rule hints, and actions:
Confirm, Override Category, Add Note, Focus Canvas, and Restore Prediction.
High-severity differences require Confirm or Override before saving. Low and
medium differences default to automatic acceptance and can be accepted as a
batch.

## Direct Element Editing

All existing prediction elements and manually added elements can change type,
text, render strategy, semantic role, and bbox.

Canvas interactions use original-image coordinates:

- Drag inside a selected bbox to move it.
- Drag a corner handle to resize from that corner.
- Drag an edge handle to resize one dimension.
- Drag blank space to create an `unknown` element, then set its type.

The editor also exposes pixel micro-adjust buttons: up, down, left, right,
widen, narrow, heighten, and shorten. Each button changes the original-image
bbox by one pixel; holding Shift changes it by ten pixels.

## Element State and History

The UI derives state by comparing current annotation elements to the immutable
prediction snapshot:

- `UNCHANGED`: same prediction counterpart with no meaningful property change.
- `MODIFIED`: matched prediction counterpart with type, text, render,
  semantic-role, or bbox change.
- `ADDED`: no prediction counterpart.
- `DELETED`: prediction counterpart absent from current annotation.

The current-page edit session uses a command history. Add, delete, restore,
move, resize, and property edits each create one reversible command. The UI
exposes Undo, Redo, `Edit N / M`, and keyboard shortcuts `Cmd/Ctrl+Z` and
`Cmd/Ctrl+Shift+Z`.

Reset actions are explicit:

- Reset Element: restores a matched element to its prediction state; removes
  an added element.
- Restore Deleted: re-adds a deleted prediction element.
- Reset Page: discards unsaved in-memory changes and reloads the current saved
  annotation.
- Restore AI Draft: replaces the saved annotation with the immutable prediction
  snapshot only after a destructive-operation confirmation. It then regenerates
  a review report and restores `DRAFT_WARNING`.

## Queue and Active Learning

After the four-image pilot is reviewed, queue ordering uses repeated error
frequency multiplied by severity. It is descriptive only, not model scoring.

After at least 20 reviewed screenshots and 30 reviewed instances for each
high-frequency component type, the queue may enable active-learning scoring:

```
priority = 0.35 * normalizedRepeatedError
         + 0.25 * lowPredictionConfidence
         + 0.20 * conflictSignal
         + 0.20 * unexplainedAreaRatio
```

The UI labels the pre-threshold mode `Frequency-guided` and the post-threshold
mode `Active learning`; it never describes small-sample rankings as learned
model confidence.

## Training and Regression Outputs

The system offers local JSON exports for:

- reviewed annotations,
- prediction snapshots,
- difference reports,
- aggregate error frequency by page platform, prediction type, human type, and
  category.

Aggregate reports identify candidates for detector-rule changes and regression
fixtures. Human review is required before a candidate becomes a committed test
fixture. Future YOLO/ONNX export is separate work: this design preserves the
original image coordinates and element types needed for it but does not add
model-specific conversion yet.

## Validation

- Unit tests cover snapshot creation, deterministic matching, category and
  severity assignment, save/report regeneration, and destructive restore.
- Browser acceptance covers dragging/moving/resizing, keyboard undo/redo,
  deleted-element restore, state filters, difference confirmation, and restore
  AI draft confirmation.
- Benchmark runs only against reviewed annotations. Draft annotations remain
  visibly excluded from ground-truth metric reporting.

## Non-goals

- Multi-user collaboration, remote hosting, and authentication.
- Direct automatic mutation of analyzer rules from annotations.
- Claiming model training has happened before an explicit training/export
  pipeline is added.
