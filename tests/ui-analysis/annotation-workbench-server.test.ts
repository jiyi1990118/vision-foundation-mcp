import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAnnotationWorkbenchServer, type AnnotationWorkbenchServer } from '../../src/ui-analysis/annotation-workbench/server.js';
import { DRAFT_WARNING } from '../../src/ui-analysis/annotation-workbench/store.js';

const servers: AnnotationWorkbenchServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startServer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'annotation-workbench-server-'));
  const app = join(root, 'app');
  await mkdir(app);
  await writeFile(join(app, 'screen.png'), Buffer.from('png'));
  await writeFile(join(app, 'screen.json'), JSON.stringify({
    image: 'screen.png', imageSize: { width: 10, height: 20 },
    platform: 'app', theme: 'light', language: 'en', dpi: 'standard',
    elements: [{ id: 'page', type: 'page', bbox: { x: 0, y: 0, w: 10, h: 20 }, render: 'native' }],
    relations: [], zOrder: [], warnings: [DRAFT_WARNING],
  }));
  await writeFile(join(app, 'screen.json.ai-review.json'), JSON.stringify({
    source: 'current-multimodal-model', status: 'AI 初审建议，必须人工确认', proposals: [],
  }));
  const server = await createAnnotationWorkbenchServer(root);
  servers.push(server);
  await server.listen(0);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('annotation workbench server', () => {
  it('returns entries and rejects invalid annotation writes', async () => {
    const base = await startServer();
    const dataset = await fetch(`${base}/api/dataset`);
    expect(dataset.status).toBe(200);
    await expect(dataset.json()).resolves.toEqual({ entries: [expect.objectContaining({ reviewed: false })] });

    const invalid = await fetch(`${base}/api/annotation?file=app%2Fscreen.json`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(invalid.status).toBe(400);
  });

  it('serves AI pre-review proposals separately from annotations', async () => {
    const base = await startServer();
    const response = await fetch(`${base}/api/ai-review?file=app%2Fscreen.json`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      source: 'current-multimodal-model',
    }));
  });

  it('serves tree-based structural issues separately from review differences', async () => {
    const base = await startServer();
    const response = await fetch(`${base}/api/structure-issues?file=app%2Fscreen.json`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.any(Array));
  });


  it('serves the page and blocks image path traversal', async () => {
    const base = await startServer();
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/fixes.css`)).status).toBe(200);
    expect((await fetch(`${base}/images/..%2Fsecret.png`)).status).toBe(403);
  });

  it('returns a review report and restores the immutable draft snapshot', async () => {
    const base = await startServer();
    const original = await (await fetch(`${base}/api/annotation?file=app%2Fscreen.json`)).json();
    original.elements[0].type = 'section';
    expect((await fetch(`${base}/api/annotation?file=app%2Fscreen.json`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(original),
    })).status).toBe(200);

    expect((await fetch(`${base}/api/prediction?file=app%2Fscreen.json`)).status).toBe(200);
    expect((await fetch(`${base}/api/review?file=app%2Fscreen.json`)).status).toBe(200);
    expect((await fetch(`${base}/api/restore-draft?file=app%2Fscreen.json`, { method: 'POST' })).status).toBe(200);
    const restored = await (await fetch(`${base}/api/annotation?file=app%2Fscreen.json`)).json();
    expect(restored.elements[0].type).toBe('page');
    expect(restored.warnings).toContain(DRAFT_WARNING);
  });

  it('previews differences against an existing prediction snapshot without writing', async () => {
    const base = await startServer();
    const annotation = await (await fetch(`${base}/api/annotation?file=app%2Fscreen.json`)).json();
    annotation.elements[0].type = 'section';
    await fetch(`${base}/api/annotation?file=app%2Fscreen.json`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(annotation),
    });
    annotation.elements[0].type = 'card';
    const preview = await fetch(`${base}/api/review-preview?file=app%2Fscreen.json`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(annotation),
    });
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toEqual(expect.objectContaining({
      differences: [expect.objectContaining({ category: 'wrong_type' })],
    }));
  });
});
