import { describe, expect, it } from 'vitest';
import { getSkill } from '../src/skills/registry.js';
import { compilePrompt } from '../src/core/prompt-compiler.js';
import type { ImageMetadata } from '../src/types/domain.js';

const wideScreenshotMeta: ImageMetadata = {
  width: 2658,
  height: 1164,
  aspectRatio: 2.28,
  format: 'png',
  hasAlpha: false,
  fileSize: 500000,
  complexity: 'high',
  estimatedType: 'screenshot',
};

describe('detail-oriented skill prompts', () => {
  it('summary prompt asks for structured description without copying OCR', () => {
    const skill = getSkill('summary')!;
    const prompt = compilePrompt(skill, {
      intent: 'extract details from a Chinese admin UI screenshot',
      metadata: wideScreenshotMeta,
    }).toLowerCase();

    // Anti-copy: must instruct the model not to copy OCR text directly
    expect(prompt).toContain('do not copy');
    expect(prompt).toContain('own words');

    // Must request structured UI elements
    expect(prompt).toContain('navigation');
    expect(prompt).toContain('table');
    expect(prompt).toContain('buttons');

    // Must provide concrete examples (critical for small models)
    expect(prompt).toContain('example 1');
    expect(prompt).toContain('example 2');

    // Must request page type identification
    expect(prompt).toContain('page type');
    expect(prompt).toContain('admin');
  });

  it('ocr prompt asks for layout-preserving table and control extraction', () => {
    const skill = getSkill('ocr')!;
    const prompt = compilePrompt(skill, {
      intent: 'read all Chinese text from a table-heavy admin screenshot',
      metadata: wideScreenshotMeta,
    }).toLowerCase();

    expect(prompt).toContain('preserve layout');
    expect(prompt).toContain('table headers');
    expect(prompt).toContain('rows');
    expect(prompt).toContain('buttons');
    expect(prompt).toContain('toggles');
    expect(prompt).toContain('chinese');
    expect(prompt).toContain('requirement screenshots');
    expect(prompt).toContain('red boxes');
    expect(prompt).toContain('arrows');
    expect(prompt).toContain('annotations');
    expect(prompt).toContain('{"text":"navigation/sidebar: 菜单中心"');
  });
});
