import { describe, expect, it } from 'vitest';
import { PpuPaddleOcrProvider, normalizePaddleOcrResult } from '../src/providers/ppu-paddle-ocr/provider.js';

const sampleOcrResult = {
  text: '菜单中心\n比萨配料管理\n保存',
  boxes: [
    { text: '菜单中心', score: 0.98, box: [[10, 10], [100, 10], [100, 30], [10, 30]] },
    { text: '比萨配料管理', score: 0.96, box: [[120, 10], [260, 10], [260, 30], [120, 30]] },
    { text: '保存', score: 0.95, box: [[900, 700], [950, 700], [950, 740], [900, 740]] },
  ],
};

describe('PpuPaddleOcrProvider', () => {
  it('declares OCR-only provider capabilities', () => {
    const provider = new PpuPaddleOcrProvider();
    expect(provider.name).toBe('ppu-paddle-ocr');
    expect(provider.runtime).toBe('native-ocr');
    expect(provider.supportedSkills).toEqual(['ocr']);
    expect(provider.requirements.gpuRequired).toBe(false);
  });

  it('normalizes PaddleOCR text boxes into the existing OCR schema', () => {
    const normalized = normalizePaddleOcrResult(sampleOcrResult);
    expect(normalized.language).toBe('zh');
    expect(normalized.texts).toEqual([
      { text: '菜单中心', position: '10,10,100,30', confidence: 0.98 },
      { text: '比萨配料管理', position: '120,10,260,30', confidence: 0.96 },
      { text: '保存', position: '900,700,950,740', confidence: 0.95 },
    ]);
  });

  it('falls back to line text when detailed boxes are not present', () => {
    const normalized = normalizePaddleOcrResult({ text: '取消\n保存' });
    expect(normalized.language).toBe('zh');
    expect(normalized.texts.map((item) => item.text)).toEqual(['取消', '保存']);
  });

  it('normalizes flattened ppu-paddle-ocr results with rectangle boxes', () => {
    const normalized = normalizePaddleOcrResult({
      text: 'POS CODE 保存',
      confidence: 0.91,
      results: [
        { text: 'POS CODE', confidence: 0.93, box: { x: 20, y: 40, width: 120, height: 24 } },
        { text: '保存', confidence: 0.89, box: { x: 900, y: 700, width: 50, height: 32 } },
      ],
    });

    expect(normalized.language).toBe('zh');
    expect(normalized.texts).toEqual([
      { text: 'POS CODE', position: '20,40,140,64', confidence: 0.93 },
      { text: '保存', position: '900,700,950,732', confidence: 0.89 },
    ]);
  });

  it('normalizes nested line results from ppu-paddle-ocr', () => {
    const normalized = normalizePaddleOcrResult({
      lines: [
        [{ text: '默认基础价', confidence: 0.9, box: { x: 10, y: 10, width: 100, height: 20 } }],
        [{ text: '保存', confidence: 0.95, box: { x: 10, y: 40, width: 50, height: 20 } }],
      ],
    });

    expect(normalized.texts).toEqual([
      { text: '默认基础价', position: '10,10,110,30', confidence: 0.9 },
      { text: '保存', position: '10,40,60,60', confidence: 0.95 },
    ]);
  });

  it('serializes concurrent load calls to one service initialization', async () => {
    let initializeCount = 0;
    class MockService {
      async initialize() {
        initializeCount++;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      async recognize() {
        return sampleOcrResult;
      }

      async destroy() {}
    }

    const provider = new PpuPaddleOcrProvider(MockService);
    await Promise.all([provider.load(), provider.load()]);

    expect(initializeCount).toBe(1);
    await provider.unload();
  });

  it('filters low-confidence short OCR noise without dropping useful UI text', () => {
    const normalized = normalizePaddleOcrResult({
      text: '菜单中心 o 0 十 POS分类管理',
      results: [
        { text: '菜单中心', confidence: 0.99, box: { x: 10, y: 10, width: 100, height: 20 } },
        { text: 'o', confidence: 0.24, box: { x: 120, y: 10, width: 10, height: 20 } },
        { text: '0', confidence: 0.24, box: { x: 140, y: 10, width: 10, height: 20 } },
        { text: '十', confidence: 0.99, box: { x: 160, y: 10, width: 20, height: 20 } },
        { text: 'POS分类管理', confidence: 0.99, box: { x: 10, y: 40, width: 120, height: 20 } },
      ],
    });

    expect(normalized.texts.map((item) => item.text)).toEqual(['菜单中心', '十', 'POS分类管理']);
  });

  it('returns JSON that matches the OCR skill schema from mocked inference', async () => {
    class MockService {
      async initialize() {}

      async recognize() {
        return sampleOcrResult;
      }

      async destroy() {}
    }

    const provider = new PpuPaddleOcrProvider(MockService);
    const response = await provider.infer({
      image: { buffer: Buffer.from('image'), mimeType: 'image/png', source: 'test', size: 5 },
      prompt: 'Extract text',
      maxTokens: 256,
      temperature: 0,
      cache: false,
    });

    expect(JSON.parse(response.text)).toEqual({
      texts: [
        { text: '菜单中心', position: '10,10,100,30', confidence: 0.98 },
        { text: '比萨配料管理', position: '120,10,260,30', confidence: 0.96 },
        { text: '保存', position: '900,700,950,740', confidence: 0.95 },
      ],
      language: 'zh',
    });
    expect(response.duration).toBeGreaterThanOrEqual(0);

    await provider.unload();
    expect(provider.isLoaded()).toBe(false);
  });
});
