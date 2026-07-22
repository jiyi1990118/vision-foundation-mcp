/**
 * ControlAppearanceAnalyzer - pure pixel-based detection of interactive
 * toggle controls (checkbox / radio / switch) from a decoded image buffer.
 *
 * Replaces the OCR-keyword-based control-state inference that previously
 * lived in type-enricher.ts. Given a decoded image and a bbox, this reads
 * the raw pixels to determine:
 *   - family  : checkbox | radio | switch
 *   - shape   : square | circle | pill | custom
 *   - state   : checked | unchecked | indeterminate | disabled
 *   - indicator (optional): check | dot | dash | asset
 *   - fillColor (optional): dominant fill hex (#rrggbb)
 *
 * Heuristics (all pure pixel sampling, no model, no IO):
 *   - Size guard: controls are 8-48px, aspect ratio <= 3.0 (switches can be wide)
 *   - Shape: sample the 4 bbox corners; background-colored corners => rounded
 *     (circle when ~square, pill when wide), else square.
 *   - Disabled: low saturation + mid luminance across the sampled region.
 *   - Checkbox/radio checked: saturated colored fill in the center region.
 *   - Radio checked: dot in center (same colored-fill signal as checkbox).
 *   - Switch checked: bright knob on the right half OR saturated (green/blue)
 *     background color.
 *   - Indeterminate: colored only in a horizontal mid stripe (dash).
 *
 * @see src/ui-analysis/ir/types.ts  (DecodedImage, BBox contracts)
 */
import type { BBox, DecodedImage } from '../ir/types.js';

export interface ControlAppearance {
  family: 'checkbox' | 'radio' | 'switch';
  state: 'checked' | 'unchecked' | 'indeterminate' | 'disabled';
  shape: 'square' | 'circle' | 'pill' | 'custom';
  indicator?: 'check' | 'dot' | 'dash' | 'asset';
  fillColor?: string;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

const CONTROL_MAX_W = 48;
const CONTROL_MAX_H = 48;
const CONTROL_MAX_ASPECT = 3.0; // switch can be wider
const CONTROL_MIN = 8;
const SATURATION_DISABLED = 0.1;
const LUMINANCE_DISABLED_MIN = 120;
const LUMINANCE_DISABLED_MAX = 220;
const CORNER_FILL_RATIO_CIRCLE = 0.15;
const SATURATION_THRESHOLD = 0.15;
const DISABLED_RATIO = 0.5;
const PILL_ASPECT_MIN = 1.5;
const COLORED_FILL_MIN = 0.1;
const STRIPE_HEIGHT_RATIO = 0.15;
const BRIGHT_LUMINANCE = 200;
const CORNER_BG_LUMINANCE = 200;

function readPixel(img: DecodedImage, x: number, y: number): RGB {
  const idx = (y * img.width + x) * img.stride;
  return { r: img.data[idx] ?? 0, g: img.data[idx + 1] ?? 0, b: img.data[idx + 2] ?? 0 };
}

function luminance(rgb: RGB): number {
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
}

function saturation(rgb: RGB): number {
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  return max === 0 ? 0 : (max - min) / max;
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => v.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function isDisabledColor(rgb: RGB): boolean {
  const lum = luminance(rgb);
  return lum >= LUMINANCE_DISABLED_MIN && lum <= LUMINANCE_DISABLED_MAX && saturation(rgb) < SATURATION_DISABLED;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  h: number;
}

function bboxRect(img: DecodedImage, bbox: BBox): Rect {
  const x0 = Math.max(0, Math.floor(bbox.x));
  const y0 = Math.max(0, Math.floor(bbox.y));
  const x1 = Math.min(img.width, Math.ceil(bbox.x + bbox.w));
  const y1 = Math.min(img.height, Math.ceil(bbox.y + bbox.h));
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

function detectShape(img: DecodedImage, bbox: BBox): 'square' | 'circle' | 'pill' {
  const { x0, y0, x1, y1, w, h } = bboxRect(img, bbox);
  if (w <= 0 || h <= 0) return 'square';

  const aspect = w / h;

  // Wide controls are switches (pill shape). Aspect ratio is the strongest
  // signal and works even when the bbox is fully filled with no rounded
  // corner cutout to sample (synthetic / flat-rendered switches).
  if (aspect > PILL_ASPECT_MIN) return 'pill';

  // ~square: distinguish rounded (circle/radio) from square (checkbox) by
  // sampling the 4 bbox corners. Rounded controls leave background-colored
  // (light) pixels in the corners.
  const cornerSize = Math.max(2, Math.floor(Math.min(w, h) * 0.15));
  let cornerBgPixels = 0;
  let cornerTotal = 0;

  const corners: ReadonlyArray<readonly [number, number]> = [
    [x0, y0],
    [x1 - 1, y0],
    [x0, y1 - 1],
    [x1 - 1, y1 - 1],
  ];

  for (const [cx, cy] of corners) {
    for (let dy = 0; dy < cornerSize; dy++) {
      for (let dx = 0; dx < cornerSize; dx++) {
        const px = readPixel(img, cx + dx, cy + dy);
        if (luminance(px) > CORNER_BG_LUMINANCE) cornerBgPixels++;
        cornerTotal++;
      }
    }
  }

  const cornerBgRatio = cornerTotal > 0 ? cornerBgPixels / cornerTotal : 0;

  // Many background corner pixels => rounded shape. Wide aspects already
  // returned 'pill' above, so here a rounded ~square is a circle (radio).
  if (cornerBgRatio > CORNER_FILL_RATIO_CIRCLE) {
    return 'circle';
  }
  return 'square';
}

function dominantColored(img: DecodedImage, rect: Rect): { ratio: number; color: RGB | null } {
  const { x0, y0, x1, y1 } = rect;
  let coloredPixels = 0;
  let totalPixels = 0;
  const colorBuckets = new Map<string, number>();

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const px = readPixel(img, x, y);
      totalPixels++;
      if (saturation(px) > SATURATION_THRESHOLD) {
        coloredPixels++;
        const key = `${px.r >> 4},${px.g >> 4},${px.b >> 4}`;
        colorBuckets.set(key, (colorBuckets.get(key) ?? 0) + 1);
      }
    }
  }

  const ratio = totalPixels > 0 ? coloredPixels / totalPixels : 0;

  let dominantColor: RGB | null = null;
  let maxCount = 0;
  for (const [key, count] of colorBuckets) {
    if (count > maxCount) {
      maxCount = count;
      const parts = key.split(',');
      dominantColor = {
        r: parseInt(parts[0] ?? '0', 10) * 16,
        g: parseInt(parts[1] ?? '0', 10) * 16,
        b: parseInt(parts[2] ?? '0', 10) * 16,
      };
    }
  }

  return { ratio, color: dominantColor };
}

function detectFillState(
  img: DecodedImage,
  bbox: BBox,
  shape: 'square' | 'circle' | 'pill',
): { state: 'checked' | 'unchecked' | 'indeterminate'; fillColor?: string } {
  const { x0, y0, x1, y1, w, h } = bboxRect(img, bbox);
  if (w <= 0 || h <= 0) return { state: 'unchecked' };

  // Sample the center region (inset 25% each side) to avoid border noise.
  const insetX = Math.floor(w * 0.25);
  const insetY = Math.floor(h * 0.25);
  const center: Rect = { x0: x0 + insetX, y0: y0 + insetY, x1: x1 - insetX, y1: y1 - insetY, w, h };

  const { ratio, color } = dominantColored(img, center);

  if (ratio < COLORED_FILL_MIN) {
    // No colored fill: unchecked (also covers switch-off via the switch path).
    return { state: 'unchecked' };
  }

  // Indeterminate: colored only in a horizontal mid stripe (dash), with no
  // colored pixels outside the stripe. Checkbox-only signal.
  if (shape === 'square' && color !== null) {
    const midY = Math.floor((center.y0 + center.y1) / 2);
    const stripeH = Math.max(2, Math.floor(h * STRIPE_HEIGHT_RATIO));
    let stripeColored = 0;
    let outsideColored = 0;
    for (let y = center.y0; y < center.y1; y++) {
      for (let x = center.x0; x < center.x1; x++) {
        const px = readPixel(img, x, y);
        if (saturation(px) > SATURATION_THRESHOLD) {
          if (Math.abs(y - midY) < stripeH) stripeColored++;
          else outsideColored++;
        }
      }
    }
    if (stripeColored > 0 && outsideColored === 0) {
      return { state: 'indeterminate', fillColor: rgbToHex(color.r, color.g, color.b) };
    }
  }

  return {
    state: 'checked',
    ...(color !== null ? { fillColor: rgbToHex(color.r, color.g, color.b) } : {}),
  };
}

function detectSwitchState(img: DecodedImage, bbox: BBox): { state: 'checked' | 'unchecked'; fillColor?: string } {
  const { x0, y0, x1, y1, w, h } = bboxRect(img, bbox);
  if (w <= 0 || h <= 0) return { state: 'unchecked' };

  // A switch is ON when the bright knob sits on the right half, or when the
  // background itself is saturated (green/blue = on).
  const midX = x0 + Math.floor(w / 2);
  let leftBright = 0;
  let rightBright = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < midX; x++) {
      if (luminance(readPixel(img, x, y)) > BRIGHT_LUMINANCE) leftBright++;
    }
    for (let x = midX; x < x1; x++) {
      if (luminance(readPixel(img, x, y)) > BRIGHT_LUMINANCE) rightBright++;
    }
  }

  const bgPx = readPixel(img, x0 + Math.floor(w * 0.1), y0 + Math.floor(h * 0.5));
  const bgIsColored = saturation(bgPx) > SATURATION_THRESHOLD;

  if (rightBright > leftBright || bgIsColored) {
    return { state: 'checked', fillColor: rgbToHex(bgPx.r, bgPx.g, bgPx.b) };
  }
  return { state: 'unchecked' };
}

export function analyzeControlAppearance(img: DecodedImage, bbox: BBox): ControlAppearance | null {
  const w = bbox.w;
  const h = bbox.h;

  // Size guard: controls are small UI widgets.
  if (w > CONTROL_MAX_W || h > CONTROL_MAX_H) return null;
  if (w < CONTROL_MIN || h < CONTROL_MIN) return null;

  // Aspect guard: switches can be wide, checkboxes/radios are ~square.
  const aspect = w / h;
  if (aspect > CONTROL_MAX_ASPECT) return null;

  const shape = detectShape(img, bbox);

  // Disabled: sample the whole region (step 2 for speed); if most sampled
  // pixels are grayscale mid-luminance, treat as disabled.
  const { x0, y0, x1, y1 } = bboxRect(img, bbox);
  let disabledPixels = 0;
  let totalSampled = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      if (isDisabledColor(readPixel(img, x, y))) disabledPixels++;
      totalSampled++;
    }
  }
  const isDisabled = totalSampled > 0 && disabledPixels / totalSampled > DISABLED_RATIO;

  if (isDisabled) {
    const family: ControlAppearance['family'] =
      shape === 'pill' ? 'switch' : shape === 'circle' ? 'radio' : 'checkbox';
    return { family, state: 'disabled', shape };
  }

  // Family from shape.
  if (shape === 'pill') {
    const { state, fillColor } = detectSwitchState(img, bbox);
    return { family: 'switch', state, shape: 'pill', ...(fillColor ? { fillColor } : {}) };
  }

  const family: 'checkbox' | 'radio' = shape === 'circle' ? 'radio' : 'checkbox';
  const { state, fillColor } = detectFillState(img, bbox, shape);
  const indicator =
    family === 'radio' && state === 'checked' ? 'dot' : state === 'checked' ? 'check' : undefined;

  return {
    family,
    state,
    shape,
    ...(indicator ? { indicator } : {}),
    ...(fillColor ? { fillColor } : {}),
  };
}
