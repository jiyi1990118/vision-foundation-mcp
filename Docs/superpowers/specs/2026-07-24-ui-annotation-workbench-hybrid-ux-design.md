# UI Annotation Workbench Hybrid UX Design

## Decision

Use the canvas-first layout selected by the user: Figma-style visual review is
the primary interaction. Integrate CVAT-style issue processing and Label
Studio-style AI/human layer separation without turning the default screen into
a queue or a generic data-labeling product.

## Users and Goal

The operator reviews UI screenshot annotations produced by a pipeline and by a
multimodal AI pre-review. The operator must quickly decide whether to accept,
adjust, reject, or add visual elements. Human edits are the only benchmark
ground truth.

## Information Architecture

The desktop workbench has four persistent zones:

1. Header: current dataset, current screenshot, human-review progress, save
   state, previous/next navigation, and primary save action.
2. Left navigation: two mutually exclusive views.
   - Screenshot list: thumbnail, filename, review state, AI suggestion count,
     and unresolved issue count.
   - Object tree: current screenshot elements, type filter, visibility state,
     and element-state badges.
3. Central canvas: screenshot, pan/zoom, selected bbox, AI candidate layer,
   human annotation layer, and issue highlights. This is the dominant area.
4. Right inspector: tabs for Object, AI Pre-review, and Issues. Only the
   active tab is rendered as the primary task context.

A collapsed lower drawer exposes history and runtime detail. It stays closed
during normal annotation.

## Layer Model

The canvas distinguishes three independently toggleable layers. Color never
acts as the sole state indicator; labels and legend accompany every layer.

- Human layer: current editable annotation. Solid outline. Its saved content is
  benchmark ground truth.
- AI pre-review layer: `*.ai-review.json` proposals. Dashed purple outline;
  read-only until an operator chooses an action.
- Difference/issue layer: errors between immutable pipeline prediction and
  human result. Severity is rendered with icon, wording, and outline style.

AI pre-review files remain sidecars. They are never dataset entries, benchmark
inputs, or automatic replacements for the annotation file.

## Main Flows

### Screenshot Review

1. Select an unreviewed screenshot from the left list.
2. Central canvas fits the screenshot and shows human, AI, and issue layers.
3. Select an object, AI suggestion, or issue.
4. Right inspector automatically switches to the relevant tab.
5. Change the current human annotation, then explicitly save the human review.

### AI Proposal

1. Open AI Pre-review.
2. Select a proposal, which focuses its bbox and summary on the canvas.
3. Choose Accept, Edit then accept, or Reject.
4. Accept copies the proposed element to the editable human layer; it never
   changes the immutable AI suggestion source.
5. Rejected proposals remain recorded as rejected in the in-memory review
   session and become visible in the issue context after save.

### Issue Review

1. Open Issues, defaulted to unresolved/high severity.
2. Select a difference to focus the related annotation and prediction boxes.
3. Confirm, override, or resolve it after editing.
4. Use Next unresolved to traverse remaining issues without leaving canvas
   context.

## Chinese Content Rules

- All visible operator-facing content is Chinese, including element states,
  filters, empty states, help, confirmations, errors, buttons, and tooltips.
- Component types keep Chinese labels with short English code identifiers where
  precise classification matters, e.g. `输入框 input`.
- Technical details such as coordinates, element IDs, JSON, model names, and
  file paths use a monospaced visual treatment and are collapsed by default.
- Text inputs and IME composition suppress single-key shortcuts.

## Visual System

- Neutral charcoal canvas surround, warm white side panels, and a single blue
  action color. Red is reserved for destructive/error actions, not ordinary
  selection.
- Use an 8px rhythm, minimum 40px desktop action targets, and visible keyboard
  focus rings.
- Right inspector supports scanning: summary first, action row second, details
  last. Raw JSON is in a disclosure, never primary content.
- The mobile layout becomes a stacked inspector below the screenshot; desktop
  three-panel behavior remains the primary target.

## Scope

This implementation adds the hybrid layout, Chinese UI completion, AI proposal
read/accept/reject behavior, layer toggles, issue navigation, and an optional
lower history drawer. It does not add collaboration, arbitrary workflow-node
editing, model configuration, or automated model retraining.

## Validation

- Store/server tests cover reading and excluding AI sidecars and proposal
  actions without corrupting human annotations.
- Browser validation covers Chinese UI, panel switching, proposal focus,
  accept/reject, issue traversal, object edit, save status, desktop layout,
  and a narrow viewport fallback.
- Benchmark loading continues to admit only human-reviewed annotations.
