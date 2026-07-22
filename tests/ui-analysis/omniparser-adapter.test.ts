import { describe, it, expect } from 'vitest';
import { OmniParserAdapter, parseOmniResponse } from '../../src/ui-analysis/evidence/omniparser-adapter.js';
import type { EvidenceCandidate } from '../../src/ui-analysis/evidence/types.js';

describe('OmniParserAdapter', () => {
  it('returns empty when sidecar is not reachable', async () => {
    const adapter = new OmniParserAdapter({ baseUrl: 'http://localhost:99999' });
    // Will fail to connect, should return empty
    const candidates = await adapter.detect({
      buffer: Buffer.alloc(100),
      mimeType: 'image/png',
      source: 'test',
      size: 100,
    });
    expect(candidates).toHaveLength(0);
  });

  it('parseOmniResponse converts normalized xyxy to pixel xywh', () => {
    const response = {
      parsed_content_list: [
        { content: 'search icon', bbox: [0.1, 0.2, 0.3, 0.4], interactivity: true },
        { content: 'Submit button', bbox: [0.5, 0.6, 0.8, 0.9], interactivity: true },
      ],
    };
    const candidates = parseOmniResponse(response, 375, 812);
    expect(candidates).toHaveLength(2);
    const first = candidates[0]!;
    expect(first.type).toBe('icon');
    expect(first.bbox.x).toBeCloseTo(37.5); // 0.1 * 375
    expect(first.bbox.y).toBeCloseTo(162.4); // 0.2 * 812
    expect(first.bbox.w).toBeCloseTo(75); // (0.3-0.1) * 375
    expect(first.bbox.h).toBeCloseTo(162.4); // (0.4-0.2) * 812
    expect(first.sources).toContain('omniparser');
    expect(first.score).toBe(1.0);
  });

  it('classifies interactive text as button', () => {
    const response = {
      parsed_content_list: [
        { content: 'Submit', bbox: [0.1, 0.1, 0.3, 0.15], interactivity: true },
      ],
    };
    const candidates = parseOmniResponse(response, 100, 100);
    expect(candidates[0]!.type).toBe('button');
    expect(candidates[0]!.text).toBe('Submit');
  });

  it('classifies non-interactive text as text', () => {
    const response = {
      parsed_content_list: [
        { content: 'Hello World', bbox: [0.1, 0.1, 0.5, 0.15], interactivity: false },
      ],
    };
    const candidates = parseOmniResponse(response, 100, 100);
    expect(candidates[0]!.type).toBe('text');
    expect(candidates[0]!.text).toBe('Hello World');
  });

  it('handles empty response', () => {
    const candidates = parseOmniResponse({ parsed_content_list: [] }, 100, 100);
    expect(candidates).toHaveLength(0);
  });

  it('handles missing parsed_content_list', () => {
    const candidates = parseOmniResponse({}, 100, 100);
    expect(candidates).toHaveLength(0);
  });
});
