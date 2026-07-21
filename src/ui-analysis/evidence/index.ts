export type { EvidenceCandidate, EvidenceIR, EvidenceSource, isValidBBox } from './types.js';

import type { EvidenceCandidate, EvidenceIR } from './types.js';
import { isValidBBox } from './types.js';

export function buildEvidenceIR(candidates: EvidenceCandidate[]): EvidenceIR {
  const valid = candidates.filter((c) => isValidBBox(c.bbox));
  return { candidates: valid };
}
