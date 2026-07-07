/**
 * Vision Provider interface.
 * @see Docs/01-architecture/06-provider-runtime.md
 */
import type { InferenceRequest, InferenceResponse } from '../types/domain.js';

export interface VisionProvider {
  readonly name: string;
  readonly runtime: string;

  load(): Promise<void>;
  infer(req: InferenceRequest): Promise<InferenceResponse>;
  unload(): Promise<void>;
  isLoaded(): boolean;

  readonly supportedRuntimes: string[];
  readonly supportedSkills: string[];
  readonly requirements: {
    minMemoryMB: number;
    gpuRequired: boolean;
    modelSizeMB: number;
  };
}
