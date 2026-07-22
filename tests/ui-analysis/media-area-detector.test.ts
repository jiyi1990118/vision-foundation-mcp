import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { detectMediaAreasForAnalysis } from '../../src/ui-analysis/image-content/media-area-detector.js';
import type { OcrItem } from '../../src/core/key-content-extractor.js';
import type { ImageInput } from '../../src/types/domain.js';

async function makeImage(body: string, width = 400, height = 800): Promise<ImageInput> {
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    ${body}
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, mimeType: 'image/png', source: 'media-detector-test', size: buffer.length };
}

function iconShape(x: number, y: number): string {
  return `<rect x="${x}" y="${y}" width="18" height="18" rx="4" fill="none" stroke="#e24b4b" stroke-width="3"/>
    <path d="M${x + 4} ${y + 9}h10M${x + 9} ${y + 4}v10" stroke="#2a8cc9" stroke-width="3"/>`;
}

function mobileIconShape(x: number, y: number): string {
  return `<rect x="${x}" y="${y}" width="60" height="60" rx="14" fill="none" stroke="#e24b4b" stroke-width="10"/>
    <path d="M${x + 14} ${y + 30}h32M${x + 30} ${y + 14}v32" stroke="#2a8cc9" stroke-width="10"/>`;
}

function overlapArea(
  a: { x: number; y: number; w: number; h: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): number {
  return Math.max(0, Math.min(a.x + a.w, b.x2) - Math.max(a.x, b.x1))
    * Math.max(0, Math.min(a.y + a.h, b.y2) - Math.max(a.y, b.y1));
}

describe('detectMediaAreasForAnalysis', () => {
  it('rejects OCR text strokes while keeping a compact icon beside the label', async () => {
    const labelBox = { x1: 80, y1: 72, x2: 330, y2: 108 };
    const image = await makeImage(
      iconShape(30, 80)
        + '<path d="M85 80h220M85 92h190M85 104h230" stroke="#222" stroke-width="5"/>',
      400,
      180,
    );
    const ocr: OcrItem[] = [{ text: '我的订单和发票', box: labelBox, confidence: 0.99 }];

    const areas = await detectMediaAreasForAnalysis(image, ocr);
    expect(areas.some((area) => area.bbox.x < 70 && area.bbox.y < 130)).toBe(true);
    for (const area of areas) {
      expect(overlapArea(area.bbox, labelBox) / (area.bbox.w * area.bbox.h)).toBeLessThan(0.2);
    }
  });

  it('rejects a texture candidate that is substantially covered by lower-confidence OCR', async () => {
    const textBox = { x1: 20, y1: 40, x2: 250, y2: 80 };
    const image = await makeImage(
      '<path d="M20 45h210M20 57h190M20 69h220" stroke="#222" stroke-width="6"/>',
      400,
      140,
    );
    const ocr: OcrItem[] = [{ text: '返回上一页', box: textBox, confidence: 0.72 }];

    const areas = await detectMediaAreasForAnalysis(image, ocr);
    expect(areas.filter((area) => overlapArea(area.bbox, textBox) > 0)).toHaveLength(0);
  });

  it('uses high-confidence one-character OCR as a text veto', async () => {
    const textBox = { x1: 40, y1: 40, x2: 100, y2: 100 };
    const image = await makeImage(
      '<path d="M45 95L70 45L95 95M55 75h30" stroke="#222" stroke-width="8" fill="none"/>',
      180,
      140,
    );
    const ocr: OcrItem[] = [{ text: 'A', box: textBox, confidence: 0.99 }];

    const areas = await detectMediaAreasForAnalysis(image, ocr);
    expect(areas.filter((area) => overlapArea(area.bbox, textBox) > 0)).toHaveLength(0);
  });

  it('does not truncate candidates before downstream pixel filtering', async () => {
    const decorations: string[] = [];
    const ocr: OcrItem[] = [];
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 6; column++) {
        const x = 8 + column * 64;
        const y = 8 + row * 64;
        decorations.push(iconShape(x, y));
      }
    }
    const menu: string[] = [];
    for (let index = 0; index < 7; index++) {
      const y = 260 + index * 70;
      menu.push(iconShape(24, y));
      ocr.push({
        text: `菜单${index}`,
        box: { x1: 70, y1: y - 4, x2: 190, y2: y + 26 },
        confidence: 0.99,
      });
    }
    const image = await makeImage([...decorations, ...menu].join(''));

    const areas = await detectMediaAreasForAnalysis(image, ocr);
    const lower = areas.filter((area) => area.bbox.y >= 240);
    expect(areas.length).toBeGreaterThan(20);
    expect(lower.length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...lower.map((area) => area.bbox.y))).toBeGreaterThan(600);
  });

  it('removes long grid strips without OCR but keeps isolated two-dimensional icons', async () => {
    const image = await makeImage(
      '<path d="M20 40h340M20 50h340M20 60h340" stroke="#222" stroke-width="4"/>'
        + '<path d="M20 120h340M20 130h340M20 140h340" stroke="#222" stroke-width="4"/>'
        + iconShape(40, 220)
        + iconShape(300, 300),
      400,
      380,
    );

    const areas = await detectMediaAreasForAnalysis(image);
    expect(areas.some((area) => area.bbox.y >= 200 && area.bbox.x < 100)).toBe(true);
    expect(areas.some((area) => area.bbox.y >= 280 && area.bbox.x > 250)).toBe(true);
    expect(areas.every((area) => area.bbox.w / area.bbox.h < 4)).toBe(true);
    expect(areas.length).toBeLessThanOrEqual(3);
  });

  it('keeps vertically repeated mobile menu icons separated by OCR rows', async () => {
    const graphics: string[] = [];
    const ocr: OcrItem[] = [];
    for (let index = 0; index < 10; index++) {
      const y = 520 + index * 126;
      graphics.push(mobileIconShape(58, y));
      ocr.push({
        text: `菜单项目${index}`,
        box: { x1: 130, y1: y + 3, x2: 390, y2: y + 60 },
        confidence: 0.99,
      });
    }
    const image = await makeImage(graphics.join(''), 1200, 2670);

    const areas = await detectMediaAreasForAnalysis(image, ocr);
    const menuIcons = areas.filter((area) => (
      area.bbox.x < 150 && area.bbox.y >= 480 && area.bbox.y < 1800
    ));
    expect(menuIcons.length).toBeGreaterThanOrEqual(8);
    expect(new Set(menuIcons.map((area) => area.nearbyText)).size).toBeGreaterThanOrEqual(8);
  });

  it('keeps isolated genuine icons through the global detection channel', async () => {
    const graphics: string[] = [];
    const ocr: OcrItem[] = [];
    const positions = [
      { x: 90, y: 180 },
      { x: 510, y: 680 },
      { x: 930, y: 1180 },
    ];
    for (const [index, position] of positions.entries()) {
      graphics.push(mobileIconShape(position.x, position.y));
      ocr.push({
        text: `孤立文字${index}`,
        box: {
          x1: position.x + 72,
          y1: position.y,
          x2: position.x + 300,
          y2: position.y + 60,
        },
        confidence: 0.99,
      });
    }
    const image = await makeImage(graphics.join(''), 1200, 1800);

    const areas = await detectMediaAreasForAnalysis(image, ocr);
    expect(areas.filter((area) => (
      positions.some((position) => (
        Math.abs(area.bbox.x - position.x) <= 70
        && Math.abs(area.bbox.y - position.y) <= 70
      ))
    )).length).toBeGreaterThanOrEqual(3);
  });

  it('keeps a tall two-dimensional poster clipped by a drawer', async () => {
    const tiles: string[] = [
      '<rect x="825" y="330" width="350" height="2050" rx="24" fill="#521416" stroke="#e8b34a" stroke-width="18"/>',
    ];
    for (let row = 0; row < 14; row++) {
      for (let column = 0; column < 3; column++) {
        const x = 840 + column * 105;
        const y = 360 + row * 135;
        const fill = (row + column) % 2 === 0 ? '#d83932' : '#e8b34a';
        tiles.push(`<rect x="${x}" y="${y}" width="92" height="118" rx="18" fill="${fill}"/>`);
        tiles.push(`<circle cx="${x + 46}" cy="${y + 59}" r="30" fill="#293f4d"/>`);
      }
    }
    const image = await makeImage(tiles.join(''), 1200, 2670);

    const ocr: OcrItem[] = Array.from({ length: 10 }, (_, index) => ({
      text: `海报内嵌文案${index}`,
      box: {
        x1: 855,
        y1: 390 + index * 150,
        x2: 1160,
        y2: 470 + index * 150,
      },
      confidence: 0.99,
    }));
    ocr.push({
      text: '消息中心',
      box: { x1: 700, y1: 1650, x2: 760, y2: 1710 },
      confidence: 0.99,
    });
    const areas = await detectMediaAreasForAnalysis(image, ocr);
    const poster = areas.find((area) => (
      area.bbox.x >= 780
      && area.bbox.w >= 300
      && area.bbox.h >= 1500
    ));
    expect(poster).toBeDefined();
    expect(poster?.nearbyText).toBeUndefined();
  });

  it('extracts a compact high-texture avatar from a connected decorative header', async () => {
    const texture = Array.from({ length: 8 }, (_, row) => (
      Array.from({ length: 8 }, (_, column) => (
        `<rect x="${60 + column * 8}" y="${70 + row * 8}" width="8" height="8" fill="${(row + column) % 2 === 0 ? '#f2cf74' : '#24445a'}"/>`
      )).join('')
    )).join('');
    const image = await makeImage(
      '<rect x="0" y="40" width="400" height="100" fill="#e6343d"/>'
        + '<path d="M0 55h400M0 85h400M0 115h400" stroke="#f05a60" stroke-width="8"/>'
        + texture,
      400,
      300,
    );
    const ocr: OcrItem[] = [{
      text: '用户名称',
      box: { x1: 55, y1: 115, x2: 145, y2: 150 },
      confidence: 0.99,
    }];

    const areas = await detectMediaAreasForAnalysis(image, ocr);
    expect(areas.some((area) => (
      area.bbox.x <= 70
      && area.bbox.y <= 80
      && area.bbox.x + area.bbox.w >= 120
      && area.bbox.y + area.bbox.h >= 125
      && area.bbox.w <= 100
      && area.bbox.h <= 100
    ))).toBe(true);
  });

  it('drops a texture box that only groups multiple OCR rows', async () => {
    const image = await makeImage(
      '<rect x="20" y="60" width="260" height="50" rx="20" fill="#f2f2f2"/>'
        + '<circle cx="45" cy="85" r="15" fill="#d9343b"/>'
        + '<path d="M70 75h180M70 95h160" stroke="#222" stroke-width="7"/>'
        + '<rect x="20" y="125" width="300" height="50" rx="20" fill="#f2f2f2"/>'
        + '<circle cx="45" cy="150" r="15" fill="#d9343b"/>'
        + '<path d="M70 140h220M70 160h180" stroke="#222" stroke-width="7"/>',
      400,
      240,
    );
    const ocr: OcrItem[] = [
      { text: '在线客服', box: { x1: 70, y1: 70, x2: 250, y2: 105 }, confidence: 0.99 },
      { text: '电话客服 4001597597', box: { x1: 70, y1: 135, x2: 310, y2: 170 }, confidence: 0.99 },
    ];

    const areas = await detectMediaAreasForAnalysis(image, ocr);
    expect(areas.every((area) => area.bbox.w < 160 || area.bbox.h < 80)).toBe(true);
  });
});
