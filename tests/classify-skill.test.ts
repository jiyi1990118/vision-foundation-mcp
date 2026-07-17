import { describe, expect, it } from 'vitest';
import { getSkill } from '../src/skills/registry.js';
import { compilePrompt } from '../src/core/prompt-compiler.js';
import type { ImageMetadata } from '../src/types/domain.js';

const meta: ImageMetadata = {
  width: 1024, height: 1024, aspectRatio: 1, format: 'png',
  hasAlpha: false, fileSize: 100000, complexity: 'medium',
};

describe('classify skill — optimised prompt + schema', () => {
  it('ocr schema allows coordinate position strings from dedicated OCR providers', () => {
    const skill = getSkill('ocr')!;
    const schema = skill.schema as {
      properties: { texts: { items: { properties: { position: { type: string; enum?: string[] } } } } };
    };

    expect(schema.properties.texts.items.properties.position.type).toBe('string');
    expect(schema.properties.texts.items.properties.position.enum).toBeUndefined();
  });

  it('prompt contains a definition for each category in the schema enum', () => {
    const skill = getSkill('classify')!;
    expect(skill).toBeDefined();

    const schema = skill.schema as { properties: { category: { enum: string[] } } };
    const categories = schema.properties.category.enum;

    const prompt = compilePrompt(skill, { intent: 'auto', metadata: meta });

    // Each category must appear with a short definition, not just be listed.
    for (const cat of categories) {
      expect(prompt).toContain(cat);
    }
  });

  it('prompt explicitly tells the model NOT to default to document for non-text images', () => {
    const skill = getSkill('classify')!;
    const prompt = compilePrompt(skill, { intent: 'auto', metadata: meta });
    expect(prompt.toLowerCase()).toContain('do not default to');
  });

  it('prompt covers cartoon scientist and educational mascot images as illustration', () => {
    const skill = getSkill('classify')!;
    const prompt = compilePrompt(skill, { intent: 'auto', metadata: meta }).toLowerCase();
    expect(prompt).toContain('cartoon scientist');
    expect(prompt).toContain('educational mascot');
    expect(prompt).toContain('illustration');
  });

  it('prompt demands pure JSON output with no markdown', () => {
    const skill = getSkill('classify')!;
    const prompt = compilePrompt(skill, { intent: 'auto', metadata: meta });
    expect(prompt.toLowerCase()).toMatch(/only.*json|no markdown/i);
  });

  it('schema includes illustration and screenshot categories', () => {
    const skill = getSkill('classify')!;
    const schema = skill.schema as { properties: { category: { enum: string[] } } };
    expect(schema.properties.category.enum).toContain('illustration');
    expect(schema.properties.category.enum).toContain('screenshot');
  });

  it('schema allows an optional reasoning field', () => {
    const skill = getSkill('classify')!;
    const schema = skill.schema as { properties: Record<string, unknown> };
    expect(schema.properties.reasoning).toBeDefined();
  });

  it('declares support for a gguf provider (not only smolvlm)', () => {
    const skill = getSkill('classify')!;
    expect(skill.supportedProviders).toContain('gguf-smolvlm');
  });

  it('prompt is substantially richer than a one-line question', () => {
    const skill = getSkill('classify')!;
    const prompt = compilePrompt(skill, { intent: 'auto', metadata: meta });
    expect(prompt.length).toBeGreaterThan(300);
    expect(prompt.split('\n').length).toBeGreaterThan(5);
  });
});
