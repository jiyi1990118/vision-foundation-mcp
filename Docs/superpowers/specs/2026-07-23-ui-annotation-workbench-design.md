# UI Annotation Workbench Design

## Goal

Provide a local browser workbench for correcting draft UI benchmark annotations
without manually editing JSON or calculating pixel coordinates. The first
release supports the four-image App pilot set and writes files compatible with
`Docs/02-contracts/05-annotation-spec.md`.

## Scope

The workbench is a local-only Node HTTP server and a dependency-free browser
page. It reads source screenshots and draft annotation JSON files from a
user-selected dataset directory.

It supports:

- Previous/next image navigation and progress display.
- A scaled canvas showing the original image and type-colored element boxes.
- Selecting a draft element from the canvas or element list.
- Editing an element's type, text, render strategy, and bounding box.
- Deleting a false-positive draft element.
- Creating a missing element by dragging a box on the canvas.
- Filtering visible boxes by type and toggling overlays.
- Saving valid annotation JSON in place, with explicit draft-review status.

It does not initially edit relations, z-order, control metadata, or hierarchy.
Existing values are preserved when present. New elements have no relations.

## Data Flow

1. `ui-generate-annotations.ts` creates draft JSON and overlay PNGs.
2. The workbench reads paired image/JSON files from
   `benchmark/datasets/dev/app/`.
3. The browser obtains the current image, annotation list, and save status
   through a small local JSON API.
4. User edits are held in browser state and sent as the complete annotation
   document to the local server on Save.
5. The server validates the minimum annotation shape, creates a `.bak` backup
   on the first overwrite, then atomically replaces the JSON file.
6. A saved annotation removes the draft warning and adds
   `human-reviewed: local-workbench` to `warnings`.

## Browser Layout

- Top bar: dataset path, current image name, reviewed/total progress,
  previous/next buttons, save status.
- Left: responsive image canvas. Bounding boxes use existing type colors;
  selected elements have a heavier highlight. Dragging empty canvas creates a
  new element using image-space coordinates.
- Right: type filter, selected element editor, and searchable element list.
- Bottom controls: overlay toggle, delete selected, add element, save.

Coordinates remain in original image pixels. Canvas scaling is applied only at
render and pointer-event conversion boundaries.

## Server API

- `GET /api/dataset` returns ordered image/annotation entries and review state.
- `GET /api/annotation?file=<json>` returns one annotation document.
- `PUT /api/annotation?file=<json>` validates and atomically persists one
  annotation document.
- `GET /images/<filename>` serves the paired image.
- `GET /` serves the static workbench page.

The server rejects paths outside the configured dataset root.

## Pilot Queue

The workbench opens these four App screenshots first:

1. `微信图片_20260717191823_226_25.jpg` - address edit form.
2. `微信图片_20260717191828_229_25.jpg` - drawer/member content.
3. `微信图片_20260717191835_234_25.jpg` - cards/products.
4. `微信图片_20260717191851_241_25.jpg` - dense settings/profile list.

## Validation

- Server-side validation matches the loader's required metadata and element
  fields before persisting.
- Unit tests cover dataset scanning, path traversal rejection, validation,
  backup creation, and atomic save.
- Manual acceptance: correct all four pilot files in the browser, then run
  `npx tsx scripts/ui-benchmark.ts --annotations benchmark/datasets/dev/app`.

## Non-goals

- This is not a production annotation service, shared collaboration tool, or
  generic image editor.
- It does not claim that unreviewed pipeline-generated drafts are ground truth.
- It does not change runtime UI analysis or the legacy CV extractor.
