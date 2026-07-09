/**
 * Provider Router — selects a VisionProvider based on quality, resources, and skill coverage.
 *
 * M5 introduces multi-model routing. This pure function takes a list of available
 * provider candidates plus request context and returns the best-fit candidate,
 * falling back gracefully when the preferred option cannot run.
 *
 * @see Docs/01-architecture/06-provider-runtime.md
 */

export interface ProviderCandidate {
  name: string;
  runtime: string;
  quality: 'fast' | 'high';
  minMemoryMB: number;
  gpuPreferred: boolean;
  supportedSkills: string[];
}

export interface RouterOptions {
  quality?: 'fast' | 'high' | undefined;
  provider?: string | undefined;
  target?: unknown;
}

export interface RouterResources {
  memoryAvailableMB: number;
  totalMemoryMB?: number | undefined;
  hasGPU: boolean;
}

export interface RouterInput {
  candidates: ProviderCandidate[];
  options: RouterOptions;
  resources: RouterResources;
  requestedSkills: string[];
}

export interface RouterResult {
  name: string;
  runtime: string;
}

/**
 * Map a loaded `VisionProvider` instance to a routing candidate.
 *
 * Quality tier is inferred from the provider's resource requirements:
 * providers that require a GPU are treated as the `high` quality tier.
 */
export function providerToCandidate(provider: {
  name: string;
  runtime: string;
  supportedSkills: string[];
  requirements: { minMemoryMB: number; gpuRequired: boolean; modelSizeMB: number };
}): ProviderCandidate {
  return {
    name: provider.name,
    runtime: provider.runtime,
    quality: provider.requirements.gpuRequired ? 'high' : 'fast',
    minMemoryMB: provider.requirements.minMemoryMB,
    gpuPreferred: provider.requirements.gpuRequired,
    supportedSkills: [...provider.supportedSkills],
  };
}

/**
 * Choose the best provider for the given request.
 *
 * Selection order:
 *  1. If `options.provider` is set, prefer it (when feasible).
 *  2. Otherwise match `options.quality` (high-quality needs GPU + memory).
 *  3. Fall back to the first feasible fast provider.
 *
 * A candidate is feasible when it covers all `requestedSkills`, has enough
 * memory, and — if it is GPU-preferred — the host has a GPU.
 */
export function chooseProvider(input: RouterInput): RouterResult {
  const { candidates, options, resources, requestedSkills } = input;

  const feasible = candidates.filter((c) => isFeasible(c, resources, requestedSkills));

  if (feasible.length === 0) {
    throw new Error('No provider available that satisfies the requested skills and resources');
  }

  // 1. Explicit user request
  if (options.provider) {
    const explicit = feasible.find((c) => c.name === options.provider);
    if (explicit) {
      return { name: explicit.name, runtime: explicit.runtime };
    }
    throw new Error(`Requested provider is unavailable or infeasible: ${options.provider}`);
  }

  // 2. Quality preference
  const wantHigh = options.quality === 'high';
  if (wantHigh) {
    const high = feasible.find((c) => c.quality === 'high');
    if (high) {
      return { name: high.name, runtime: high.runtime };
    }
  }

  // 2b. Exact skill fit. This lets future dedicated OCR providers handle
  // OCR-only requests while mixed visual-understanding requests stay on VLMs.
  const exact = feasible.find((c) => isExactSkillFit(c, requestedSkills));
  if (exact) {
    return { name: exact.name, runtime: exact.runtime };
  }

  // 3. Default: first feasible fast provider
  const fast = feasible.find((c) => c.quality === 'fast') ?? feasible[0];
  if (!fast) {
    throw new Error('No provider available that satisfies the requested skills and resources');
  }
  return { name: fast.name, runtime: fast.runtime };
}

function isFeasible(
  candidate: ProviderCandidate,
  resources: RouterResources,
  requestedSkills: string[],
): boolean {
  const memoryMB = resources.totalMemoryMB ?? resources.memoryAvailableMB;
  if (memoryMB < candidate.minMemoryMB) return false;
  if (candidate.gpuPreferred && !resources.hasGPU) return false;
  if (requestedSkills.length > 0) {
    const supported = new Set(candidate.supportedSkills);
    for (const skill of requestedSkills) {
      if (!supported.has(skill)) return false;
    }
  }
  return true;
}

function isExactSkillFit(candidate: ProviderCandidate, requestedSkills: string[]): boolean {
  if (requestedSkills.length === 0) return false;
  if (candidate.supportedSkills.length !== requestedSkills.length) return false;
  const supported = new Set(candidate.supportedSkills);
  return requestedSkills.every((skill) => supported.has(skill));
}
