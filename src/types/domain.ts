/**
 * Domain types for Vision Foundation MCP.
 * @see Docs/02-contracts/01-domain-model.md
 */

/** Normalized image input, unified across all source formats. */
export interface ImageInput {
  buffer: Buffer;
  mimeType: string;
  source: string;
  size: number;
}

/** Lightweight image metadata extracted without model inference. */
export interface ImageMetadata {
  width: number;
  height: number;
  aspectRatio: number;
  format: string;
  hasAlpha: boolean;
  fileSize: number;
  complexity: 'low' | 'medium' | 'high';
  estimatedType?: string | undefined;
}

/** Request after normalization and metadata extraction. */
export interface NormalizedRequest {
  image: ImageInput;
  metadata: ImageMetadata;
  intent: string;
}

/** Inference request sent to a Provider. */
export interface InferenceRequest {
  image: ImageInput;
  prompt: string;
  maxTokens: number;
  temperature: number;
  cache?: boolean | undefined;
  /** Optional abort signal; when aborted, in-flight inference is cancelled. */
  signal?: AbortSignal | undefined;
}

/** Raw inference response from a Provider. */
export interface InferenceResponse {
  text: string;
  duration: number;
}

/** Provider lifecycle states.
 * @see Docs/01-architecture/08-lifecycle-manager.md
 */
export type ProviderState =
  | 'unloaded'
  | 'loading'
  | 'loaded'
  | 'idle'
  | 'unloading'
  | 'error';

/** Machine resource snapshot. */
export interface MachineResources {
  cpuCores: number;
  memoryAvailableMB: number;
  hasGPU: boolean;
  availableRuntimes: string[];
}

/** Final structured result returned to MCP Client.
 *
 * Also serves as the MCP structuredContent response — has an index
 * signature so it satisfies `{ [x: string]: unknown }`.
 */
export interface VisionResult {
  [key: string]: unknown;
  category: string;
  confidence: number;
  summary: string;
  skills: string[];
  result: Record<string, unknown>;
  metadata: {
    provider: string;
    runtime: string;
    duration: number;
    cached: boolean;
  };
}

// ── M2 types are defined in skills.ts (authoritative source) ──
// Re-export for convenience so callers can import from either file.
export type {
  SkillManifest,
  SkillTask,
  SkillResult,
  SkillResultSet,
  PlannerInput,
  ExecutionPlan,
  PolicyContext,
  PolicyRule,
} from './skills.js';
