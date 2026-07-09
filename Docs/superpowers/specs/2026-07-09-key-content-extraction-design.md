# Key Content Extraction Design

## Goal

Improve dense UI screenshot analysis for requests that ask for key content in a marked or described region. The feature should handle red boxes, highlighted/circled areas, described positions such as "right price column", and dense UI tables where full-image OCR misses small units or symbols.

The first concrete regression target is the TAPD screenshot red dashed box. The correct extraction is a two-column price table with columns `默认基础价-半份（元）` and `默认附加价-半份（元）`; each data row contains `0.00 ¥` in both columns. The extractor must not include the adjacent outside header `默认附加价(元)`.

## Scope

Implement a dedicated key-content extraction layer after OCR and annotation detection, before result composition.

Covered scenarios:

- Annotated regions: red boxes, dashed red boxes, highlighted boxes, circled regions when detected by annotation logic.
- User-described regions: `options.target` and natural language intent containing region hints such as right, left, top, bottom, table, popup, dialog, column, row, red box, highlighted area.
- Dense UI tables: group OCR items into rows and columns, merge wrapped headers, merge units, and normalize currency symbols in strong contexts.
- Region OCR enhancement: crop and upscale target regions, run a second OCR pass, and map local OCR coordinates back to the original image.

Out of scope for this pass:

- General visual object detection unrelated to UI/content extraction.
- Full arbitrary natural-language spatial reasoning beyond the supported target hints.
- Replacing the existing OCR provider or VLM providers.

## Architecture

Add a new module:

```text
src/core/key-content-extractor.ts
```

The module exposes:

```ts
extractKeyContent(input: KeyContentInput): Promise<KeyContentExtraction | undefined>
```

Input includes:

```ts
interface KeyContentInput {
  image: ImageInput;
  target?: TargetQuery;
  intent?: string;
  annotations?: ImageAnnotations;
  ocrData?: unknown;
  ocrProvider?: VisionProvider;
}
```

Output shape:

```ts
interface KeyContentExtraction {
  query: TargetQuery | undefined;
  matchedRegion: {
    type: 'redBox' | 'highlightBox' | 'layoutRegion';
    box: string;
    confidence: number;
  };
  textLines: string[];
  table?: {
    columns: string[];
    rows: string[][];
  };
  fields?: Array<{ label: string; value: string }>;
  summary: string;
  warnings: string[];
}
```

`vision-analyze.ts` calls `extractKeyContent()` after `detectAnnotations()` and passes the result to `composeResult()`. `composeResult()` attaches it as `result.targetExtraction` and uses its summary for annotation-specific summary text when available.

## Data Flow

1. Run planned skills as today.
2. If OCR succeeded, run annotation detection as today.
3. Decide whether key-content extraction should run.
4. Resolve the best target region.
5. Build region OCR items from full-image OCR.
6. If an OCR provider is available, crop the matched region, upscale it, run local OCR, and map local positions back to image coordinates.
7. Merge full-image OCR and local OCR, preferring local OCR for small text inside the target region.
8. Structure the region content into lines, optional table, optional fields, and summary.
9. Compose final `VisionResult`.

## Activation Rules

Run key-content extraction when any of these is true:

- `options.target` is provided.
- Intent contains terms such as `红框`, `虚线框`, `框中`, `圈出`, `标注`, `高亮`, `关键内容`, `提取区域`, `右侧`, `左侧`, `弹窗`, `表格`, `列`, `行`.
- An annotation is detected and the requested skills include OCR or summary.

Do not run it for simple classification-only requests.

## Target Resolution

Target resolution ranks candidate regions.

Candidate sources:

- Annotation boxes from `detectAnnotations()`.
- Layout-derived regions from OCR item clusters.
- Table-like dense regions from repeated x/y text alignment.

Ranking signals:

- Color match: `red` or `红色` prefers red annotation boxes.
- Position match: right, left, top, bottom, center.
- Description match: table, popup, dialog, column, row, price, amount, field.
- Area and text density.

For the TAPD case, the red dashed annotation box remains the selected region.

## Region OCR Enhancement

For selected regions:

- Crop the region with a small safe margin.
- Prefer inner crop for annotation boxes to avoid reading outside adjacent headers.
- Upscale 3x or 4x using `sharp`.
- Normalize contrast/grayscale for small text when beneficial.
- Run the dedicated OCR provider against the crop.
- Map local OCR boxes back to original image coordinates.
- Merge local OCR with full-image OCR by text box overlap.

Local OCR is allowed to add small text missed by full-image OCR, such as `(元)` in wrapped headers. Local OCR does not automatically override high-confidence full-image OCR outside the selected region.

## Structure Extraction

The extractor converts OCR items in the region into structured content.

Line grouping:

- Sort by y center, then x center.
- Cluster items into lines using median item height.
- Preserve duplicate values such as repeated `0.00`.

Table grouping:

- Detect repeated x columns across multiple rows.
- Cluster by x center into columns.
- Cluster by y center into rows.
- Treat top text rows as headers when they contain label/unit text and lower rows contain repeated values.

Header merging:

- Merge wrapped unit rows into the previous header row.
- Normalize ASCII and Chinese parentheses to Chinese output where appropriate: `(元)` -> `（元）`.
- For the TAPD case, merge:
  - `默认基础价-半份` + `(元)` -> `默认基础价-半份（元）`
  - `默认附加价-半份` + `(元)` -> `默认附加价-半份（元）`

Currency normalization:

- Merge amount values with adjacent currency symbols.
- In strong money context, normalize likely OCR confusions near `0.00`, such as `夫` -> `¥`.
- Only apply this when the candidate symbol is horizontally adjacent to a numeric amount and aligned on the same row.

## Error Handling

If local OCR fails:

- Keep extraction based on full-image OCR.
- Add a warning: `region OCR failed; using full-image OCR only`.

If table reconstruction is uncertain:

- Return `textLines` and summary.
- Omit `table` or include a warning describing the uncertainty.

If no target region can be resolved:

- Return `undefined`; the existing normal result path remains unchanged.

## Tests

Add focused tests for:

- Adjacent outside text touching a red box edge is excluded.
- Wrapped two-column headers merge with `(元)`.
- `0.00` plus currency symbol becomes `0.00 ¥`.
- OCR confusion `夫` becomes `¥` only near numeric money values.
- Two-column region table reconstructs columns and rows.
- `options.target` and intent trigger key-content extraction.
- TAPD smoke using the local screenshot when available, guarded so CI does not depend on local files.

Existing tests must continue to pass:

- `pnpm typecheck`
- `pnpm build`
- `pnpm test:unit`

## Success Criteria

For the TAPD screenshot target extraction:

- `result.targetExtraction.table.columns` equals `默认基础价-半份（元）` and `默认附加价-半份（元）`.
- `result.targetExtraction.table.rows` contains at least six rows.
- Each row has two cells, both `0.00 ¥`.
- `默认附加价(元)` is not included in target text lines, table columns, or summary.
- The existing OCR text and general UI summary remain available for broader page analysis.
