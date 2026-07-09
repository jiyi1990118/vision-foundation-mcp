/**
 * Skill-related types.
 * @see Docs/01-architecture/05-skill-engine.md
 * @see Docs/02-contracts/01-domain-model.md
 */

import type { ImageMetadata, ImageInput } from './domain.js';

/** A single Skill's declaration (manifest). */
export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  inputs: { required: string[]; optional: string[] };
  outputs: string[];
  supportedProviders: string[];
  defaultTimeout: number;
  defaultRetry: { max: number; strategy: 'none' | 'reprompt' | 'fallback' };
  promptTemplate: string;
  schema: object;
}

/** A Skill task within an ExecutionPlan. */
export interface SkillTask {
  skill: string;
  prompt: string;
  schema: object;
  priority: number;
  dependsOn?: string[] | undefined;
  condition?: { field: string; equals: string } | undefined;
}

/** Result of a single Skill execution. */
export interface SkillResult {
  skill: string;
  success: boolean;
  data?: unknown;
  error?: string | undefined;
  duration: number;
  partial?: boolean | undefined;
}

/** Collection of Skill results from a pipeline run. */
export type SkillResultSet = Record<string, SkillResult>;

/** Planner input: everything needed to make a decision. */
export interface PlannerInput {
  image: ImageInput;
  metadata: ImageMetadata;
  intent: string;
  requestedSkills?: string[] | undefined;
  options: {
    quality?: 'fast' | 'high' | undefined;
    provider?: string | undefined;
    cache?: boolean | undefined;
    maxTokens?: number | undefined;
    target?: {
      color?: string | undefined;
      position?: string | undefined;
      description?: string | undefined;
    } | undefined;
  };
  resources: {
    cpuCores: number;
    totalMemoryMB?: number | undefined;
    memoryAvailableMB: number;
    hasGPU: boolean;
  };
  /** Identity of the actually-loaded provider, used as the planner default
   *  when `options.provider` is unset. Keeps ExecutionPlan.provider/runtime
   *  consistent with the runtime that will execute the plan. */
  activeProvider?: string | undefined;
  activeRuntime?: string | undefined;
}

/** Execution plan produced by Planner, validated by Policy. */
export interface ExecutionPlan {
  provider: string;
  runtime: string;
  preprocess: string[];
  skills: SkillTask[];
  postprocess: string[];
  cacheKey: string;
  timeout: number;
  retry: { max: number; strategy: 'none' | 'reprompt' | 'fallback' };
  maxTokens?: number | undefined;
  cache?: boolean | undefined;
}

/** Policy context for evaluation. */
export interface PolicyContext {
  plan: ExecutionPlan;
  metadata: ImageMetadata;
  intent: string;
  options: PlannerInput['options'];
  resources: PlannerInput['resources'];
}

/** A policy rule definition. */
export interface PolicyRule {
  name: string;
  description?: string | undefined;
  priority: number;
  when: Record<string, unknown>;
  override?: Record<string, unknown> | undefined;
  action: 'allow' | 'deny' | 'warn';
}
