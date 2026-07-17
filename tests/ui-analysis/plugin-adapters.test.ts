import { describe, expect, it } from 'vitest';
import {
  PaddleOcrEngine,
  UiLayoutDetector,
  UiLayoutLayoutEngine,
  parseOcrTextToItems,
  visionOcrItemsToOcrItems,
} from '../../src/ui-analysis/plugin/index.js';
import type {
  Detector,
  LayoutEngine,
  OcrEngine,
} from '../../src/ui-analysis/plugin/types.js';
import type { PpuPaddleOcrProvider } from '../../src/providers/ppu-paddle-ocr/provider.js';

describe('plugin adapters', () => {
  it('UiLayoutLayoutEngine satisfies LayoutEngine and exposes build', () => {
    const engine: LayoutEngine = new UiLayoutLayoutEngine();
    expect(engine.name).toBe('ui-layout-extractor');
    expect(engine.version).toBe('1.0.0');
    expect(typeof engine.build).toBe('function');
  });

  it('UiLayoutLayoutEngine.build throws when no image is supplied', async () => {
    const engine = new UiLayoutLayoutEngine();
    await expect(engine.build([], [])).rejects.toThrow(/requires an image/);
  });

  it('UiLayoutDetector satisfies Detector and exposes detect', async () => {
    const detector: Detector = new UiLayoutDetector();
    expect(detector.name).toBe('ui-layout-detector');
    expect(detector.version).toBe('1.0.0');
    expect(typeof detector.detect).toBe('function');
    await expect(detector.initialize()).resolves.toBeUndefined();
  });

  it('PaddleOcrEngine satisfies OcrEngine and exposes recognize', () => {
    const fake = { infer: async () => ({ text: '', duration: 0 }) } as unknown as PpuPaddleOcrProvider;
    const engine: OcrEngine = new PaddleOcrEngine(fake);
    expect(engine.name).toBe('paddle-ocr');
    expect(typeof engine.recognize).toBe('function');
  });

  it('PaddleOcrEngine.recognize parses provider.infer() output into VisionOcrItem[]', async () => {
    const fake = {
      infer: async () => ({
        text: JSON.stringify({
          texts: [
            { text: '保存', position: '10,20,60,36', confidence: 0.95 },
            { text: 'no-box' },
            { text: 'bad-pos', position: 'a,b,c,d' },
          ],
          language: 'zh',
        }),
        duration: 1,
      }),
    } as unknown as PpuPaddleOcrProvider;

    const engine = new PaddleOcrEngine(fake);
    const items = await engine.recognize({} as never);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe('保存');
    expect(items[0]!.bbox).toEqual({ x: 10, y: 20, w: 50, h: 16 });
    expect(items[0]!.confidence).toBeCloseTo(0.95);
  });

  it('parseOcrTextToItems maps position+text+confidence into VisionOcrItem[]', () => {
    const payload = JSON.stringify({
      texts: [{ text: 'A', position: '0,0,10,10', confidence: 0.5 }],
      language: 'en',
    });
    const items = parseOcrTextToItems(payload);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ text: 'A', bbox: { x: 0, y: 0, w: 10, h: 10 }, confidence: 0.5 });
  });

  it('parseOcrTextToItems defaults confidence to 1 when missing', () => {
    const payload = JSON.stringify({ texts: [{ text: 'B', position: '1,2,3,4' }] });
    const items = parseOcrTextToItems(payload);
    expect(items[0]!.confidence).toBe(1);
  });

  it('parseOcrTextToItems returns [] for malformed or empty payloads', () => {
    expect(parseOcrTextToItems('not json')).toEqual([]);
    expect(parseOcrTextToItems(JSON.stringify({ foo: 1 }))).toEqual([]);
    expect(parseOcrTextToItems(JSON.stringify({ texts: [] }))).toEqual([]);
  });

  it('visionOcrItemsToOcrItems converts bbox to the legacy x1/y1/x2/y2 box', () => {
    const items = visionOcrItemsToOcrItems([
      { text: 'hi', bbox: { x: 5, y: 6, w: 10, h: 4 }, confidence: 0.9 },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe('hi');
    expect(items[0]!.box).toEqual({ x1: 5, y1: 6, x2: 15, y2: 10 });
    expect(items[0]!.confidence).toBeCloseTo(0.9);
  });
});
