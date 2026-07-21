/**
 * Reconstruction spec builder (Stream S15).
 *
 * Aggregates the scattered UI recovery signals (SemanticAST tree, semantics,
 * theme, codegen constraints, image-content info) into a single
 * `UiReconstructionSpec` that a downstream agent can consume in one read to
 * reconstruct the original UI. Pure, deterministic, no IO; a failure here
 * must never break the main analysis flow (callers wrap in try/catch).
 *
 * @see ../ir/types.js            (SemanticAST / ASTNode / BBox / CodegenConstraint)
 * @see ../constraint/constraint-engine.js  (inferConstraints fallback)
 * @see ../image-content/image-content-extractor.js  (ImageContentInfo)
 */
import type {
  ASTNode,
  BBox,
  CodegenConstraint,
  CodegenRepeat,
  CodegenResponsiveRule,
  CodegenSlot,
  SemanticAST,
} from '../ir/types.js';
import { inferConstraints } from '../constraint/constraint-engine.js';
import type { ImageContentInfo } from '../image-content/image-content-extractor.js';
import type { AssetManifest, QualityReport } from '../policy/types.js';

export interface UiReconstructionSpec {
  version: string;
  page: { type: 'page'; layoutType: string; bbox: BBox };
  semantics?: { pageType: string; confidence: number; summary: string };
  theme?: {
    palette: Array<{ hex: string; role: string }>;
    primary: string;
    background: string;
    textColor: string;
    isDarkMode: boolean;
    contrastRatio: number;
  };
  tree: ASTNode;
  constraints: CodegenConstraint[];
  responsive?: CodegenResponsiveRule[];
  repeats?: CodegenRepeat[];
  slots?: CodegenSlot[];
  images: ImageContentInfo[];
  stats: { nodeCount: number; componentCounts: Record<string, number> };
  diagnostics?: { skipped: string[] };
  assets?: AssetManifest;
  quality?: QualityReport;
}

export interface BuildReconstructionInput {
  ast: SemanticAST;
  semantics?: { pageType: string; confidence: number; summary: string } | undefined;
  constraints?: CodegenConstraint[] | undefined;
  responsive?: CodegenResponsiveRule[] | undefined;
  repeats?: CodegenRepeat[] | undefined;
  slots?: CodegenSlot[] | undefined;
  images?: ImageContentInfo[] | undefined;
  theme?: {
    palette: Array<{ hex: string; role: string }>;
    background: string;
    primary: string;
    textColor: string;
    isDarkMode: boolean;
    contrastRatio: number;
  } | undefined;
  diagnostics?: { skipped: string[] } | undefined;
  assets?: AssetManifest | undefined;
  quality?: QualityReport | undefined;
}

function computeStats(
  root: ASTNode,
): { nodeCount: number; componentCounts: Record<string, number> } {
  let nodeCount = 0;
  const componentCounts: Record<string, number> = {};
  const walk = (node: ASTNode): void => {
    nodeCount++;
    componentCounts[node.type] = (componentCounts[node.type] ?? 0) + 1;
    for (const child of node.children) walk(child);
  };
  walk(root);
  return { nodeCount, componentCounts };
}

export function buildUiReconstruction(input: BuildReconstructionInput): UiReconstructionSpec {
  const { ast, semantics, constraints, images, theme, responsive, repeats, slots, diagnostics, assets, quality } = input;
  const spec: UiReconstructionSpec = {
    version: ast.version,
    page: {
      type: 'page',
      layoutType: String(ast.root.props.layoutType ?? ''),
      bbox: ast.root.bbox,
    },
    tree: ast.root,
    constraints: constraints ?? inferConstraints(ast),
    images: images ?? [],
    stats: computeStats(ast.root),
    ...(semantics ? { semantics } : {}),
    ...(theme ? { theme } : {}),
    ...(responsive ? { responsive } : {}),
    ...(repeats && repeats.length > 0 ? { repeats } : {}),
    ...(slots && slots.length > 0 ? { slots } : {}),
    ...(diagnostics && diagnostics.skipped.length > 0 ? { diagnostics } : {}),
    ...(assets ? { assets } : {}),
    ...(quality ? { quality } : {}),
  };
  return spec;
}
