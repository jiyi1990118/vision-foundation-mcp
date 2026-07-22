import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { EvidenceCandidate } from './types.js';
import type { BBox } from '../ir/types.js';
import type { ImageInput } from '../../types/domain.js';

export interface OnnxDetectorOptions {
  modelPath?: string;
  confidenceThreshold?: number;
  inputSize?: number;
  labels?: string[];
}

const DEFAULT_MODEL_PATH = join(homedir(), '.vision-mcp', 'models', 'ui-detector', 'model.onnx');
const DEFAULT_CONFIDENCE = 0.4;
const DEFAULT_INPUT_SIZE = 640;
const DEFAULT_LABELS = [
  'button', 'input', 'textarea', 'card', 'checkbox', 'radio',
  'switch', 'select', 'icon', 'image', 'logo', 'avatar',
  'tab', 'badge', 'list-item', 'banner', 'toolbar', 'dialog',
];

export class OnnxDetectorAdapter {
  readonly name = 'onnx-ui-detector';
  readonly version = '1.0.0';

  private readonly options: Required<OnnxDetectorOptions>;
  private _loaded = false;
  private _session: unknown = null;

  constructor(options?: OnnxDetectorOptions) {
    this.options = {
      modelPath: options?.modelPath ?? DEFAULT_MODEL_PATH,
      confidenceThreshold: options?.confidenceThreshold ?? DEFAULT_CONFIDENCE,
      inputSize: options?.inputSize ?? DEFAULT_INPUT_SIZE,
      labels: options?.labels ?? DEFAULT_LABELS,
    };
  }

  get isLoaded(): boolean {
    return this._loaded;
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.options.modelPath)) {
      this._loaded = false;
      return;
    }
    try {
      const ort = await import('onnxruntime-node');
      this._session = await ort.InferenceSession.create(this.options.modelPath);
      this._loaded = true;
    } catch {
      this._loaded = false;
      this._session = null;
    }
  }

  async detect(_image: ImageInput): Promise<EvidenceCandidate[]> {
    if (!this._loaded || this._session === null) return [];
    // Real inference (preprocess -> session.run -> parseOutput) is wired once a
    // model file is available; until then a loaded-but-unimplemented session
    // degrades to no candidates rather than throwing.
    return [];
  }

  /**
   * Parse raw YOLO-style output into EvidenceCandidate[].
   * Row layout: [cx_norm, cy_norm, w_norm, h_norm, class_0_score, ..., class_{n-1}_score]
   * where each value is normalized to [0,1] relative to the input image.
   */
  parseOutput(raw: Float32Array, labels: string[], imgWidth: number, imgHeight: number): EvidenceCandidate[] {
    const numClasses = labels.length;
    const rowSize = 4 + numClasses;
    const numDetections = Math.floor(raw.length / rowSize);
    const candidates: EvidenceCandidate[] = [];
    let idCounter = 0;

    for (let i = 0; i < numDetections; i++) {
      const offset = i * rowSize;
      const cxNorm = raw[offset]!;
      const cyNorm = raw[offset + 1]!;
      const wNorm = raw[offset + 2]!;
      const hNorm = raw[offset + 3]!;

      let bestClass = 0;
      let bestScore = 0;
      for (let c = 0; c < numClasses; c++) {
        const score = raw[offset + 4 + c]!;
        if (score > bestScore) {
          bestScore = score;
          bestClass = c;
        }
      }

      if (bestScore < this.options.confidenceThreshold) continue;

      const label = labels[bestClass] ?? 'unknown';
      const bbox: BBox = {
        x: (cxNorm - wNorm / 2) * imgWidth,
        y: (cyNorm - hNorm / 2) * imgHeight,
        w: wNorm * imgWidth,
        h: hNorm * imgHeight,
      };

      candidates.push({
        id: `onnx-${++idCounter}`,
        type: label,
        bbox,
        score: bestScore,
        sources: ['ui-detector'],
      });
    }

    return candidates;
  }
}
