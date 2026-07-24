const PASTE_OFFSET = 12;

function clampBox(box, imageSize) {
  const w = Math.max(1, Math.min(box.w, imageSize.width));
  const h = Math.max(1, Math.min(box.h, imageSize.height));
  const x = Math.max(0, Math.min(box.x, imageSize.width - w));
  const y = Math.max(0, Math.min(box.y, imageSize.height - h));
  return { x, y, w, h };
}

export function createPastedElement(source, pasteCount, imageSize) {
  const offset = PASTE_OFFSET * pasteCount;
  const bbox = clampBox({
    x: source.bbox.x + offset,
    y: source.bbox.y + offset,
    w: source.bbox.w,
    h: source.bbox.h,
  }, imageSize);
  const pasted = {
    id: `copy-${crypto.randomUUID()}`,
    type: source.type,
    bbox,
    render: source.render,
  };
  if (source.text !== undefined) pasted.text = source.text;
  return pasted;
}
