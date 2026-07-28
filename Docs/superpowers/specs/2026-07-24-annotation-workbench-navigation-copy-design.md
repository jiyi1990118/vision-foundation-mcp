# Annotation Workbench Navigation and Copy Design

## Purpose

Improve screenshot navigation density and make repeated annotation creation
faster without weakening the human-review and ground-truth boundaries.

## Layout

Use the selected balanced layout:

- Left screenshot panel: 220px wide.
- Right inspector panel: 300px wide.
- Center canvas receives the reclaimed width.
- Screenshot entries include a fixed two-digit ordinal (`01`, `02`, ...), the
  existing filename, review status, and AI proposal count.
- Reduce left-panel content padding slightly while retaining readable hit areas.

The list ordinal is presentation-only; it does not change annotation paths,
image names, or dataset ordering.

## Internal Clipboard

Copy and paste operate only inside the workbench's current browser session.

- `Ctrl/Cmd+C` copies the selected annotation element to an internal clipboard.
- `Ctrl/Cmd+V` creates a new element on the current screenshot from that
  clipboard.
- The inspector exposes equivalent `复制元素` and `粘贴元素` buttons. Paste is
  disabled when the internal clipboard is empty.
- Keyboard handlers do not intercept shortcuts while focus is inside an input,
  textarea, or select, preserving normal browser editing behavior.
- Copied data includes the element type, text, render mode, bbox, and relevant
  persisted fields. A pasted element gets a new ID and is not added to an
  existing containment relation automatically.
- The first paste offsets the bbox by 12px right and down. Consecutive pastes
  add another 12px each, then clamp to image bounds.
- Copy does not modify the annotation. Paste is a normal annotation edit, enters
  undo/redo history, and is persisted only through `保存人工审核`.

## Boundaries

- Clipboard data is not written to system clipboard, disk, review session, or
  sidecars.
- Clipboard contents cannot cross a page reload and should not be used to infer
  semantic relations in a different screenshot.
- No automatic containment or benchmark eligibility changes occur from paste.

## Verification

- Unit tests cover ordered screenshot labels, copying without mutation, paste
  ID uniqueness, 12px cumulative offset, bounds clamping, undo/redo inclusion,
  disabled paste without clipboard, and shortcut guards for editable controls.
- Browser checks confirm left/right panel widths and both inspector buttons.
- Run `pnpm typecheck`, `pnpm lint`, `pnpm build`, focused workbench tests, and
  `pnpm test:unit`.
