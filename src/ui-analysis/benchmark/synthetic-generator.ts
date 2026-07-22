import type { ImageInput } from '../../types/domain.js';
import type { BBox } from '../ir/types.js';

/** An ImageInput extended with pixel dimensions for benchmark bounds checking. */
export interface SyntheticImage extends ImageInput {
  width: number;
  height: number;
}

export interface SyntheticElement {
  id: string;
  type: string;
  bbox: BBox;
  text?: string;
  semanticRole?: string;
  fillColor?: [number, number, number];
}

export interface SyntheticAnnotation {
  elements: SyntheticElement[];
}

export interface SyntheticSample {
  image: SyntheticImage;
  annotation: SyntheticAnnotation;
  layoutType: string;
}

export type SyntheticLayoutType = 'login' | 'list' | 'dashboard' | 'form' | 'banner';

interface RGB {
  r: number;
  g: number;
  b: number;
}

function renderToBuffer(width: number, height: number, elements: SyntheticElement[]): Buffer {
  const stride = 4;
  const buf = Buffer.alloc(width * height * stride);
  // Fill with white background
  for (let i = 0; i < width * height; i++) {
    buf[i * stride] = 255;
    buf[i * stride + 1] = 255;
    buf[i * stride + 2] = 255;
    buf[i * stride + 3] = 255;
  }

  const fillRect = (bbox: BBox, color: RGB): void => {
    const x0 = Math.max(0, Math.floor(bbox.x));
    const y0 = Math.max(0, Math.floor(bbox.y));
    const x1 = Math.min(width, Math.ceil(bbox.x + bbox.w));
    const y1 = Math.min(height, Math.ceil(bbox.y + bbox.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * width + x) * stride;
        buf[idx] = color.r;
        buf[idx + 1] = color.g;
        buf[idx + 2] = color.b;
        buf[idx + 3] = 255;
      }
    }
  };

  for (const el of elements) {
    const color: RGB = el.fillColor
      ? { r: el.fillColor[0], g: el.fillColor[1], b: el.fillColor[2] }
      : { r: 240, g: 240, b: 240 };
    fillRect(el.bbox, color);
  }

  return buf;
}

function makeImage(
  width: number,
  height: number,
  buffer: Buffer,
  source: string,
): SyntheticImage {
  return {
    buffer,
    mimeType: 'image/png',
    source,
    size: buffer.length,
    width,
    height,
  };
}

function generateLogin(width: number, height: number): SyntheticSample {
  const elements: SyntheticElement[] = [];
  let id = 0;
  const nextId = (): string => `el-${++id}`;

  // Title
  elements.push({
    id: nextId(),
    type: 'title',
    bbox: { x: 75, y: 100, w: 225, h: 40 },
    text: 'Login',
    fillColor: [255, 255, 255],
  });

  // Username input
  elements.push({
    id: nextId(),
    type: 'input',
    bbox: { x: 50, y: 200, w: 275, h: 44 },
    fillColor: [245, 245, 245],
  });

  // Password input
  elements.push({
    id: nextId(),
    type: 'input',
    bbox: { x: 50, y: 260, w: 275, h: 44 },
    fillColor: [245, 245, 245],
  });

  // Login button
  elements.push({
    id: nextId(),
    type: 'button',
    bbox: { x: 50, y: 330, w: 275, h: 48 },
    text: 'Sign In',
    fillColor: [22, 119, 255],
  });

  // Checkbox + label
  elements.push({
    id: nextId(),
    type: 'checkbox',
    bbox: { x: 50, y: 400, w: 20, h: 20 },
    fillColor: [22, 119, 255],
  });
  elements.push({
    id: nextId(),
    type: 'text',
    bbox: { x: 80, y: 400, w: 150, h: 20 },
    text: 'Remember me',
    fillColor: [255, 255, 255],
  });

  const buffer = renderToBuffer(width, height, elements);
  return {
    image: makeImage(width, height, buffer, 'synthetic-login'),
    annotation: { elements },
    layoutType: 'login',
  };
}

function generateList(width: number, height: number): SyntheticSample {
  const elements: SyntheticElement[] = [];
  let id = 0;
  const nextId = (): string => `el-${++id}`;

  // Header
  elements.push({
    id: nextId(),
    type: 'header',
    bbox: { x: 0, y: 0, w: width, h: 60 },
    fillColor: [240, 240, 240],
  });
  elements.push({
    id: nextId(),
    type: 'title',
    bbox: { x: 20, y: 15, w: 200, h: 30 },
    text: 'Products',
    fillColor: [240, 240, 240],
  });

  // List items
  for (let i = 0; i < 5; i++) {
    const y = 80 + i * 100;
    elements.push({
      id: nextId(),
      type: 'listItem',
      bbox: { x: 10, y, w: width - 20, h: 90 },
      fillColor: [250, 250, 250],
    });
    // Item image
    elements.push({
      id: nextId(),
      type: 'image',
      bbox: { x: 20, y: y + 10, w: 60, h: 70 },
      fillColor: [200, 200, 200],
    });
    // Item title
    elements.push({
      id: nextId(),
      type: 'text',
      bbox: { x: 90, y: y + 15, w: 200, h: 20 },
      text: `Item ${i + 1}`,
      fillColor: [250, 250, 250],
    });
    // Item price
    elements.push({
      id: nextId(),
      type: 'text',
      bbox: { x: 90, y: y + 45, w: 100, h: 20 },
      text: `$${(i + 1) * 9.99}`,
      fillColor: [250, 250, 250],
    });
  }

  const buffer = renderToBuffer(width, height, elements);
  return {
    image: makeImage(width, height, buffer, 'synthetic-list'),
    annotation: { elements },
    layoutType: 'list',
  };
}

function generateDashboard(width: number, height: number): SyntheticSample {
  const elements: SyntheticElement[] = [];
  let id = 0;
  const nextId = (): string => `el-${++id}`;

  // Sidebar
  elements.push({
    id: nextId(),
    type: 'sidebar',
    bbox: { x: 0, y: 0, w: 80, h: height },
    fillColor: [50, 50, 50],
  });

  // Cards in grid
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      const x = 100 + col * 140;
      const y = 20 + row * 160;
      elements.push({
        id: nextId(),
        type: 'card',
        bbox: { x, y, w: 130, h: 150 },
        fillColor: [245, 245, 245],
      });
      elements.push({
        id: nextId(),
        type: 'text',
        bbox: { x: x + 10, y: y + 10, w: 110, h: 20 },
        text: 'Metric',
        fillColor: [245, 245, 245],
      });
      elements.push({
        id: nextId(),
        type: 'title',
        bbox: { x: x + 10, y: y + 40, w: 110, h: 30 },
        text: '1,234',
        fillColor: [245, 245, 245],
      });
    }
  }

  const buffer = renderToBuffer(width, height, elements);
  return {
    image: makeImage(width, height, buffer, 'synthetic-dashboard'),
    annotation: { elements },
    layoutType: 'dashboard',
  };
}

function generateForm(width: number, height: number): SyntheticSample {
  const elements: SyntheticElement[] = [];
  let id = 0;
  const nextId = (): string => `el-${++id}`;

  // Title
  elements.push({
    id: nextId(),
    type: 'title',
    bbox: { x: 50, y: 50, w: 275, h: 35 },
    text: 'Registration',
    fillColor: [255, 255, 255],
  });

  // Form fields
  const fields = [
    { label: 'Name', y: 120 },
    { label: 'Email', y: 200 },
    { label: 'Phone', y: 280 },
  ];
  for (const f of fields) {
    elements.push({
      id: nextId(),
      type: 'text',
      bbox: { x: 50, y: f.y, w: 100, h: 20 },
      text: f.label,
      semanticRole: 'label',
      fillColor: [255, 255, 255],
    });
    elements.push({
      id: nextId(),
      type: 'input',
      bbox: { x: 50, y: f.y + 25, w: 275, h: 40 },
      fillColor: [245, 245, 245],
    });
  }

  // Checkbox
  elements.push({
    id: nextId(),
    type: 'checkbox',
    bbox: { x: 50, y: 380, w: 20, h: 20 },
    fillColor: [22, 119, 255],
  });
  elements.push({
    id: nextId(),
    type: 'text',
    bbox: { x: 80, y: 380, w: 200, h: 20 },
    text: 'I agree to terms',
    fillColor: [255, 255, 255],
  });

  // Submit button
  elements.push({
    id: nextId(),
    type: 'button',
    bbox: { x: 50, y: 430, w: 275, h: 48 },
    text: 'Submit',
    fillColor: [22, 119, 255],
  });

  const buffer = renderToBuffer(width, height, elements);
  return {
    image: makeImage(width, height, buffer, 'synthetic-form'),
    annotation: { elements },
    layoutType: 'form',
  };
}

function generateBanner(width: number, height: number): SyntheticSample {
  const elements: SyntheticElement[] = [];
  let id = 0;
  const nextId = (): string => `el-${++id}`;

  // Banner section
  elements.push({
    id: nextId(),
    type: 'section',
    bbox: { x: 0, y: 0, w: width, h: 120 },
    semanticRole: 'banner',
    fillColor: [22, 119, 255],
  });

  // Banner title
  elements.push({
    id: nextId(),
    type: 'title',
    bbox: { x: 20, y: 20, w: 250, h: 30 },
    text: 'Summer Sale',
    fillColor: [22, 119, 255],
  });

  // Banner subtitle
  elements.push({
    id: nextId(),
    type: 'subtitle',
    bbox: { x: 20, y: 55, w: 200, h: 20 },
    text: 'Up to 50% off',
    fillColor: [22, 119, 255],
  });

  // Banner CTA button
  elements.push({
    id: nextId(),
    type: 'button',
    bbox: { x: 20, y: 85, w: 120, h: 30 },
    text: 'Shop Now',
    fillColor: [255, 255, 255],
  });

  // Below banner: some list items
  for (let i = 0; i < 3; i++) {
    const y = 140 + i * 100;
    elements.push({
      id: nextId(),
      type: 'listItem',
      bbox: { x: 10, y, w: width - 20, h: 90 },
      fillColor: [250, 250, 250],
    });
  }

  const buffer = renderToBuffer(width, height, elements);
  return {
    image: makeImage(width, height, buffer, 'synthetic-banner'),
    annotation: { elements },
    layoutType: 'banner',
  };
}

const GENERATORS: Record<SyntheticLayoutType, (w: number, h: number) => SyntheticSample> = {
  login: generateLogin,
  list: generateList,
  dashboard: generateDashboard,
  form: generateForm,
  banner: generateBanner,
};

export function generateSyntheticSample(
  type: SyntheticLayoutType,
  width: number,
  height: number,
): SyntheticSample {
  const gen = GENERATORS[type]!;
  return gen(width, height);
}

export interface SyntheticDataset {
  samples: SyntheticSample[];
}

export function generateSyntheticDataset(
  count: number,
  width: number,
  height: number,
): SyntheticDataset {
  const types: SyntheticLayoutType[] = ['login', 'list', 'dashboard', 'form', 'banner'];
  const samples: SyntheticSample[] = [];
  for (let i = 0; i < count; i++) {
    const type = types[i % types.length]!;
    samples.push(generateSyntheticSample(type, width, height));
  }
  return { samples };
}
