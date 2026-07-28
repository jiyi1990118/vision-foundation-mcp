# Benchmark Dataset

Ground-truth annotated UI screenshots for the reconstruction benchmark.

## Structure

```
datasets/
  dev/                  # Development set (60 images target: 20 app/web/desktop each)
    app/                # Mobile app screenshots
      screenshot_001.png
      screenshot_001.json   # Annotation per Docs/02-contracts/05-annotation-spec.md
    web/                # Web page screenshots
    desktop/            # Desktop application screenshots
```

## Annotation Format

See [`Docs/02-contracts/05-annotation-spec.md`](../../Docs/02-contracts/05-annotation-spec.md).

Each `.json` file must have the same basename as its corresponding image.

## Usage

```bash
# Coverage mode (no annotations needed)
npx tsx scripts/ui-benchmark.ts ~/Desktop/UI

# Annotated mode
npx tsx scripts/ui-benchmark.ts --annotations benchmark/datasets/dev

# Review or correct draft annotations in the local browser workbench
pnpm ui:annotate -- benchmark/datasets/dev/app --port 4317
```

Open `http://127.0.0.1:4317`. Select an element to edit its type, text,
render strategy, or original-image bbox; drag on empty image space to add a
missing element; then select Save. The first save preserves the generated
draft as `<annotation>.json.bak` and marks the live annotation as reviewed.

The initial pilot queue is `226` (address form), `229` (drawer/member view),
`234` (product cards), and `241` (dense settings/profile). Do not use a JSON
that still contains `pipeline-generated draft annotation - not human verified`
as benchmark ground truth.

## Status

Phase A: 16 App screenshots and pipeline-generated drafts are available under
`dev/app/`. They require manual review through the local workbench before they
are valid ground truth. The development-set target remains 60 reviewed images
(20 each for App/Web/Desktop).
