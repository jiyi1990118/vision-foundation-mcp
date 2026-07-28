import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AnnotationWorkbenchStore,
  DRAFT_WARNING,
  REVIEW_WARNING,
} from '../../src/ui-analysis/annotation-workbench/store.js';

async function makeDataset(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'annotation-workbench-'));
  const app = join(root, 'app');
  await mkdir(app);
  await writeFile(join(app, 'screen.png'), Buffer.from('png'));
  await writeFile(join(app, 'screen.json'), JSON.stringify({
    image: 'screen.png',
    imageSize: { width: 100, height: 200 },
    platform: 'app',
    theme: 'light',
    language: 'en',
    dpi: 'standard',
    elements: [{ id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 100, h: 200 }, render: 'native' }],
    relations: [],
    zOrder: [],
    warnings: [DRAFT_WARNING],
  }));
  return root;
}

describe('AnnotationWorkbenchStore', () => {
  it('lists paired entries and reports unreviewed drafts', async () => {
    const store = new AnnotationWorkbenchStore(await makeDataset());
    await expect(store.listEntries()).resolves.toEqual([expect.objectContaining({
      annotationPath: 'app/screen.json',
      imagePath: 'app/screen.png',
      reviewed: false,
    })]);
  });

  it('does not list AI review sidecars as independent annotations', async () => {
    const root = await makeDataset();
    await writeFile(join(root, 'app', 'screen.json.ai-review.json'), JSON.stringify({
      image: 'screen.png', imageSize: { width: 100, height: 200 }, platform: 'app', theme: 'light', language: 'en', dpi: 'standard',
      elements: [], relations: [], zOrder: [], warnings: ['AI preliminary review - requires human verification'],
    }));
    const store = new AnnotationWorkbenchStore(root);
    await expect(store.listEntries()).resolves.toHaveLength(1);
  });

  it('reads AI review proposals without treating them as annotations', async () => {
    const root = await makeDataset();
    await writeFile(join(root, 'app', 'screen.json.ai-review.json'), JSON.stringify({
      source: 'current-multimodal-model', status: 'AI 初审建议，必须人工确认',
      proposals: [{ kind: 'add', type: 'input', bbox: { x: 1, y: 2, w: 3, h: 4 }, note: '补充输入框' }],
    }));
    const store = new AnnotationWorkbenchStore(root);
    await expect(store.readAiReview('app/screen.json')).resolves.toEqual(expect.objectContaining({
      source: 'current-multimodal-model', proposals: [expect.objectContaining({ type: 'input' })],
    }));
  });

  it('rejects paths outside the dataset root', async () => {
    const store = new AnnotationWorkbenchStore(await makeDataset());
    await expect(store.readAnnotation('../outside.json')).rejects.toThrow('outside dataset root');
  });

  it('backs up draft content and marks a saved annotation as reviewed', async () => {
    const root = await makeDataset();
    const store = new AnnotationWorkbenchStore(root);
    const annotation = await store.readAnnotation('app/screen.json');
    annotation.elements[0]!.type = 'section';

    await store.saveAnnotation('app/screen.json', annotation);

    const saved = JSON.parse(await readFile(join(root, 'app/screen.json'), 'utf-8'));
    expect(saved.elements[0].type).toBe('section');
    expect(saved.warnings).toContain(REVIEW_WARNING);
    expect(saved.warnings).not.toContain(DRAFT_WARNING);
    await expect(readFile(join(root, 'app/screen.json.bak'), 'utf-8')).resolves.toContain(DRAFT_WARNING);
    await expect(readFile(join(root, 'app/screen.json.prediction.json'), 'utf-8')).resolves.toContain(DRAFT_WARNING);
    await expect(readFile(join(root, 'app/screen.json.review.json'), 'utf-8')).resolves.toContain('wrong_type');
  });
});
