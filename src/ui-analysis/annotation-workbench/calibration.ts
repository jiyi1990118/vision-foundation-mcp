/**
 * Phase B4: Structural Rule Calibration.
 *
 * Measures precision of each registered structure rule against human review
 * decisions stored in ReviewSession. Rules with no reviewed findings or
 * precision below threshold are marked advisory-only.
 *
 * @see Docs/superpowers/specs/2026-07-24-annotation-mainline-supplement.md
 */
import type { AnnotationFile } from '../benchmark/annotation-loader.js';
import { analyzeAnnotationStructure, findingSignature, findingSubjectId, STRUCTURE_RULES } from './tree.js';
import { reviewStatusFor, type ReviewSession } from './review-types.js';

export interface RuleCalibrationCounts {
  code: string;
  version: number;
  raised: number;
  confirmed: number;
  overridden: number;
  suppressed: number;
  rejected: number;
  unreviewed: number;
}

export interface RuleCalibrationResult {
  code: string;
  version: number;
  calibrated: boolean;
  precision: number;
  reviewed: number;
  raised: number;
  advisoryOnly: boolean;
}

export interface AggregateOptions {
  precisionThreshold?: number;
}

const DEFAULT_PRECISION_THRESHOLD = 0.5;

/**
 * Run all registered structure rules on an annotation and cross-reference
 * findings against the review session to produce per-rule counts.
 *
 * A finding is "reviewed" when the session contains a non-stale action whose
 * signature matches the current finding signature. Confirmed and overridden
 * actions count as true positives; suppressed and rejected count as false
 * positives.
 */
export function calibrateStructureRules(
  annotation: AnnotationFile,
  session: ReviewSession,
): RuleCalibrationCounts[] {
  const findings = analyzeAnnotationStructure(annotation);

  const counts = new Map<string, RuleCalibrationCounts>();
  for (const rule of STRUCTURE_RULES) {
    counts.set(rule.code, {
      code: rule.code,
      version: rule.version,
      raised: 0,
      confirmed: 0,
      overridden: 0,
      suppressed: 0,
      rejected: 0,
      unreviewed: 0,
    });
  }

  for (const finding of findings) {
    const entry = counts.get(finding.code);
    if (!entry) continue;
    entry.raised += 1;

    const subjectId = findingSubjectId(finding);
    const signature = findingSignature(finding);
    const status = reviewStatusFor(session, 'structure-finding', subjectId, signature);

    if (status === 'confirmed') {
      entry.confirmed += 1;
    } else if (status === 'overridden') {
      entry.overridden += 1;
    } else if (status === 'suppressed') {
      entry.suppressed += 1;
    } else if (status === 'auto') {
      entry.rejected += 1;
    } else {
      entry.unreviewed += 1;
    }
  }

  return [...counts.values()];
}

/**
 * Aggregate per-image calibration counts into per-rule precision and
 * advisory-only flags.
 */
export function aggregateCalibration(
  perImage: RuleCalibrationCounts[],
  options: AggregateOptions = {},
): Record<string, RuleCalibrationResult> {
  const threshold = options.precisionThreshold ?? DEFAULT_PRECISION_THRESHOLD;
  const byCode = new Map<string, RuleCalibrationCounts>();

  for (const entry of perImage) {
    const existing = byCode.get(entry.code);
    if (!existing) {
      byCode.set(entry.code, { ...entry });
    } else {
      existing.raised += entry.raised;
      existing.confirmed += entry.confirmed;
      existing.overridden += entry.overridden;
      existing.suppressed += entry.suppressed;
      existing.rejected += entry.rejected;
      existing.unreviewed += entry.unreviewed;
    }
  }

  const result: Record<string, RuleCalibrationResult> = {};
  for (const entry of byCode.values()) {
    const reviewed = entry.confirmed + entry.overridden + entry.suppressed + entry.rejected;
    const truePositives = entry.confirmed + entry.overridden;
    const calibrated = reviewed > 0;
    const precision = reviewed > 0 ? truePositives / reviewed : 0;
    result[entry.code] = {
      code: entry.code,
      version: entry.version,
      calibrated,
      precision,
      reviewed,
      raised: entry.raised,
      advisoryOnly: !calibrated || precision < threshold,
    };
  }
  return result;
}
