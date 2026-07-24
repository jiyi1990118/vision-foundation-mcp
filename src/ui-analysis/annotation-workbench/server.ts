import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AnnotationWorkbenchStore } from './store.js';
import type { AnnotationFile } from '../benchmark/annotation-loader.js';
import type { ReviewAction } from './review-types.js';

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'static');

const STATIC_FILES: Record<string, { file: string; contentType: string }> = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
  '/clipboard.js': { file: 'clipboard.js', contentType: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', contentType: 'text/css; charset=utf-8' },
  '/fixes.css': { file: 'fixes.css', contentType: 'text/css; charset=utf-8' },
};

export interface AnnotationWorkbenchServer {
  listen(port: number): Promise<void>;
  close(): Promise<void>;
  address(): AddressInfo | string | null;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf-8');
  if (text.length === 0) throw new Error('request body is required');
  return JSON.parse(text);
}

function imageContentType(path: string): string {
  return /\.png$/i.test(path) ? 'image/png' : 'image/jpeg';
}

function errorStatus(error: unknown): number {
  const message = String(error);
  if (message.includes('outside dataset root')) return 403;
  if (message.includes('ENOENT')) return 404;
  if (message.includes('annotation ') || message.includes('request body') || message.includes('Unexpected token')) return 400;
  return 500;
}

export async function createAnnotationWorkbenchServer(datasetDir: string): Promise<AnnotationWorkbenchServer> {
  const store = new AnnotationWorkbenchStore(datasetDir);
  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;

      if (request.method === 'GET' && pathname === '/api/dataset') {
        sendJson(response, 200, { entries: await store.listEntries() });
        return;
      }

      if (pathname === '/api/annotation') {
        const file = url.searchParams.get('file');
        if (!file) {
          sendJson(response, 400, { error: 'file query parameter is required' });
          return;
        }
        if (request.method === 'GET') {
          sendJson(response, 200, await store.readAnnotation(file));
          return;
        }
        if (request.method === 'PUT') {
          await store.saveAnnotation(file, await readJsonBody(request) as never);
          sendJson(response, 200, { ok: true });
          return;
        }
      }

      if (pathname === '/api/prediction' || pathname === '/api/review' || pathname === '/api/ai-review' || pathname === '/api/structure-issues' || pathname === '/api/structure-validation' || pathname === '/api/review-session' || pathname === '/api/review-preview' || pathname === '/api/restore-draft') {
        const file = url.searchParams.get('file');
        if (!file) {
          sendJson(response, 400, { error: 'file query parameter is required' });
          return;
        }
        if (request.method === 'GET' && pathname === '/api/prediction') {
          sendJson(response, 200, await store.readPrediction(file));
          return;
        }
        if (request.method === 'GET' && pathname === '/api/review') {
          sendJson(response, 200, await store.readReview(file));
          return;
        }
        if (request.method === 'GET' && pathname === '/api/ai-review') {
          sendJson(response, 200, await store.readAiReview(file));
          return;
        }
        if (request.method === 'GET' && pathname === '/api/structure-issues') {
          sendJson(response, 200, await store.analyzeStructure(file));
          return;
        }
        if (request.method === 'GET' && pathname === '/api/structure-validation') {
          sendJson(response, 200, await store.validateAnnotationFile(file));
          return;
        }
        if (request.method === 'GET' && pathname === '/api/review-session') {
          sendJson(response, 200, await store.readReviewSession(file));
          return;
        }
        if (request.method === 'POST' && pathname === '/api/review-session') {
          const body = await readJsonBody(request) as ReviewAction;
          sendJson(response, 200, await store.saveReviewAction(file, body));
          return;
        }
        if (request.method === 'POST' && pathname === '/api/review-preview') {
          const body = await readJsonBody(request) as AnnotationFile | { annotation: AnnotationFile; prediction?: AnnotationFile };
          const annotation = 'annotation' in body ? body.annotation : body;
          const prediction = 'annotation' in body ? body.prediction : undefined;
          sendJson(response, 200, await store.previewReview(file, annotation, prediction));
          return;
        }
        if (request.method === 'POST' && pathname === '/api/restore-draft') {
          await store.restoreDraft(file);
          sendJson(response, 200, { ok: true });
          return;
        }
      }

      if (request.method === 'GET' && pathname.startsWith('/images/')) {
        const file = decodeURIComponent(pathname.slice('/images/'.length));
        const image = await store.readImage(file);
        response.writeHead(200, { 'content-type': imageContentType(file) });
        response.end(image);
        return;
      }

      if (request.method === 'GET' && STATIC_FILES[pathname] !== undefined) {
        const resource = STATIC_FILES[pathname]!;
        response.writeHead(200, { 'content-type': resource.contentType });
        response.end(await readFile(join(STATIC_DIR, resource.file)));
        return;
      }

      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      sendJson(response, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return {
    listen: (port) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    address: () => server.address(),
  };
}
