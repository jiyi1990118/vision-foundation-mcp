/**
 * Phase C3: Data Splitting.
 *
 * Splits the reviewed dataset into train/validation/test by screenshot family
 * (not random image) so near-duplicate screenshots never span multiple splits.
 *
 * @see Docs/superpowers/specs/2026-07-24-annotation-mainline-supplement.md
 */
import type { SampleManifest } from './manifest.js';

export type SplitName = 'train' | 'validation' | 'test';
export type SplitAssignment = Record<string, SplitName>;

export interface SplitRatios {
  train: number;
  validation: number;
  test: number;
}

export interface SplitOptions {
  seed?: number;
  ratios?: SplitRatios;
  familyKey?: (manifest: SampleManifest) => string;
}

export interface LeakageResult {
  ok: boolean;
  leakedFamilies: string[];
}

const DEFAULT_RATIOS: SplitRatios = { train: 0.7, validation: 0.15, test: 0.15 };

/**
 * Default family key: extracts a timestamp prefix (down to the minute) from
 * the filename. Screenshots captured within the same minute are treated as
 * one family. Falls back to the sampleId when no timestamp is found.
 */
export function defaultFamilyKey(manifest: SampleManifest): string {
  const match = manifest.annotationFile.match(/(\d{12})/);
  if (match) return match[1]!.slice(0, 12); // YYYYMMDDHHMM
  return manifest.sampleId;
}

/**
 * Seeded pseudo-random number generator (mulberry32) for deterministic
 * family-to-split assignment.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Assign each sample to a split (train/validation/test) by family. All
 * samples in the same family go to the same split. Families are shuffled
 * deterministically (seeded) then allocated to splits proportionally.
 *
 * When there is only one family, it goes to train (val/test would be empty).
 */
export function assignSplits(
  manifests: SampleManifest[],
  options: SplitOptions = {},
): SplitAssignment {
  const seed = options.seed ?? 0;
  const ratios = options.ratios ?? DEFAULT_RATIOS;
  const familyKeyFn = options.familyKey ?? defaultFamilyKey;
  const random = mulberry32(seed);

  // Group sample IDs by family
  const familyToSamples = new Map<string, string[]>();
  for (const manifest of manifests) {
    const key = familyKeyFn(manifest);
    const list = familyToSamples.get(key) ?? [];
    list.push(manifest.sampleId);
    familyToSamples.set(key, list);
  }

  const families = [...familyToSamples.keys()].sort();
  const shuffled = [...families];

  // Fisher-Yates shuffle with seeded random
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  const totalFamilies = shuffled.length;
  const trainCount = Math.round(totalFamilies * ratios.train);
  const valCount = Math.round(totalFamilies * ratios.validation);

  const assignment: SplitAssignment = {};
  shuffled.forEach((family, index) => {
    let split: SplitName;
    if (totalFamilies === 1) {
      split = 'train';
    } else if (index < trainCount) {
      split = 'train';
    } else if (index < trainCount + valCount) {
      split = 'validation';
    } else {
      split = 'test';
    }
    for (const sampleId of familyToSamples.get(family) ?? []) {
      assignment[sampleId] = split;
    }
  });

  return assignment;
}

/**
 * Verify that no family spans multiple splits. Returns leaked family keys
 * when the check fails.
 */
export function verifyNoLeakage(
  manifests: SampleManifest[],
  assignment: SplitAssignment,
  familyKey: (manifest: SampleManifest) => string = defaultFamilyKey,
): LeakageResult {
  const familySplits = new Map<string, Set<SplitName>>();
  for (const manifest of manifests) {
    const key = familyKey(manifest);
    const split = assignment[manifest.sampleId];
    if (!split) continue;
    const splits = familySplits.get(key) ?? new Set<SplitName>();
    splits.add(split);
    familySplits.set(key, splits);
  }

  const leakedFamilies: string[] = [];
  for (const [family, splits] of familySplits) {
    if (splits.size > 1) leakedFamilies.push(family);
  }

  return { ok: leakedFamilies.length === 0, leakedFamilies };
}
