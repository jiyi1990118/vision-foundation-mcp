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

function ocrUiResults(summary = '菜单中心\n图片：\nedonner\nA 首页'): SkillResultSet {
  return {
    classify: { skill: 'classify', success: true, data: { category: 'document', confidence: 0.7 }, duration: 100 },
    summary: { skill: 'summary', success: true, data: { description: summary }, duration: 100 },
    ocr: {
      skill: 'ocr',
      success: true,
      data: {
        texts: [
          { text: '菜单中心', position: '80,25,244,63', confidence: 0.99 },
          { text: 'A 首页', position: '68,110,150,140', confidence: 0.98 },
          { text: '基础数据配置', position: '60,160,210,190', confidence: 0.98 },
          { text: '商品标签分类配置', position: '60,200,260,230', confidence: 0.98 },
          { text: 'POS分类管理', position: '60,260,210,290', confidence: 0.98 },
          { text: '比萨配料管理', position: '60,360,220,390', confidence: 0.98 },
          { text: '尺寸名称(中文)', position: '330,210,470,240', confidence: 0.96 },
          { text: '默认基础价(元)', position: '500,210,650,240', confidence: 0.96 },
          { text: '默认附加价(元)', position: '680,210,830,240', confidence: 0.96 },
          { text: '价格(元)', position: '860,210,950,240', confidence: 0.96 },
          { text: '0.00', position: '860,260,950,290', confidence: 0.96 },
          { text: '操作', position: '1000,210,1060,240', confidence: 0.96 },
          { text: '编辑', position: '1000,260,1050,290', confidence: 0.96 },
          { text: '详情', position: '1060,260,1110,290', confidence: 0.96 },
          { text: '停用', position: '1120,260,1170,290', confidence: 0.96 },
          { text: '取消', position: '900,700,960,730', confidence: 0.96 },
          { text: '保存', position: '980,700,1040,730', confidence: 0.96 },
        ],
        language: 'zh',
      },
      duration: 100,
    },
  };
}

function mobileProductDetailResults(summary = '详情\n经典手拍／9”\n双拼D'): SkillResultSet {
  return {
    classify: { skill: 'classify', success: true, data: { category: 'document', confidence: 0.7 }, duration: 100 },
    summary: { skill: 'summary', success: true, data: { description: summary }, duration: 100 },
    ocr: {
      skill: 'ocr',
      success: true,
      data: {
        texts: [
          { text: '18:13', position: '99,46,206,76', confidence: 0.99 },
          { text: '详情', position: '326,113,399,152', confidence: 0.99 },
          { text: '经典手拍／9”', position: '269,260,468,307', confidence: 0.9 },
          { text: '金沙咸蛋黄嫩鸡', position: '509,431,656,454', confidence: 0.99 },
          { text: '比萨', position: '505,455,560,487', confidence: 0.99 },
          { text: '夏威夷风情比萨', position: '34,540,186,563', confidence: 0.99 },
          { text: '双拼D', position: '34,746,131,780', confidence: 0.99 },
          { text: '双拼D', position: '34,804,113,836', confidence: 0.99 },
          { text: '详情', position: '37,866,110,905', confidence: 0.99 },
          { text: '9"+经典手拍+夏威夷风情比萨(1/2)+金沙咸蛋黄嫩鸡', position: '43,937,661,960', confidence: 0.97 },
          { text: '比萨(1/2)', position: '41,973,151,998', confidence: 0.99 },
          { text: '变动配料：左：菠萝+1方形火腿片(去）右：黄桃(去）椰果+1', position: '37,1058,680,1076', confidence: 0.93 },
        ],
        language: 'zh',
      },
      duration: 100,
    },
  };
}

describe('composeResult — post-classify heuristic', () => {
  it('adds top-level ocrText for OCR-only results', () => {
    const r = composeResult(
      {
        ocr: {
          skill: 'ocr',
          success: true,
          data: {
            texts: [
              { text: '菜单中心', position: '80,25,244,63', confidence: 0.99 },
              { text: 'POS分类管理', position: '67,496,239,533', confidence: 0.99 },
            ],
            language: 'zh',
          },
          duration: 100,
        },
      },
      'ppu-paddle-ocr', 'native-ocr', 1000,
    );

    expect(r.ocrText).toBe('菜单中心\nPOS分类管理');
  });

  it('corrects "document" → "illustration" when summary mentions drawn/art/sword render', () => {
    const r = composeResult(
      makeResults('document', 0.7, 'In this image we can see a sword with glowing runes and a red dragon.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('illustration');
    expect(r.confidence).toBe(0.75);
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

  it('corrects document to ui from Chinese OCR UI signals', () => {
    const r = composeResult(
      ocrUiResults(),
      'gguf-smolvlm2', 'llama-cpp', 1000,
    );

    expect(r.category).toBe('ui');
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
    expect(classifyData(r).category).toBe('ui');
    expect(classifyData(r).originalCategory).toBe('document');
  });

  it('uses OCR-driven UI summary when VLM only echoes OCR fragments', () => {
    const r = composeResult(
      ocrUiResults(),
      'gguf-smolvlm2', 'llama-cpp', 1000,
    );

    expect(r.summary).toContain('中文后台管理系统');
    expect(r.summary).toContain('左侧导航');
    expect(r.summary).toContain('比萨配料管理');
    expect(r.summary).toContain('操作包括');
    expect(r.summary).toContain('保存');
    expect(r.summary).not.toBe('菜单中心\n图片：\nedonner\nA 首页');
    expect(r.result.ui).toMatchObject({
      likelyPageType: 'admin-ui',
      rawTextCount: 17,
    });
  });

  it('uses mobile app summary for phone product detail screenshots, not admin UI wording', () => {
    const r = composeResult(
      mobileProductDetailResults(),
      'gguf-smolvlm2', 'llama-cpp', 1000,
    );

    expect(r.category).toBe('ui');
    expect(r.summary).toContain('移动端应用页面');
    expect(r.summary).toContain('页面标题为详情');
    expect(r.summary).toContain('双拼D');
    expect(r.summary).toContain('变动配料');
    expect(r.summary).not.toContain('中文后台管理系统');
    expect(r.summary).not.toContain('左侧导航');
    expect(r.result.ui).toMatchObject({
      likelyPageType: 'mobile-ui',
      rawTextCount: 12,
    });
  });

  it('keeps full ocrText while exposing LLM-friendly UI sections', () => {
    const r = composeResult(
      ocrUiResults(),
      'gguf-smolvlm2', 'llama-cpp', 1000,
    );

    const ui = r.result.ui as Record<string, unknown>;
    expect(r.ocrText).toContain('菜单中心');
    expect(r.ocrText).toContain('比萨配料管理');
    expect(r.ocrText).toContain('保存');
    expect(ui.navigation).toEqual(expect.arrayContaining(['菜单中心', 'POS分类管理', '比萨配料管理']));
    expect(ui.tableHeaders).toEqual(expect.arrayContaining(['尺寸名称(中文)', '默认基础价(元)', '价格(元)', '操作']));
    expect(ui.actions).toEqual(expect.arrayContaining(['编辑', '详情', '停用', '取消', '保存']));
    expect(ui.values).toEqual(expect.arrayContaining(['0.00']));
  });

  it('uses OCR coordinates to expose a layout that separates sidebar, table, and footer actions', () => {
    const r = composeResult(
      ocrUiResults(),
      'gguf-smolvlm2', 'llama-cpp', 1000,
    );

    const layout = r.result.layout as Record<string, unknown>;
    const mainContent = layout.mainContent as Record<string, unknown>;
    expect(layout.leftSidebar).toEqual(expect.arrayContaining(['菜单中心', 'POS分类管理', '比萨配料管理']));
    expect(layout.footerActions).toEqual(expect.arrayContaining(['取消', '保存']));
    expect(mainContent.tableHeaders).toEqual(expect.arrayContaining(['尺寸名称(中文)', '默认基础价(元)', '价格(元)', '操作']));
    expect(mainContent.tableHeaders).not.toEqual(expect.arrayContaining(['POS分类管理']));
    expect(mainContent.rowValues).toEqual(expect.arrayContaining(['0.00']));
  });

  it('includes externally detected annotations in composed results', () => {
    const r = composeResult(
      ocrUiResults(),
      'gguf-smolvlm2', 'llama-cpp', 1000,
      {
        annotations: {
          redBoxes: [
            {
              box: '300,200,900,330',
              confidence: 0.9,
              insideText: ['尺寸名称(中文)', '0.00'],
              nearbyText: ['比萨配料管理'],
            },
          ],
        },
      },
    );

    expect(r.result.annotations).toMatchObject({
      redBoxes: [
        {
          box: '300,200,900,330',
          insideText: ['尺寸名称(中文)', '0.00'],
        },
      ],
    });
    expect(r.summary).toContain('红框标注区域');
  });

  it('adds precomputed targetExtraction for custom key-content requests', () => {
    const r = composeResult(
      ocrUiResults(),
      'gguf-smolvlm2', 'llama-cpp', 1000,
      {
        keyContentExtraction: {
          query: { color: 'red', position: 'right', description: '虚线红框中的内容' },
          matchedRegion: { type: 'redBox', box: '300,200,900,600', confidence: 0.9 },
          textLines: ['尺寸名称(中文)', '0.00', '0.00'],
          summary: '关键区域包含：尺寸名称(中文)；0.00；0.00。',
          warnings: [],
        },
        annotations: {
          redBoxes: [
            {
              box: '300,200,900,600',
              confidence: 0.9,
              insideText: ['尺寸名称(中文)', '0.00'],
              insideTextLines: ['尺寸名称(中文)', '0.00', '0.00'],
              nearbyText: ['比萨配料管理'],
            },
          ],
        },
      },
    );

    expect(r.result.targetExtraction).toMatchObject({
      query: { color: 'red', position: 'right', description: '虚线红框中的内容' },
      matchedRegion: {
        type: 'redBox',
        box: '300,200,900,600',
      },
      textLines: ['尺寸名称(中文)', '0.00', '0.00'],
    });
    expect(r.summary).toContain('关键区域包含');
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

  it('corrects "dashboard" → "illustration" when summary describes a cartoon animal character', () => {
    const r = composeResult(
      makeResults('dashboard', 0.7, 'A penguin character wearing a blue and white striped hat on a black background.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('illustration');
    expect(classifyData(r).category).toBe('illustration');
    expect(classifyData(r).originalCategory).toBe('dashboard');
  });

  it('corrects "other" → "illustration" when summary describes a cartoon science character', () => {
    const r = composeResult(
      makeResults('other', 0.3, 'A cartoon character in a white lab coat and glasses holding a flask and a test tube.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('illustration');
    expect(classifyData(r).category).toBe('illustration');
    expect(classifyData(r).originalCategory).toBe('other');
  });

  it('corrects "other" → "icon" when summary describes a single app icon', () => {
    const r = composeResult(
      makeResults('other', 0.3, 'A single app icon showing a rounded square with a simple white rocket glyph.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('icon');
    expect(classifyData(r).category).toBe('icon');
  });

  it('corrects "other" → "logo" when summary describes a brand logo mark', () => {
    const r = composeResult(
      makeResults('other', 0.3, 'A minimalist brand logo with the word Nova and a simple abstract mark.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('logo');
    expect(classifyData(r).category).toBe('logo');
  });

  it('corrects "other" → "poster" when summary describes an event flyer', () => {
    const r = composeResult(
      makeResults('other', 0.3, 'A concert poster flyer with large title text, date, venue, and colorful graphics.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('poster');
    expect(classifyData(r).category).toBe('poster');
  });

  it('corrects "other" → "comic" when summary describes comic panels and speech bubbles', () => {
    const r = composeResult(
      makeResults('other', 0.3, 'A comic strip with three panels and speech bubbles showing a short story.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('comic');
    expect(classifyData(r).category).toBe('comic');
  });

  it('corrects "other" → "meme" when summary describes meme text layout', () => {
    const r = composeResult(
      makeResults('other', 0.3, 'A meme image with large white top text and bottom text over a funny reaction photo.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('meme');
    expect(classifyData(r).category).toBe('meme');
  });

  it('corrects "other" → "map" when summary describes a geographic map', () => {
    const r = composeResult(
      makeResults('other', 0.3, 'A geographic map with roads, city labels, a river, and a route marker.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('map');
    expect(classifyData(r).category).toBe('map');
  });

  it('preserves high confidence when summary confirms a category with exclusion rules', () => {
    const r = composeResult(
      makeResults('document', 0.85, 'This is an invoice with itemized list of charges and a total at the bottom.'),
      'gguf-smolvlm', 'llama-cpp', 1000,
    );
    expect(r.category).toBe('document');
    expect(r.confidence).toBe(0.85);
    expect(classifyData(r).confidence).toBe(0.85);
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
