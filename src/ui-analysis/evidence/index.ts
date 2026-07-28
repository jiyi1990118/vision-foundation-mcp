export type { EvidenceCandidate, EvidenceIR, EvidenceSource, SourceVote } from './types.js';
export { isValidBBox } from './types.js';

import type { EvidenceCandidate, EvidenceIR } from './types.js';
import { isValidBBox } from './types.js';

export function buildEvidenceIR(candidates: EvidenceCandidate[]): EvidenceIR {
  const valid = candidates.filter((c) => isValidBBox(c.bbox));
  return { candidates: valid };
}

export { fuseEvidence } from './fusion-engine.js';
export type { FusionOptions } from './fusion-engine.js';
export { DetectorHub } from './detector-hub.js';
export type { DetectorFn, DetectorHubOptions, DetectorResult } from './detector-hub.js';
export { OnnxDetectorAdapter } from './onnx-detector-adapter.js';
export type { OnnxDetectorOptions } from './onnx-detector-adapter.js';
export { OmniParserAdapter, parseOmniResponse } from './omniparser-adapter.js';
export type { OmniParserOptions, OmniParsedItem, OmniResponse } from './omniparser-adapter.js';
