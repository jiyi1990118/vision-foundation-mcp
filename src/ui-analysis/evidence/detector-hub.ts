import type { EvidenceCandidate } from './types.js';

export type DetectorFn = () => Promise<EvidenceCandidate[]>;

export interface DetectorHubOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DetectorResult {
  source: string;
  candidates: EvidenceCandidate[];
  error?: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

function raceWithDeadline<T>(
  name: string,
  fn: () => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`detector ${name} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`detector ${name} aborted`));
    };

    if (signal !== undefined) {
      if (signal.aborted) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`detector ${name} aborted`));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    fn()
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
        resolve(value);
      })
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
        reject(err);
      });
  });
}

export class DetectorHub {
  private readonly detectors = new Map<string, DetectorFn>();
  private readonly options: DetectorHubOptions;

  constructor(options?: DetectorHubOptions) {
    this.options = options ?? {};
  }

  register(name: string, fn: DetectorFn): void {
    this.detectors.set(name, fn);
  }

  unregister(name: string): void {
    this.detectors.delete(name);
  }

  has(name: string): boolean {
    return this.detectors.has(name);
  }

  listSources(): string[] {
    return Array.from(this.detectors.keys());
  }

  async runAll(): Promise<EvidenceCandidate[]> {
    const entries = Array.from(this.detectors.entries());
    if (entries.length === 0) return [];

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = this.options.signal;

    if (signal !== undefined && signal.aborted) return [];

    const settled = await Promise.allSettled(
      entries.map(async ([name, fn]): Promise<EvidenceCandidate[]> => {
        const result = await raceWithDeadline(name, fn, timeoutMs, signal);
        return result;
      }),
    );

    const all: EvidenceCandidate[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        all.push(...r.value);
      }
      // Rejected/timed-out/aborted detectors are silently skipped.
    }
    return all;
  }

  async runWithDiagnostics(): Promise<{ candidates: EvidenceCandidate[]; results: DetectorResult[] }> {
    const entries = Array.from(this.detectors.entries());
    if (entries.length === 0) return { candidates: [], results: [] };

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = this.options.signal;

    const rawResults = await Promise.all(
      entries.map(async ([name, fn]): Promise<DetectorResult> => {
        const start = Date.now();
        try {
          if (signal !== undefined && signal.aborted) {
            return { source: name, candidates: [], error: 'aborted', durationMs: Date.now() - start };
          }
          const candidates = await raceWithDeadline(name, fn, timeoutMs, signal);
          return { source: name, candidates, durationMs: Date.now() - start };
        } catch (err) {
          return {
            source: name,
            candidates: [],
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - start,
          };
        }
      }),
    );

    const allCandidates: EvidenceCandidate[] = [];
    for (const r of rawResults) {
      allCandidates.push(...r.candidates);
    }
    return { candidates: allCandidates, results: rawResults };
  }
}
