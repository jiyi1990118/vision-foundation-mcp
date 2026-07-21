import type { BBox } from '../ir/types.js';

export type RenderMode = 'native' | 'hybrid' | 'asset' | 'semantic-only';

export interface RenderInfo {
  mode: RenderMode;
  assetId?: string;
  reason?: string;
}

export interface NodeConfidence {
  overall: number;
  type?: number;
  bounds?: number;
  text?: number;
  style?: number;
  state?: number;
}

export interface AssetItem {
  id: string;
  kind: 'icon' | 'logo' | 'photo' | 'illustration' | 'background' | 'decoration' | 'control-skin' | 'composite';
  bbox: BBox;
  mimeType: string;
  uri: string;
  dataUrl?: string;
  sha256: string;
  maskUri?: string;
  confidence: number;
}

export interface AssetManifest {
  items: AssetItem[];
}

export interface QualityReport {
  criticalElementCoverage: number;
  editableElementRatio: number;
  flattenedFallbackRatio: number;
  unexplainedAreaRatio: number;
  warnings: string[];
}
