/**
 * Universal Vision Parser - assembles the structured `result.parse` block
 * required by the Universal Vision Parser contract.
 *
 * Design (hybrid orchestration): the existing multi-skill pipeline (classify /
 * ocr / summary / layout) and algorithmic extractors (chart/diagram/document/
 * code/form) form a robust *sensing layer*. This module fuses their outputs
 * into the parser JSON. Only the reasoning fields (insights / risks /
 * next_actions) require a VLM call (`runReasoning`); when that fails or
 * hallucinates, scene-specific templates provide a deterministic fallback.
 */
import type {
  DesignBlock,
  DesignTokenEntry,
  Entity,
  ImageMetadata,
  ParseScene,
  QualityBlock,
  Relationship,
  SceneBlock,
  SceneEntry,
  UiLayoutBlock,
  UniversalParse,
} from '../types/domain.js';
import type { InferenceRequest, InferenceResponse } from '../types/domain.js';
import type { VisionProvider } from '../providers/types.js';
import type { DesignExtraction } from './extractors/design-extractor.js';
import type { UiLayoutExtraction } from './extractors/ui-layout-extractor.js';
import {
  nextActionTemplates,
  refineScene,
  sceneFromClassify,
  sceneFromHint,
  sceneFromScenario,
  type SceneSignal,
} from './scene-taxonomy.js';
import { logger } from '../utils/logger.js';

// ── Reasoning result (produced by runReasoning, consumed by buildUniversalParse) ──

export interface ReasoningResult {
  insights: string[];
  risks: string[];
  next_actions: string[];
}

// ── Input carrier for buildUniversalParse ──

export interface UniversalParseInput {
  /** classify() category (e.g. 'ui', 'chart', 'diagram'). */
  category: string;
  /** classify() confidence (0..1). */
  confidence: number;
  /** scenario-resolver scenario (e.g. 'requirement', 'chart', 'general'). */
  scenario: string;
  /** Final composed summary text. */
  summary: string;
  /** Joined OCR text (ground-truth labels / values). */
  ocrText: string | undefined;
  /** OCR items with positions (for layout + entity extraction). */
  ocrItems: Array<{ text: string; box?: { x1: number; y1: number; x2: number; y2: number }; confidence?: number }>;
  /** UI layout built from OCR (leftSidebar / mainContent / footerActions). */
  layout: unknown;
  /** Full scenario extraction object (chart/diagram/document/code/form data). */
  scenarioExtractionData: unknown;
  /** Key-content extraction (requirement scenario: annotated-box fields). */
  keyContentExtraction: unknown;
  /** VLM reasoning output, or undefined to use templates. */
  reasoningResult: ReasoningResult | undefined;
  /** User-provided scene hint (e.g. 'requirement'). Guides but does not override. */
  sceneHint: string | undefined;
  /** Image metadata (for quality assessment). */
  metadata: ImageMetadata | undefined;
  /** Request intent text (for scene refinement, e.g. "chat" keyword). */
  intent: string | undefined;
  /** Design token extraction (color palette, roles, dark mode). */
  designExtraction: DesignExtraction | undefined;
  /** UI layout extraction (visual regions, components, text hierarchy, spacing). */
  uiLayoutExtraction: UiLayoutExtraction | undefined;
}

// ── Scene detection ──

/**
 * Fuse classify + scenario + scene-hint + OCR refinements into a multi-scene
 * list. The highest-confidence scene is `final`. Per the parser contract, a
 * scene hint guides but never overrides real image evidence.
 */
export function buildSceneDetection(input: UniversalParseInput): SceneBlock {
  const signals: SceneSignal[] = [];
  const text = `${input.ocrText ?? ''}\n${input.summary}\n${input.intent ?? ''}`;

  // 1. classify category -> scene
  const classifySignal = sceneFromClassify(input.category);
  if (classifySignal) signals.push(classifySignal);

  // 2. scenario -> scene (intent-driven, high specificity)
  const scenarioSignal = sceneFromScenario(input.scenario);
  if (scenarioSignal) signals.push(scenarioSignal);

  // 3. scene hint -> scene (guides only; does not override stronger evidence)
  const hintSignal = sceneFromHint(input.sceneHint);
  if (hintSignal) signals.push(hintSignal);

  // 4. Refine: OCR/intent keywords can promote a base scene to a more specific
  //    one (e.g. flowchart -> mindmap, ui -> chat, code -> error).
  const base = signals[0]?.scene ?? 'other';
  const refinement = refineScene(base, text);
  if (refinement) signals.push(refinement);

  // Deduplicate by scene, keeping the highest confidence per scene.
  const byScene = new Map<ParseScene, SceneEntry>();
  for (const sig of signals) {
    const existing = byScene.get(sig.scene);
    if (!existing || sig.confidence > existing.confidence) {
      byScene.set(sig.scene, {
        scene: sig.scene,
        confidence: round(sig.confidence),
        reason: sig.reason,
      });
    }
  }

  const detected = [...byScene.values()].sort((a, b) => b.confidence - a.confidence);
  const top = detected[0];

  return {
    detected,
    final: top?.scene ?? 'other',
    reason: top?.reason ?? 'no signal',
  };
}

// ── Quality ──

export function buildQuality(input: UniversalParseInput): QualityBlock {
  const issues: string[] = [];
  const meta = input.metadata;

  let clarity = 0.7;
  if (meta) {
    if (meta.width > 0 && meta.width < 400) {
      clarity = 0.4;
      issues.push('low-resolution');
    } else if (meta.complexity === 'low') {
      clarity = 0.9;
    } else if (meta.complexity === 'high') {
      clarity = 0.6;
    }
  }

  // OCR confidence: prefer the average of per-item confidence (paddle-ocr
  // provides real scores); fall back to a count-based estimate otherwise.
  const items = input.ocrItems;
  let ocrConfidence: number;
  if (items.length === 0) {
    issues.push('no-ocr-text');
    ocrConfidence = 0.2;
  } else {
    const confidences = items
      .map((i) => i.confidence)
      .filter((c): c is number => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1);
    if (confidences.length >= items.length / 2) {
      // Enough items carry real confidence -> average them, then nudge by count.
      const avg = confidences.reduce((a, b) => a + b, 0) / confidences.length;
      const countBoost = items.length >= 20 ? 0.05 : items.length >= 8 ? 0 : -0.05;
      ocrConfidence = Math.min(1, Math.max(0, avg + countBoost));
    } else {
      // No/insufficient per-item confidence -> count-based estimate.
      if (items.length >= 20) ocrConfidence = 0.85;
      else if (items.length >= 8) ocrConfidence = 0.7;
      else ocrConfidence = 0.5;
    }
    if (ocrConfidence < 0.4) issues.push('low-ocr-confidence');
  }

  return {
    clarity: round(clarity),
    ocr_confidence: round(ocrConfidence),
    issues,
  };
}

// ── Entities ──

const ENTITY_PATTERNS: Array<{ type: string; regex: RegExp }> = [
  { type: 'url', regex: /https?:\/\/[^\s"')<>]+/gi },
  { type: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { type: 'phone', regex: /(?:\+?86)?1[3-9]\d{9}/g },
  { type: 'date', regex: /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}[-/]\d{1,2}[-/]\d{4}/g },
];

/** Extract entities from OCR text via regex (url/email/phone/date/number). */
function extractRegexEntities(ocrText: string): Entity[] {
  const entities: Entity[] = [];
  for (const { type, regex } of ENTITY_PATTERNS) {
    const matches = ocrText.match(regex);
    if (matches) {
      for (const value of [...new Set(matches)].slice(0, 8)) {
        entities.push({ type, value });
      }
    }
  }
  return entities;
}

/** Extract entities from scenario-specific extractor output. */
function extractScenarioEntities(data: unknown): Entity[] {
  const entities: Entity[] = [];
  if (typeof data !== 'object' || data === null) return entities;
  const d = data as Record<string, unknown>;

  // Chart: metrics (name+value)
  if (Array.isArray(d.metrics)) {
    for (const m of d.metrics) {
      if (typeof m === 'object' && m !== null) {
        const name = String((m as Record<string, unknown>).name ?? '');
        const value = String((m as Record<string, unknown>).value ?? '');
        if (name) entities.push({ type: 'metric', value, label: name });
      }
    }
  }
  // Chart: categories
  if (Array.isArray(d.categories)) {
    for (const c of d.categories) {
      if (typeof c === 'string' && c.length > 0) entities.push({ type: 'category', value: c });
    }
  }
  // Diagram: nodes
  if (Array.isArray(d.nodes)) {
    for (const n of d.nodes) {
      if (typeof n === 'object' && n !== null) {
        const label = String((n as Record<string, unknown>).label ?? '');
        if (label) entities.push({ type: 'node', value: label });
      }
    }
  }
  // Document/Form: fields (label+value)
  if (Array.isArray(d.fields)) {
    for (const f of d.fields) {
      if (typeof f === 'object' && f !== null) {
        const label = String((f as Record<string, unknown>).label ?? '');
        const value = String((f as Record<string, unknown>).value ?? '');
        if (label) entities.push({ type: 'field', value, label });
      }
    }
  }
  // Code: language
  if (typeof d.language === 'string' && d.language !== 'unknown') {
    entities.push({ type: 'language', value: String(d.language) });
  }
  // Code: detected title / document title
  if (typeof d.title === 'string' && d.title.length > 0) {
    entities.push({ type: 'title', value: String(d.title) });
  }

  return entities.slice(0, 30);
}

/** Extract field entities from a key-content extraction (requirement scenario). */
function extractKeyContentEntities(data: unknown): Entity[] {
  if (typeof data !== 'object' || data === null) return [];
  const d = data as Record<string, unknown>;
  const entities: Entity[] = [];
  const fieldArrays: Array<{ label: string; value: string }[]> = [];
  // Top-level fields.
  if (Array.isArray(d.fields)) fieldArrays.push(d.fields as { label: string; value: string }[]);
  // Per-box fields (allExtractions).
  if (Array.isArray(d.allExtractions)) {
    for (const ext of d.allExtractions) {
      if (typeof ext === 'object' && ext !== null && Array.isArray((ext as Record<string, unknown>).fields)) {
        fieldArrays.push((ext as Record<string, unknown>).fields as { label: string; value: string }[]);
      }
    }
  }
  for (const fields of fieldArrays) {
    for (const f of fields) {
      const label = typeof f.label === 'string' ? f.label : '';
      const value = typeof f.value === 'string' ? f.value : '';
      if (label) entities.push({ type: 'field', value, label });
    }
  }
  return entities;
}

export function buildEntities(input: UniversalParseInput): Entity[] {
  return extractEntities(
    input.ocrText ?? '',
    input.scenarioExtractionData,
    input.keyContentExtraction,
  );
}

/**
 * Lightweight entity extraction used by both the assembler and the reasoning
 * VLM call (so reasoning has grounded entity context without a full parse).
 */
export function extractEntities(
  ocrText: string,
  scenarioExtractionData: unknown,
  keyContentExtraction?: unknown,
): Entity[] {
  const fromOcr = extractRegexEntities(ocrText);
  const fromScenario = extractScenarioEntities(scenarioExtractionData);
  const fromKeyContent = extractKeyContentEntities(keyContentExtraction);
  // De-dup by type+value (+label for labeled fields), keep order
  // (scenario + key-content first for specificity).
  const seen = new Set<string>();
  const merged: Entity[] = [];
  for (const e of [...fromScenario, ...fromKeyContent, ...fromOcr]) {
    const key = e.label ? `${e.type}:${e.value}:${e.label}` : `${e.type}:${e.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(e);
    }
  }
  return merged.slice(0, 40);
}

// ── Relationships ──

export function buildRelationships(input: UniversalParseInput): Relationship[] {
  const data = input.scenarioExtractionData;
  if (typeof data !== 'object' || data === null) return [];
  const d = data as Record<string, unknown>;

  const relationships: Relationship[] = [];

  // Diagram: edges [fromId, toId]
  if (Array.isArray(d.edges) && Array.isArray(d.nodes)) {
    const nodes = d.nodes as Array<Record<string, unknown>>;
    const idToLabel = new Map<number, string>();
    for (const n of nodes) {
      const id = Number(n.id);
      const label = String(n.label ?? '');
      if (Number.isFinite(id) && label) idToLabel.set(id, label);
    }
    for (const edge of d.edges) {
      if (Array.isArray(edge) && edge.length >= 2) {
        const from = idToLabel.get(Number(edge[0])) ?? String(edge[0]);
        const to = idToLabel.get(Number(edge[1])) ?? String(edge[1]);
        relationships.push({ from, to, type: 'flow' });
      }
    }
  }

  return relationships.slice(0, 40);
}

// ── Logic ──

export function buildLogic(input: UniversalParseInput): string[] {
  const data = input.scenarioExtractionData;
  const logic: string[] = [];
  if (typeof data !== 'object' || data === null) return logic;
  const d = data as Record<string, unknown>;

  // Diagram: branch conditions
  if (Array.isArray(d.conditions)) {
    for (const c of d.conditions) {
      if (typeof c === 'string' && c.length > 0) logic.push(`分支条件: ${c}`);
    }
  }
  // Diagram: flow direction
  if (typeof d.flowDirection === 'string' && d.flowDirection !== 'unknown') {
    logic.push(`流向: ${d.flowDirection}`);
  }
  // Code: language + line count
  if (typeof d.language === 'string' && d.language !== 'unknown') {
    logic.push(`语言: ${d.language}`);
  }
  if (typeof d.lineCount === 'number' && d.lineCount > 0) {
    logic.push(`代码行数: ${d.lineCount}`);
  }

  return logic.slice(0, 20);
}

// ── Design tokens ──

function buildDesign(input: UniversalParseInput): DesignBlock | undefined {
  if (!input.designExtraction) return undefined;
  const palette: DesignTokenEntry[] = input.designExtraction.palette.map((t) => ({
    hex: t.hex,
    role: t.role,
    frequency: t.frequency,
  }));
  return {
    palette,
    background: input.designExtraction.background,
    primary: input.designExtraction.primary,
    textColor: input.designExtraction.textColor,
    isDarkMode: input.designExtraction.isDarkMode,
    contrastRatio: input.designExtraction.contrastRatio,
  };
}

// ── UI layout ──

function buildUiLayoutBlock(input: UniversalParseInput): UiLayoutBlock | undefined {
  if (!input.uiLayoutExtraction) return undefined;
  const ext = input.uiLayoutExtraction;
  return {
    pageType: ext.structure.pageType,
    layoutType: ext.structure.layoutType,
    regions: ext.structure.regions.map((r) => ({
      id: r.id,
      type: r.type,
      bbox: r.bbox,
      relativeArea: r.relativeArea,
      children: r.children,
    })),
    components: ext.components.map((c) => ({
      type: c.type,
      bbox: c.bbox,
      text: c.text,
      state: c.state,
      variant: c.variant,
    })),
    texts: ext.texts.map((t) => ({
      text: t.text,
      bbox: t.bbox,
      estimatedLevel: t.estimatedLevel,
    })),
    averageGap: ext.spacing.averageGap,
    spacingScale: ext.spacing.scale,
    mediaAreaCount: ext.mediaAreas.length,
    summary: ext.summary,
  };
}

// ── Main assembly ──

/**
 * Assemble the full UniversalParse block. Pure/synchronous - the async VLM
 * reasoning must already be resolved into `reasoningResult` by the caller.
 */
export function buildUniversalParse(input: UniversalParseInput): UniversalParse {
  const scene = buildSceneDetection(input);
  const quality = buildQuality(input);
  const entities = buildEntities(input);
  const relationships = buildRelationships(input);
  const logic = buildLogic(input);
  const design = buildDesign(input);
  const uiLayout = buildUiLayoutBlock(input);

  // Reasoning: prefer VLM output, fall back to scene templates.
  const reasoning = resolveReasoning(input.reasoningResult, scene.final);

  const ocrCorrected = normalizeOcr(input.ocrText);

  const layout = (input.layout as Record<string, unknown>) ?? {};

  // Overall confidence: blend classify confidence with OCR confidence.
  // When classify didn't run (confidence=0), use OCR confidence alone so
  // the result isn't artificially halved.
  const overallConfidence = input.confidence > 0
    ? round(Math.min(1, (input.confidence + quality.ocr_confidence) / 2))
    : round(quality.ocr_confidence);

  return {
    scene,
    quality,
    layout,
    ocr: { corrected: ocrCorrected },
    entities,
    relationships,
    logic,
    ...(design ? { design } : {}),
    ...(uiLayout ? { uiLayout } : {}),
    summary: input.summary,
    insights: reasoning.insights,
    risks: reasoning.risks,
    next_actions: reasoning.next_actions,
    confidence: overallConfidence,
  };
}

function resolveReasoning(
  reasoningResult: ReasoningResult | undefined,
  scene: ParseScene,
): ReasoningResult {
  if (reasoningResult) {
    // Fill next_actions from scene templates when the VLM returned none,
    // so the agent always gets actionable guidance.
    const nextActions = reasoningResult.next_actions.length > 0
      ? reasoningResult.next_actions
      : nextActionTemplates(scene);
    return {
      insights: reasoningResult.insights,
      risks: reasoningResult.risks,
      next_actions: nextActions,
    };
  }
  return {
    insights: [],
    risks: [],
    next_actions: nextActionTemplates(scene),
  };
}

function normalizeOcr(ocrText: string | undefined): string {
  if (!ocrText) return '';
  return ocrText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Reasoning VLM call ──

const REASONING_MAX_TOKENS = 256;

/**
 * Run a single focused VLM call to produce insights/risks/next_actions.
 *
 * Passes the image (so the model can reason visually) plus a compact text
 * context (scene/ocr/summary/entities) to ground the output. If the call
 * fails, the output is empty, or hallucination is detected, returns
 * `undefined` so the caller falls back to scene-specific templates.
 */
export async function runReasoning(
  provider: VisionProvider,
  input: {
    image: { buffer: Buffer; mimeType: string };
    scene: ParseScene;
    ocrText: string | undefined;
    summary: string;
    scenarioExtractionData: unknown;
    keyContentExtraction: unknown;
  },
  signal?: AbortSignal,
): Promise<ReasoningResult | undefined> {
  const ocrExcerpt = (input.ocrText ?? '').slice(0, 800);
  const summaryExcerpt = input.summary.slice(0, 400);
  const entities = extractEntities(input.ocrText ?? '', input.scenarioExtractionData, input.keyContentExtraction);
  const entitySummary = entities
    .slice(0, 8)
    .map((e) => `${e.type}:${e.value}`)
    .join(', ');

  const prompt = buildReasoningPrompt({
    scene: input.scene,
    ocrExcerpt,
    summaryExcerpt,
    entitySummary,
  });

  if (!provider.isLoaded()) {
    await provider.load();
  }

  let response: InferenceResponse;
  try {
    const req: InferenceRequest = {
      image: {
        buffer: input.image.buffer,
        mimeType: input.image.mimeType,
        source: 'reasoning',
        size: input.image.buffer.byteLength,
      },
      prompt,
      maxTokens: REASONING_MAX_TOKENS,
      temperature: 0,
      ...(signal ? { signal } : {}),
    };
    response = await provider.infer(req);
  } catch (err) {
    logger.warn('reasoning VLM call failed; using templates', { error: String(err) });
    return undefined;
  }

  const parsed = parseReasoningJson(response.text);
  if (!parsed) {
    logger.warn('reasoning VLM output unparseable; using templates', {
      preview: response.text.slice(0, 120),
    });
    return undefined;
  }

  if (hasHallucination(parsed)) {
    logger.warn('reasoning VLM output flagged as hallucination; using templates');
    return undefined;
  }

  return parsed;
}

function buildReasoningPrompt(ctx: {
  scene: ParseScene;
  ocrExcerpt: string;
  summaryExcerpt: string;
  entitySummary: string;
}): string {
  return [
    'You are analyzing an image that has already been parsed.',
    `Scene: ${ctx.scene}`,
    `OCR (excerpt): ${ctx.ocrExcerpt || '(none)'}`,
    `Summary: ${ctx.summaryExcerpt || '(none)'}`,
    `Key entities: ${ctx.entitySummary || '(none)'}`,
    '',
    'Based on this, output ONLY a JSON object with these fields:',
    '{"insights": [up to 3 short observations], "risks": [up to 3 risks/uncertainties], "next_actions": [up to 3 recommended next steps for an AI agent]}',
    '',
    'Rules:',
    '- Be specific and grounded in the OCR/summary. Do not invent.',
    '- Each item is a short string (<= 60 chars).',
    '- If uncertain, output empty arrays.',
    '- Output raw JSON only, no markdown, no explanation.',
  ].join('\n');
}

function parseReasoningJson(text: string): ReasoningResult | undefined {
  let cleaned = text.trim();
  // Strip markdown fences.
  if (cleaned.includes('```')) {
    cleaned = cleaned.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
  }
  // Extract first JSON object.
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) cleaned = match[0];

  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return undefined;
  }
  if (typeof obj !== 'object' || obj === null) return undefined;
  const o = obj as Record<string, unknown>;
  const insights = toStringArray(o.insights);
  const risks = toStringArray(o.risks);
  const nextActions = toStringArray(o.next_actions);
  if (insights.length === 0 && risks.length === 0 && nextActions.length === 0) {
    return undefined;
  }
  return {
    insights: insights.slice(0, 3),
    risks: risks.slice(0, 3),
    next_actions: nextActions.slice(0, 3),
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0 && v.length <= 200);
}

/** Detect hallucinated repetition (same phrase repeated 3+ times). */
function hasHallucination(result: ReasoningResult): boolean {
  const all = [...result.insights, ...result.risks, ...result.next_actions];
  if (all.length < 3) return false;
  const counts = new Map<string, number>();
  for (const item of all) {
    const key = item.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const count of counts.values()) {
    if (count > 2) return true;
  }
  return false;
}
