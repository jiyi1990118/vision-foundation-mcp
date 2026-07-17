import { describe, expect, it } from 'vitest';
import {
  buildSceneDetection,
  buildQuality,
  buildEntities,
  buildRelationships,
  buildLogic,
  buildUniversalParse,
  extractEntities,
  type UniversalParseInput,
} from '../src/core/universal-parser.js';
import {
  nextActionTemplates,
  sceneFromClassify,
  sceneFromHint,
  sceneFromScenario,
  refineScene,
} from '../src/core/scene-taxonomy.js';
import type { ImageMetadata } from '../src/types/domain.js';

function baseInput(overrides: Partial<UniversalParseInput> = {}): UniversalParseInput {
  return {
    category: 'ui',
    confidence: 0.7,
    scenario: 'general',
    summary: '',
    ocrText: undefined,
    ocrItems: [],
    layout: undefined,
    scenarioExtractionData: undefined,
    keyContentExtraction: undefined,
    reasoningResult: undefined,
    sceneHint: undefined,
    metadata: undefined,
    intent: undefined,
    ...overrides,
  };
}

const lowResMeta: ImageMetadata = {
  width: 300,
  height: 200,
  aspectRatio: 1.5,
  format: 'png',
  hasAlpha: false,
  fileSize: 50000,
  complexity: 'low',
};

const highResMeta: ImageMetadata = {
  width: 1920,
  height: 1080,
  aspectRatio: 1.78,
  format: 'png',
  hasAlpha: false,
  fileSize: 2_000_000,
  complexity: 'high',
};

// ── scene-taxonomy ──

describe('scene-taxonomy', () => {
  describe('sceneFromClassify', () => {
    it('maps ui category to ui scene', () => {
      const sig = sceneFromClassify('ui');
      expect(sig?.scene).toBe('ui');
      expect(sig?.confidence).toBe(0.7);
    });

    it('maps diagram to flowchart', () => {
      expect(sceneFromClassify('diagram')?.scene).toBe('flowchart');
    });

    it('maps dashboard to chart', () => {
      expect(sceneFromClassify('dashboard')?.scene).toBe('chart');
    });

    it('returns undefined for unknown/undefined', () => {
      expect(sceneFromClassify(undefined)).toBeUndefined();
    });
  });

  describe('sceneFromScenario', () => {
    it('maps requirement scenario', () => {
      expect(sceneFromScenario('requirement')?.scene).toBe('requirement');
    });

    it('maps invoice to document', () => {
      expect(sceneFromScenario('invoice')?.scene).toBe('document');
    });

    it('returns undefined for general', () => {
      expect(sceneFromScenario('general')).toBeUndefined();
    });
  });

  describe('sceneFromHint', () => {
    it('detects hint keyword', () => {
      expect(sceneFromHint('requirement')?.scene).toBe('requirement');
    });

    it('detects hint within a phrase', () => {
      expect(sceneFromHint('this is a code snippet')?.scene).toBe('code');
    });

    it('returns undefined for unknown hint', () => {
      expect(sceneFromHint('something-random')).toBeUndefined();
    });
  });

  describe('refineScene', () => {
    it('promotes flowchart to mindmap via keywords', () => {
      expect(refineScene('flowchart', 'this is a mindmap')?.scene).toBe('mindmap');
    });

    it('promotes ui to chat via keywords', () => {
      expect(refineScene('ui', '聊天记录')?.scene).toBe('chat');
    });

    it('promotes code to error via keywords', () => {
      expect(refineScene('code', 'Exception traceback error')?.scene).toBe('error');
    });

    it('returns undefined when no refinement matches', () => {
      expect(refineScene('photo', 'a calm landscape')).toBeUndefined();
    });
  });

  describe('nextActionTemplates', () => {
    it('returns requirement actions', () => {
      const actions = nextActionTemplates('requirement');
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.some((a) => a.includes('PRD'))).toBe(true);
    });

    it('returns code actions', () => {
      const actions = nextActionTemplates('code');
      expect(actions.some((a) => a.includes('Bug') || a.includes('重构'))).toBe(true);
    });

    it('returns default actions for other', () => {
      const actions = nextActionTemplates('other');
      expect(actions.length).toBeGreaterThan(0);
    });
  });
});

// ── buildSceneDetection ──

describe('buildSceneDetection', () => {
  it('uses classify when no scenario/hint', () => {
    const block = buildSceneDetection(baseInput({ category: 'chart', scenario: 'general' }));
    expect(block.final).toBe('chart');
    expect(block.detected.length).toBe(1);
    expect(block.detected[0]?.confidence).toBe(0.7);
  });

  it('fuses classify + scenario into multiple scenes', () => {
    const block = buildSceneDetection(baseInput({
      category: 'ui',
      scenario: 'requirement',
      ocrText: '产品需求文档',
    }));
    // Both requirement (scenario, high conf) and ui (classify) should appear.
    const scenes = block.detected.map((d) => d.scene);
    expect(scenes).toContain('requirement');
    expect(scenes).toContain('ui');
    // Requirement (intent-driven, 0.9) should beat ui (classify, 0.7).
    expect(block.final).toBe('requirement');
  });

  it('scene hint guides but does not override stronger evidence', () => {
    const block = buildSceneDetection(baseInput({
      category: 'chart',
      scenario: 'general',
      sceneHint: 'requirement',
    }));
    // Both signals present; hint (0.8) > classify (0.7) so requirement wins.
    expect(block.final).toBe('requirement');
  });

  it('refines to mindmap when keywords present', () => {
    const block = buildSceneDetection(baseInput({
      category: 'diagram',
      scenario: 'general',
      ocrText: '思维导图 中心主题',
    }));
    expect(block.final).toBe('mindmap');
  });

  it('refines scene using intent keywords', () => {
    const block = buildSceneDetection(baseInput({
      category: 'ui',
      scenario: 'general',
      intent: '分析这个聊天记录',
    }));
    expect(block.final).toBe('chat');
  });

  it('refines scene using summary keywords', () => {
    const block = buildSceneDetection(baseInput({
      category: 'code',
      scenario: 'general',
      summary: 'This shows a traceback error with exception details',
    }));
    expect(block.final).toBe('error');
  });

  it('defaults to other when no signals', () => {
    const block = buildSceneDetection(baseInput({ category: 'unknown', scenario: 'general' }));
    expect(block.final).toBe('other');
  });

  it('deduplicates scenes keeping highest confidence', () => {
    const block = buildSceneDetection(baseInput({
      category: 'ui',
      scenario: 'requirement',
      sceneHint: 'ui',
    }));
    // ui appears once (from classify + hint, keep highest).
    const uiEntries = block.detected.filter((d) => d.scene === 'ui');
    expect(uiEntries.length).toBe(1);
  });
});

// ── buildQuality ──

describe('buildQuality', () => {
  it('flags low-resolution images', () => {
    const q = buildQuality(baseInput({ metadata: lowResMeta }));
    expect(q.issues).toContain('low-resolution');
    expect(q.clarity).toBeLessThanOrEqual(0.5);
  });

  it('flags no-ocr-text', () => {
    const q = buildQuality(baseInput({ ocrItems: [] }));
    expect(q.issues).toContain('no-ocr-text');
    expect(q.ocr_confidence).toBeLessThanOrEqual(0.3);
  });

  it('boosts ocr confidence with many items', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ text: `item${i}` }));
    const q = buildQuality(baseInput({ ocrItems: items }));
    expect(q.ocr_confidence).toBeGreaterThanOrEqual(0.8);
    expect(q.issues).not.toContain('no-ocr-text');
  });

  it('averages per-item confidence when available', () => {
    const items = Array.from({ length: 10 }, () => ({ text: 'x', confidence: 0.9 }));
    const q = buildQuality(baseInput({ ocrItems: items }));
    expect(q.ocr_confidence).toBeGreaterThanOrEqual(0.85);
    expect(q.issues).not.toContain('low-ocr-confidence');
  });

  it('flags low average confidence', () => {
    const items = Array.from({ length: 10 }, () => ({ text: 'x', confidence: 0.2 }));
    const q = buildQuality(baseInput({ ocrItems: items }));
    expect(q.issues).toContain('low-ocr-confidence');
  });

  it('falls back to count-based when confidence is sparse', () => {
    // 10 items but only 2 carry confidence (< half) -> count-based estimate.
    const items = Array.from({ length: 10 }, (_, i) => ({
      text: `x${i}`,
      ...(i < 2 ? { confidence: 0.9 } : {}),
    }));
    const q = buildQuality(baseInput({ ocrItems: items }));
    // 10 items -> count band 0.7
    expect(q.ocr_confidence).toBe(0.7);
  });

  it('handles undefined metadata gracefully', () => {
    const q = buildQuality(baseInput({ metadata: undefined }));
    expect(q.clarity).toBeGreaterThanOrEqual(0);
  });
});

// ── buildEntities / extractEntities ──

describe('buildEntities', () => {
  it('extracts url/email/phone/date from OCR text', () => {
    const entities = extractEntities(
      'visit https://example.com or email test@x.com call 13800138000 on 2024-01-15',
      undefined,
    );
    const types = entities.map((e) => e.type);
    expect(types).toContain('url');
    expect(types).toContain('email');
    expect(types).toContain('phone');
    expect(types).toContain('date');
  });

  it('extracts metrics from chart extraction', () => {
    const data = { metrics: [{ name: 'revenue', value: '1000' }], categories: ['Q1', 'Q2'] };
    const entities = extractEntities('', data);
    const types = entities.map((e) => e.type);
    expect(types).toContain('metric');
    expect(types).toContain('category');
  });

  it('extracts nodes from diagram extraction', () => {
    const data = { nodes: [{ id: 0, label: 'Start' }], edges: [] };
    const entities = extractEntities('', data);
    expect(entities.some((e) => e.type === 'node' && e.value === 'Start')).toBe(true);
  });

  it('extracts language from code extraction', () => {
    const data = { language: 'python', lineCount: 42 };
    const entities = extractEntities('', data);
    expect(entities.some((e) => e.type === 'language' && e.value === 'python')).toBe(true);
  });

  it('deduplicates by type+value', () => {
    const entities = extractEntities('test@x.com test@x.com', undefined);
    const emails = entities.filter((e) => e.type === 'email');
    expect(emails.length).toBe(1);
  });

  it('keeps fields with same value but different labels', () => {
    const keyContent = {
      fields: [
        { label: '开始日期', value: '2024-01-01' },
        { label: '结束日期', value: '2024-01-01' },
      ],
    };
    const entities = extractEntities('', undefined, keyContent);
    const fields = entities.filter((e) => e.type === 'field' && e.value === '2024-01-01');
    expect(fields.length).toBe(2);
    expect(fields.map((f) => f.label)).toContain('开始日期');
    expect(fields.map((f) => f.label)).toContain('结束日期');
  });

  it('caps at 40 entities', () => {
    const text = Array.from({ length: 50 }, (_, i) => `https://example.com/${i}`).join(' ');
    const entities = extractEntities(text, undefined);
    expect(entities.length).toBeLessThanOrEqual(40);
  });

  it('extracts fields from key-content extraction (requirement scenario)', () => {
    const keyContent = {
      fields: [{ label: '状态', value: '在售' }],
      allExtractions: [
        { color: 'red', fields: [{ label: '价格', value: '28元' }] },
      ],
      summary: '...',
    };
    const entities = extractEntities('', undefined, keyContent);
    const labels = entities.map((e) => e.label);
    expect(labels).toContain('状态');
    expect(labels).toContain('价格');
  });

  it('includes key-content fields in buildUniversalParse entities', () => {
    const parse = buildUniversalParse(baseInput({
      category: 'ui',
      scenario: 'requirement',
      keyContentExtraction: { fields: [{ label: '名称', value: '拿铁' }] },
    }));
    expect(parse.entities.some((e) => e.label === '名称')).toBe(true);
  });
});

// ── buildRelationships ──

describe('buildRelationships', () => {
  it('builds flow edges from diagram nodes+edges', () => {
    const data = {
      nodes: [
        { id: 0, label: 'Start' },
        { id: 1, label: 'Process' },
        { id: 2, label: 'End' },
      ],
      edges: [[0, 1], [1, 2]] as Array<[number, number]>,
    };
    const rels = buildRelationships(baseInput({ scenarioExtractionData: data }));
    expect(rels.length).toBe(2);
    expect(rels[0]).toEqual({ from: 'Start', to: 'Process', type: 'flow' });
    expect(rels[1]).toEqual({ from: 'Process', to: 'End', type: 'flow' });
  });

  it('returns empty for non-diagram extraction', () => {
    const data = { language: 'python' };
    expect(buildRelationships(baseInput({ scenarioExtractionData: data }))).toEqual([]);
  });
});

// ── buildLogic ──

describe('buildLogic', () => {
  it('extracts conditions from diagram', () => {
    const data = { conditions: ['是', '否'], flowDirection: 'top-down' };
    const logic = buildLogic(baseInput({ scenarioExtractionData: data }));
    expect(logic.some((l) => l.includes('是'))).toBe(true);
    expect(logic.some((l) => l.includes('top-down'))).toBe(true);
  });

  it('extracts language from code', () => {
    const data = { language: 'typescript', lineCount: 100 };
    const logic = buildLogic(baseInput({ scenarioExtractionData: data }));
    expect(logic.some((l) => l.includes('typescript'))).toBe(true);
    expect(logic.some((l) => l.includes('100'))).toBe(true);
  });

  it('returns empty for no extraction', () => {
    expect(buildLogic(baseInput())).toEqual([]);
  });
});

// ── buildUniversalParse (full assembly) ──

describe('buildUniversalParse', () => {
  it('assembles all fields with template fallback when no reasoning', () => {
    const parse = buildUniversalParse(baseInput({
      category: 'requirement',
      scenario: 'requirement',
      summary: 'A PRD document',
      ocrText: '需求文档',
    }));
    expect(parse.scene.final).toBe('requirement');
    expect(parse.summary).toBe('A PRD document');
    expect(parse.ocr.corrected).toBe('需求文档');
    expect(parse.insights).toEqual([]);
    expect(parse.risks).toEqual([]);
    // Fallback: next_actions from requirement template.
    expect(parse.next_actions.length).toBeGreaterThan(0);
    expect(parse.next_actions.some((a) => a.includes('PRD'))).toBe(true);
  });

  it('uses VLM reasoning when provided', () => {
    const parse = buildUniversalParse(baseInput({
      category: 'code',
      scenario: 'code',
      reasoningResult: {
        insights: ['uses async pattern'],
        risks: ['no error handling'],
        next_actions: ['add try-catch'],
      },
    }));
    expect(parse.insights).toEqual(['uses async pattern']);
    expect(parse.risks).toEqual(['no error handling']);
    expect(parse.next_actions).toEqual(['add try-catch']);
  });

  it('fills next_actions from templates when VLM omits them', () => {
    const parse = buildUniversalParse(baseInput({
      category: 'requirement',
      scenario: 'requirement',
      reasoningResult: {
        insights: ['key fields detected'],
        risks: ['unclear priority'],
        next_actions: [],
      },
    }));
    expect(parse.insights).toEqual(['key fields detected']);
    expect(parse.risks).toEqual(['unclear priority']);
    // next_actions should be filled from requirement template, not empty.
    expect(parse.next_actions.length).toBeGreaterThan(0);
    expect(parse.next_actions.some((a) => a.includes('PRD'))).toBe(true);
  });

  it('uses OCR confidence alone when classify did not run', () => {
    const parse = buildUniversalParse(baseInput({
      category: 'unknown',
      confidence: 0,
      ocrItems: Array.from({ length: 25 }, (_, i) => ({ text: `t${i}` })),
    }));
    // 25 items -> count-based ocr_confidence = 0.85; no classify blend.
    expect(parse.confidence).toBe(0.85);
  });

  it('includes entities and relationships from extraction', () => {
    const data = {
      nodes: [{ id: 0, label: 'A' }, { id: 1, label: 'B' }],
      edges: [[0, 1]] as Array<[number, number]>,
      conditions: ['yes'],
    };
    const parse = buildUniversalParse(baseInput({
      category: 'diagram',
      scenario: 'diagram',
      scenarioExtractionData: data,
    }));
    expect(parse.entities.some((e) => e.type === 'node')).toBe(true);
    expect(parse.relationships.length).toBe(1);
    expect(parse.logic.some((l) => l.includes('yes'))).toBe(true);
  });

  it('includes quality and layout', () => {
    const parse = buildUniversalParse(baseInput({
      category: 'ui',
      metadata: highResMeta,
      ocrItems: Array.from({ length: 10 }, (_, i) => ({ text: `t${i}` })),
      layout: { leftSidebar: ['menu'] },
    }));
    expect(parse.quality).toBeDefined();
    expect(parse.quality.ocr_confidence).toBeGreaterThan(0.5);
    expect(parse.layout).toEqual({ leftSidebar: ['menu'] });
  });

  it('confidence blends classify and ocr confidence', () => {
    const parse = buildUniversalParse(baseInput({
      category: 'ui',
      confidence: 0.8,
      ocrItems: Array.from({ length: 25 }, (_, i) => ({ text: `t${i}` })),
    }));
    expect(parse.confidence).toBeGreaterThan(0.5);
    expect(parse.confidence).toBeLessThanOrEqual(1);
  });

  it('normalizes ocr text (trims empties)', () => {
    const parse = buildUniversalParse(baseInput({
      ocrText: '  line1  \n\n  \n  line2  ',
    }));
    expect(parse.ocr.corrected).toBe('line1\nline2');
  });
});
