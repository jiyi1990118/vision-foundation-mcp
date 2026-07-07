import { describe, expect, it } from 'vitest';
import { composeResult } from '../src/core/skill-pipeline.js';
import type { SkillResultSet } from '../src/types/skills.js';

function makeResults(category: string, confidence: number, summary: string): SkillResultSet {
  return {
    classify: { skill: 'classify', success: true, data: { category, confidence }, duration: 100 },
    summary: { skill: 'summary', success: true, data: { description: summary }, duration: 100 },
  };
}

function classifyData(result: ReturnType<typeof composeResult>): Record<string, unknown> {
  return result.result.classify as Record<string, unknown>;
}

describe('composeResult — post-classify heuristic', () => {
  it('corrects "document" → "illustration" when summary mentions drawn/art/sword render', () => {
    const r = composeResult(
      makeResults('document', 0.7, 'In this image we can see a sword with glowing runes and a red dragon.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('illustration');
    expect(r.confidence).toBeLessThan(0.7);
    expect(classifyData(r).category).toBe('illustration');
    expect(classifyData(r).confidence).toBe(r.confidence);
    expect(classifyData(r).originalCategory).toBe('document');
  });

  it('corrects "document" → "photo" when summary mentions people/standing/room', () => {
    const r = composeResult(
      makeResults('document', 0.7, 'There is a girl standing in a room with two persons sitting on chairs.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('photo');
    expect(r.confidence).toBeLessThan(0.7);
    expect(classifyData(r).category).toBe('photo');
    expect(classifyData(r).confidence).toBe(r.confidence);
    expect(classifyData(r).originalCategory).toBe('document');
  });

  it('keeps "document" when summary actually describes a text document', () => {
    const r = composeResult(
      makeResults('document', 0.8, 'This is an invoice with itemized list of charges and a total at the bottom.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('document');
    expect(classifyData(r).category).toBe('document');
    expect(classifyData(r).originalCategory).toBeUndefined();
  });

  it('keeps non-document categories unchanged', () => {
    const r = composeResult(
      makeResults('chart', 0.9, 'A bar chart showing sales by quarter.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('chart');
    expect(r.confidence).toBe(0.9);
  });

  it('corrects to "ui" when summary mentions interface/buttons/widgets', () => {
    const r = composeResult(
      makeResults('document', 0.7, 'A settings panel with toggle buttons and a sidebar menu.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('ui');
    expect(classifyData(r).category).toBe('ui');
  });

  it('prefers chart over photo when summary mentions people looking at a chart', () => {
    const r = composeResult(
      makeResults('document', 0.7, 'Two people are looking at a bar chart showing sales by quarter.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('chart');
    expect(classifyData(r).category).toBe('chart');
  });

  it('prefers dashboard over chart when summary mentions KPI metrics and multiple panels', () => {
    const r = composeResult(
      makeResults('document', 0.7, 'A dashboard with KPI cards, revenue metrics, charts, and multiple panels.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('dashboard');
    expect(classifyData(r).category).toBe('dashboard');
  });

  it('prefers document over photo when summary describes a photographed invoice', () => {
    const r = composeResult(
      makeResults('document', 0.8, 'A person is holding an invoice with itemized charges and a total.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('document');
    expect(classifyData(r).category).toBe('document');
  });

  it('falls back to "other" when summary is empty and category was document', () => {
    const r = composeResult(
      makeResults('document', 0.7, ''),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    // No summary content to correct from; mark as low-confidence document.
    expect(r.category).toBe('document');
    expect(r.confidence).toBeLessThan(0.7);
    expect(classifyData(r).category).toBe('document');
    expect(classifyData(r).confidence).toBe(r.confidence);
  });
});
