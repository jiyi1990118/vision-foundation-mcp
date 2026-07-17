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

// ── Universal Vision Parser output (result.parse) ──

export type ParseScene =
  | 'document'
  | 'requirement'
  | 'ui'
  | 'prototype'
  | 'photo'
  | 'code'
  | 'table'
  | 'chart'
  | 'flowchart'
  | 'mindmap'
  | 'ppt'
  | 'chat'
  | 'error'
  | 'other';

export interface SceneEntry {
  scene: ParseScene;
  confidence: number;
  reason: string;
}

export interface SceneBlock {
  detected: SceneEntry[];
  final: ParseScene;
  reason: string;
}

export interface QualityBlock {
  clarity: number;
  ocr_confidence: number;
  issues: string[];
}

export interface Entity {
  type: string;
  value: string;
  label?: string | undefined;
}

export interface Relationship {
  from: string;
  to: string;
  type?: string | undefined;
}

export interface DesignTokenEntry {
  hex: string;
  role: string;
  frequency: number;
}

export interface DesignBlock {
  palette: DesignTokenEntry[];
  background: string;
  primary: string;
  textColor: string;
  isDarkMode: boolean;
  contrastRatio: number;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VisualRegion {
  id: string;
  type: string;
  bbox: BBox;
  relativeArea: number;
  children: string[];
}

export interface UiComponentEntry {
  type: string;
  bbox: BBox;
  text: string;
  state: string;
  variant: string;
}

export interface TextEntry {
  text: string;
  bbox: BBox;
  estimatedLevel: string;
}

export interface UiLayoutBlock {
  pageType: string;
  layoutType: string;
  regions: VisualRegion[];
  components: UiComponentEntry[];
  texts: TextEntry[];
  averageGap: number;
  spacingScale: string;
  mediaAreaCount: number;
  summary: string;
}

export interface UniversalParse {
  scene: SceneBlock;
  quality: QualityBlock;
  layout: Record<string, unknown>;
  ocr: { corrected: string };
  entities: Entity[];
  relationships: Relationship[];
  logic: string[];
  design?: DesignBlock | undefined;
  uiLayout?: UiLayoutBlock | undefined;
  summary: string;
  insights: string[];
  risks: string[];
  next_actions: string[];
  confidence: number;
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
