import type { EvidenceCandidate } from './types.js';
import type { BBox } from '../ir/types.js';
import type { ImageInput } from '../../types/domain.js';

export interface OmniParserOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export interface OmniParsedItem {
  content: string;
  bbox: number[]; // normalized [x1, y1, x2, y2] in [0,1]
  interactivity: boolean;
}

export interface OmniResponse {
  parsed_content_list?: OmniParsedItem[];
}

/** Optional image dimensions passed to {@link OmniParserAdapter.detect}. */
export interface ImageDimensions {
  width: number;
  height: number;
}

const DEFAULT_BASE_URL = 'http://localhost:8000';
const DEFAULT_TIMEOUT = 10000;
const DEFAULT_HEALTH_TIMEOUT = 2000;
const FALLBACK_WIDTH = 375;
const FALLBACK_HEIGHT = 812;

const BUTTON_KEYWORDS = /button|btn|submit|cancel|confirm|save|delete|edit|search|login|click|tap|send|next|prev|back|close|open/i;

/**
 * Classify an OmniParser content string into an evidence `type`.
 *
 * Ordering is intentional: an explicit "icon" signal wins over button
 * keywords (e.g. "search icon" is an icon, not a button) so that labeled
 * icons are not misclassified as buttons purely because their caption
 * contains a verb like "search".
 */
function classifyContent(content: string, interactive: boolean): string {
  const text = content.toLowerCase().trim();
  if (text.includes('icon') || text.includes('图标')) return 'icon';
  if (interactive && BUTTON_KEYWORDS.test(text)) return 'button';
  if (interactive) return 'button';
  return 'text';
}

export function parseOmniResponse(
  response: OmniResponse,
  imgWidth: number,
  imgHeight: number,
): EvidenceCandidate[] {
  const items = response.parsed_content_list;
  if (items === undefined || !Array.isArray(items)) return [];

  const candidates: EvidenceCandidate[] = [];
  let idCounter = 0;

  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const bbox = item.bbox;
    if (!Array.isArray(bbox) || bbox.length < 4) continue;

    const x1n = bbox[0];
    const y1n = bbox[1];
    const x2n = bbox[2];
    const y2n = bbox[3];
    if (
      x1n === undefined ||
      y1n === undefined ||
      x2n === undefined ||
      y2n === undefined
    ) {
      continue;
    }

    const type = classifyContent(item.content, item.interactivity);
    const bboxPixel: BBox = {
      x: x1n * imgWidth,
      y: y1n * imgHeight,
      w: (x2n - x1n) * imgWidth,
      h: (y2n - y1n) * imgHeight,
    };

    if (bboxPixel.w <= 0 || bboxPixel.h <= 0) continue;

    const candidate: EvidenceCandidate = {
      id: `omni-${++idCounter}`,
      type,
      bbox: bboxPixel,
      score: 1.0,
      sources: ['omniparser'],
      text: item.content,
    };
    candidates.push(candidate);
  }

  return candidates;
}

export class OmniParserAdapter {
  readonly name = 'omniparser';
  readonly version = '1.0.0';

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private _available: boolean | null = null;

  constructor(options?: OmniParserOptions) {
    this.baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT;
  }

  get isAvailable(): boolean {
    return this._available === true;
  }

  async checkAvailability(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_HEALTH_TIMEOUT);
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      this._available = res.ok;
      return this._available;
    } catch {
      this._available = false;
      return false;
    }
  }

  /**
   * Detect UI elements via the OmniParser sidecar.
   *
   * Degrades gracefully to `[]` when the sidecar is unreachable or returns
   * a non-OK response. OmniParser returns normalized coordinates; pass
   * `dimensions` (pixel width/height of the source image) so the result can
   * be converted to pixel space. When omitted, a fallback mobile viewport
   * size is used - callers that have real image metadata should pass it.
   */
  async detect(
    image: ImageInput,
    dimensions?: ImageDimensions,
  ): Promise<EvidenceCandidate[]> {
    if (this._available === null) {
      await this.checkAvailability();
    }
    if (!this._available) return [];

    try {
      const base64 = image.buffer.toString('base64');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(`${this.baseUrl}/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base64_image: base64,
          image_mimetype: image.mimeType,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) return [];
      const data = (await res.json()) as OmniResponse;
      const imgWidth = dimensions?.width ?? FALLBACK_WIDTH;
      const imgHeight = dimensions?.height ?? FALLBACK_HEIGHT;
      return parseOmniResponse(data, imgWidth, imgHeight);
    } catch {
      return [];
    }
  }
}
