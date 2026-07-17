import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { detectAnnotations, resolveColorName } from '../src/core/annotation-detector.js';
import type { ImageInput } from '../src/types/domain.js';

async function makeRedBoxImage(): Promise<ImageInput> {
  const width = 240;
  const height = 160;
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="white"/>
      <rect x="50" y="40" width="120" height="70" fill="none" stroke="rgb(230,0,0)" stroke-width="4"/>
    </svg>
  `;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, mimeType: 'image/png', source: 'synthetic-red-box', size: buffer.length };
}

async function makeDashedRedBoxImage(): Promise<ImageInput> {
  const width = 320;
  const height = 220;
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="white"/>
      <rect x="55" y="45" width="210" height="120" fill="none" stroke="rgb(230,0,0)" stroke-width="3" stroke-dasharray="12 8"/>
    </svg>
  `;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, mimeType: 'image/png', source: 'synthetic-dashed-red-box', size: buffer.length };
}

async function makeDashedRedBoxWithSmallRedNoiseImage(): Promise<ImageInput> {
  const width = 420;
  const height = 260;
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="white"/>
      <rect x="110" y="60" width="230" height="140" fill="none" stroke="rgb(230,0,0)" stroke-width="3" stroke-dasharray="12 8"/>
      <rect x="40" y="35" width="24" height="22" fill="none" stroke="rgb(230,0,0)" stroke-width="3"/>
      <rect x="360" y="38" width="24" height="22" fill="none" stroke="rgb(230,0,0)" stroke-width="3"/>
    </svg>
  `;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, mimeType: 'image/png', source: 'synthetic-dashed-red-box-with-noise', size: buffer.length };
}

describe('annotation detector', () => {
  it('detects red rectangle annotations and links OCR text inside and nearby', async () => {
    const image = await makeRedBoxImage();
    const annotations = await detectAnnotations(image, {
      texts: [
        { text: '重点字段', position: '80,60,130,80' },
        { text: '旁边说明', position: '172,45,220,65' },
        { text: '远处文本', position: '10,130,60,150' },
      ],
    });

    expect(annotations.redBoxes).toHaveLength(1);
    expect(annotations.redBoxes[0]?.box).toMatch(/^\d+,\d+,\d+,\d+$/);
    expect(annotations.redBoxes[0]?.insideText).toEqual(expect.arrayContaining(['重点字段']));
    expect(annotations.redBoxes[0]?.nearbyText).toEqual(expect.arrayContaining(['旁边说明']));
    expect(annotations.redBoxes[0]?.nearbyText).not.toEqual(expect.arrayContaining(['远处文本']));
  });

  it('merges dashed red rectangle segments into one large annotation box', async () => {
    const image = await makeDashedRedBoxImage();
    const annotations = await detectAnnotations(image, {
      texts: [
        { text: '框内内容', position: '120,90,180,115' },
        { text: '框外内容', position: '10,185,80,205' },
      ],
    });

    expect(annotations.redBoxes).toHaveLength(1);
    const [x1, y1, x2, y2] = annotations.redBoxes[0]!.box.split(',').map(Number);
    expect(x1).toBeLessThanOrEqual(60);
    expect(y1).toBeLessThanOrEqual(50);
    expect(x2).toBeGreaterThanOrEqual(260);
    expect(y2).toBeGreaterThanOrEqual(160);
    expect(annotations.redBoxes[0]?.insideText).toEqual(expect.arrayContaining(['框内内容']));
    expect(annotations.redBoxes[0]?.insideText).not.toEqual(expect.arrayContaining(['框外内容']));
  });

  it('prioritizes large dashed red annotations and filters small red UI noise', async () => {
    const image = await makeDashedRedBoxWithSmallRedNoiseImage();
    const annotations = await detectAnnotations(image, {
      texts: [
        { text: '重点配置', position: '190,110,250,135' },
        { text: '小图标文字', position: '30,65,80,85' },
      ],
    });

    expect(annotations.redBoxes).toHaveLength(1);
    const [x1, y1, x2, y2] = annotations.redBoxes[0]!.box.split(',').map(Number);
    expect(x1).toBeLessThanOrEqual(115);
    expect(y1).toBeLessThanOrEqual(65);
    expect(x2).toBeGreaterThanOrEqual(335);
    expect(y2).toBeGreaterThanOrEqual(195);
    expect(annotations.redBoxes[0]?.insideText).toEqual(expect.arrayContaining(['重点配置']));
    expect(annotations.redBoxes[0]?.insideText).not.toEqual(expect.arrayContaining(['小图标文字']));
  });

  it('preserves all OCR lines inside a large dashed red annotation range', async () => {
    const image = await makeDashedRedBoxImage();
    const annotations = await detectAnnotations(image, {
      texts: [
        { text: '第1行', position: '120,60,175,75' },
        { text: '第2行', position: '120,76,175,91' },
        { text: '第3行', position: '120,92,175,107' },
        { text: '0.00', position: '120,108,175,123' },
        { text: '0.00', position: '120,124,175,139' },
        { text: '第6行', position: '120,140,175,155' },
        { text: '框外内容', position: '10,185,80,205' },
      ],
    });

    expect(annotations.redBoxes).toHaveLength(1);
    expect(annotations.redBoxes[0]?.insideTextLines).toEqual([
      '第1行',
      '第2行',
      '第3行',
      '0.00',
      '0.00',
      '第6行',
    ]);
    expect(annotations.redBoxes[0]?.insideText).toEqual(expect.arrayContaining(['第1行', '0.00', '第6行']));
  });

  it('does not include adjacent table headers that only touch the red annotation edge', async () => {
    const image = await makeDashedRedBoxImage();
    const annotations = await detectAnnotations(image, {
      texts: [
        { text: '左侧框外表头', position: '10,90,60,110' },
        { text: '边缘框外表头', position: '10,90,58,110' },
        { text: '框内列标题', position: '80,90,145,110' },
        { text: '框内数值', position: '145,120,200,140' },
      ],
    });

    expect(annotations.redBoxes).toHaveLength(1);
    expect(annotations.redBoxes[0]?.insideTextLines).toEqual(['框内列标题', '框内数值']);
    expect(annotations.redBoxes[0]?.insideText).not.toEqual(expect.arrayContaining(['边缘框外表头']));
  });
});

describe('multi-color annotation detection', () => {
  it('detects blue annotation boxes', async () => {
    const svg = `
      <svg width="240" height="160" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="white"/>
        <rect x="50" y="40" width="120" height="70" fill="none" stroke="rgb(0,0,230)" stroke-width="4"/>
      </svg>
    `;
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
    const image: ImageInput = { buffer, mimeType: 'image/png', source: 'blue-box', size: buffer.length };

    const annotations = await detectAnnotations(image, {
      texts: [
        { text: '蓝框内容', position: '60,50,110,70' },
      ],
    });

    expect(annotations.coloredBoxes).toBeDefined();
    const blueBoxes = annotations.coloredBoxes!.filter((b) => b.color === 'blue');
    expect(blueBoxes.length).toBeGreaterThanOrEqual(1);
    expect(blueBoxes[0]?.insideText).toEqual(expect.arrayContaining(['蓝框内容']));
    // Red boxes should not be detected for a blue-only image.
    expect(annotations.redBoxes).toHaveLength(0);
  });

  it('detects both red and green boxes in the same image', async () => {
    const svg = `
      <svg width="400" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="white"/>
        <rect x="30" y="30" width="120" height="80" fill="none" stroke="rgb(230,0,0)" stroke-width="4"/>
        <rect x="220" y="30" width="120" height="80" fill="none" stroke="rgb(0,200,0)" stroke-width="4"/>
      </svg>
    `;
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
    const image: ImageInput = { buffer, mimeType: 'image/png', source: 'multi-color', size: buffer.length };

    const annotations = await detectAnnotations(image, {
      texts: [
        { text: '红色区域', position: '40,40,100,70' },
        { text: '绿色区域', position: '230,40,300,70' },
      ],
    });

    expect(annotations.coloredBoxes).toBeDefined();
    const colors = annotations.coloredBoxes!.map((b) => b.color);
    expect(colors).toContain('red');
    expect(colors).toContain('green');
  });

  it('resolveColorName maps user aliases to canonical names', () => {
    expect(resolveColorName('red')).toBe('red');
    expect(resolveColorName('红色')).toBe('red');
    expect(resolveColorName('蓝')).toBe('blue');
    expect(resolveColorName('BLUE')).toBe('blue');
    expect(resolveColorName('黄框')).toBe('yellow');
    expect(resolveColorName('purple')).toBe('magenta');
    expect(resolveColorName(undefined)).toBeUndefined();
    expect(resolveColorName('unknown')).toBeUndefined();
  });

  it('splits two stacked dashed red boxes sharing the same vertical sides', async () => {
    // Two dashed red boxes stacked vertically, same x-range, connected by
    // shared dashed vertical sides. Dilation merges them into one connected
    // component; the splitter must separate them at the horizontal gap.
    const svg = `
      <svg width="300" height="300" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="white"/>
        <rect x="50" y="30" width="200" height="80" fill="none" stroke="rgb(230,0,0)" stroke-width="3" stroke-dasharray="10 6"/>
        <rect x="50" y="160" width="200" height="80" fill="none" stroke="rgb(230,0,0)" stroke-width="3" stroke-dasharray="10 6"/>
      </svg>
    `;
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
    const image: ImageInput = { buffer, mimeType: 'image/png', source: 'two-stacked', size: buffer.length };

    const annotations = await detectAnnotations(image, {
      texts: [
        { text: '上框内容', position: '60,40,120,70' },
        { text: '下框内容', position: '60,170,120,200' },
      ],
    });

    // Should detect 2 separate boxes, not 1 merged box.
    expect(annotations.redBoxes).toHaveLength(2);
    const boxes = annotations.redBoxes.map((b) => b.box);
    // Top box should be in the upper half, bottom box in the lower half.
    const topBox = boxes.find((b) => Number(b.split(',')[1]) < 100);
    const bottomBox = boxes.find((b) => Number(b.split(',')[1]) >= 100);
    expect(topBox).toBeDefined();
    expect(bottomBox).toBeDefined();
  });

  it('filters out filled blue UI elements (buttons, backgrounds)', async () => {
    // A filled blue rectangle (like a button or selected menu item) should
    // NOT be detected as an annotation box - it has high fill ratio.
    const svg = `
      <svg width="300" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="white"/>
        <rect x="50" y="40" width="100" height="30" fill="rgb(0,80,200)" stroke="none"/>
        <rect x="50" y="100" width="200" height="120" fill="none" stroke="rgb(230,0,0)" stroke-width="3"/>
      </svg>
    `;
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
    const image: ImageInput = { buffer, mimeType: 'image/png', source: 'mixed-ui-annotation', size: buffer.length };

    const annotations = await detectAnnotations(image, undefined);

    // Should detect the red outline box, but NOT the blue filled button.
    const redBoxes = annotations.coloredBoxes?.filter((b) => b.color === 'red') ?? [];
    const blueBoxes = annotations.coloredBoxes?.filter((b) => b.color === 'blue') ?? [];
    expect(redBoxes).toHaveLength(1);
    expect(blueBoxes).toHaveLength(0);
  });
});
