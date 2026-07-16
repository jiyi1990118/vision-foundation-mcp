import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import { classifyVisionError } from '../src/tools/vision-analyze.js';
import {
  ensureGGUFModel,
  GGUF_MODEL_FILE,
  GGUF_MMPROJ_FILE,
  ensureMiniCPMModel,
  MINICPM_MODEL_FILE,
  MINICPM_MMPROJ_FILE,
  ensureSmolVLM2Model,
  SMOLVLM2_MODEL_FILE,
  SMOLVLM2_MMPROJ_FILE,
} from '../src/core/model-manager.js';

const ORIGINAL_VERIFY = process.env.VISION_VERIFY_CHECKSUMS;

afterEach(() => {
  if (ORIGINAL_VERIFY === undefined) {
    delete process.env.VISION_VERIFY_CHECKSUMS;
  } else {
    process.env.VISION_VERIFY_CHECKSUMS = ORIGINAL_VERIFY;
  }
});

function response(body: string, ok = true, status = 200): Response {
  return new Response(body, { status, statusText: ok ? 'OK' : 'Failed' });
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('GGUF model manager', () => {
  it('returns existing GGUF model paths without downloading', async () => {
    const modelDir = await mkdtemp(join(tmpdir(), 'vision-model-existing-'));
    const modelPath = join(modelDir, GGUF_MODEL_FILE);
    const mmprojPath = join(modelDir, GGUF_MMPROJ_FILE);
    await writeFile(modelPath, 'model');
    await writeFile(mmprojPath, 'mmproj');
    let fetchCalls = 0;

    const result = await ensureGGUFModel({
      modelDir,
      fetchFn: async () => {
        fetchCalls++;
        return response('unused');
      },
    });

    expect(result).toEqual({ modelPath, mmprojPath });
    expect(fetchCalls).toBe(0);
  });

  it('downloads missing GGUF files to final paths', async () => {
    const modelDir = await mkdtemp(join(tmpdir(), 'vision-model-download-'));
    const bodies: Record<string, string> = {
      [GGUF_MODEL_FILE]: 'model-bytes',
      [GGUF_MMPROJ_FILE]: 'mmproj-bytes',
    };

    const result = await ensureGGUFModel({
      modelDir,
      baseUrl: 'https://example.test',
      fetchFn: async (url) => {
        const file = String(url).split('/').pop() ?? '';
        return response(bodies[file] ?? '', true);
      },
    });

    await expect(readFile(result.modelPath, 'utf8')).resolves.toBe('model-bytes');
    await expect(readFile(result.mmprojPath, 'utf8')).resolves.toBe('mmproj-bytes');
  });

  it('writes .meta.json sidecar with SHA-256 after download', async () => {
    const modelDir = await mkdtemp(join(tmpdir(), 'vision-model-meta-'));
    const modelBody = 'model-bytes';
    const mmprojBody = 'mmproj-bytes';
    const bodies: Record<string, string> = {
      [GGUF_MODEL_FILE]: modelBody,
      [GGUF_MMPROJ_FILE]: mmprojBody,
    };

    const result = await ensureGGUFModel({
      modelDir,
      baseUrl: 'https://example.test',
      fetchFn: async (url) => {
        const file = String(url).split('/').pop() ?? '';
        return response(bodies[file] ?? '', true);
      },
    });

    const modelMeta = JSON.parse(await readFile(`${result.modelPath}.meta.json`, 'utf8'));
    expect(modelMeta.sha256).toBe(sha256(modelBody));
    expect(modelMeta.size).toBe(modelBody.length);

    const mmprojMeta = JSON.parse(await readFile(`${result.mmprojPath}.meta.json`, 'utf8'));
    expect(mmprojMeta.sha256).toBe(sha256(mmprojBody));
    expect(mmprojMeta.size).toBe(mmprojBody.length);
  });

  it('throws a retryable model download error when download fails', async () => {
    const modelDir = await mkdtemp(join(tmpdir(), 'vision-model-fail-'));

    await expect(ensureGGUFModel({
      modelDir,
      fetchFn: async () => response('nope', false, 503),
    })).rejects.toThrow('Failed to download model file');

    const classified = classifyVisionError(new Error('Failed to download model file: 503 Failed'));
    expect(classified.code).toBe('MODEL_DOWNLOAD_FAILED');
    expect(classified.retryable).toBe(true);
  });
});

describe('MiniCPM-V model manager', () => {
  it('returns existing MiniCPM-V model paths without downloading', async () => {
    const modelDir = await mkdtemp(join(tmpdir(), 'vision-minicpm-existing-'));
    const modelPath = join(modelDir, MINICPM_MODEL_FILE);
    const mmprojPath = join(modelDir, MINICPM_MMPROJ_FILE);
    await writeFile(modelPath, 'model');
    await writeFile(mmprojPath, 'mmproj');
    let fetchCalls = 0;

    const result = await ensureMiniCPMModel({
      modelDir,
      fetchFn: async () => {
        fetchCalls++;
        return response('unused');
      },
    });

    expect(result).toEqual({ modelPath, mmprojPath });
    expect(fetchCalls).toBe(0);
  });

  it('downloads missing MiniCPM-V files to final paths', async () => {
    const modelDir = await mkdtemp(join(tmpdir(), 'vision-minicpm-download-'));
    const bodies: Record<string, string> = {
      [MINICPM_MODEL_FILE]: 'minicpm-model',
      [MINICPM_MMPROJ_FILE]: 'minicpm-mmproj',
    };

    const result = await ensureMiniCPMModel({
      modelDir,
      baseUrl: 'https://example.test',
      fetchFn: async (url) => {
        const file = String(url).split('/').pop() ?? '';
        return response(bodies[file] ?? '', true);
      },
    });

    await expect(readFile(result.modelPath, 'utf8')).resolves.toBe('minicpm-model');
    await expect(readFile(result.mmprojPath, 'utf8')).resolves.toBe('minicpm-mmproj');
  });
});

describe('SmolVLM2 model manager', () => {
  it('returns existing SmolVLM2 model paths without downloading', async () => {
    const modelDir = await mkdtemp(join(tmpdir(), 'vision-smolvlm2-existing-'));
    const modelPath = join(modelDir, SMOLVLM2_MODEL_FILE);
    const mmprojPath = join(modelDir, SMOLVLM2_MMPROJ_FILE);
    await writeFile(modelPath, 'model');
    await writeFile(mmprojPath, 'mmproj');
    let fetchCalls = 0;

    const result = await ensureSmolVLM2Model({
      modelDir,
      fetchFn: async () => {
        fetchCalls++;
        return response('unused');
      },
    });

    expect(result).toEqual({ modelPath, mmprojPath });
    expect(fetchCalls).toBe(0);
  });

  it('downloads missing SmolVLM2 files to final paths', async () => {
    const modelDir = await mkdtemp(join(tmpdir(), 'vision-smolvlm2-download-'));
    const bodies: Record<string, string> = {
      [SMOLVLM2_MODEL_FILE]: 'smolvlm2-model',
      [SMOLVLM2_MMPROJ_FILE]: 'smolvlm2-mmproj',
    };

    const result = await ensureSmolVLM2Model({
      modelDir,
      baseUrl: 'https://example.test',
      fetchFn: async (url) => {
        const file = String(url).split('/').pop() ?? '';
        return response(bodies[file] ?? '', true);
      },
    });

    await expect(readFile(result.modelPath, 'utf8')).resolves.toBe('smolvlm2-model');
    await expect(readFile(result.mmprojPath, 'utf8')).resolves.toBe('smolvlm2-mmproj');
  });
});

describe('Resume (断点续传)', () => {
  it('sends Range header and appends to partial .tmp file', async () => {
    const modelDir = await mkdtemp(join(tmpdir(), 'vision-resume-'));
    const modelPath = join(modelDir, GGUF_MODEL_FILE);
    const mmprojPath = join(modelDir, GGUF_MMPROJ_FILE);

    // Pre-create the mmproj file so only the model file needs downloading.
    await writeFile(mmprojPath, 'mmproj');
    await writeFile(`${mmprojPath}.meta.json`, JSON.stringify({
      sha256: sha256('mmproj'), size: 6, url: '', downloadedAt: '',
    }));

    const fullBody = '0123456789ABCDEF';
    const partial = fullBody.slice(0, 8); // first 8 bytes already downloaded
    const remaining = fullBody.slice(8);

    // Pre-create a partial .tmp file simulating an interrupted download.
    const tmpPath = `${modelPath}.tmp-${process.pid}`;
    await writeFile(tmpPath, partial);

    let capturedRange: string | null = null;

    await ensureGGUFModel({
      modelDir,
      baseUrl: 'https://example.test',
      fetchFn: async (url, init) => {
        const file = String(url).split('/').pop() ?? '';
        if (file === GGUF_MMPROJ_FILE) return response('unused');
        const range = (init?.headers as Record<string, string> | undefined)?.Range;
        if (range) capturedRange = range;
        // Simulate a server supporting Range: return 206 with remaining bytes.
        return new Response(remaining, { status: 206, statusText: 'Partial Content' });
      },
    });

    expect(capturedRange).toBe('bytes=8-');
    const downloaded = await readFile(modelPath, 'utf8');
    expect(downloaded).toBe(fullBody);

    // Meta sidecar should reflect the full file hash.
    const meta = JSON.parse(await readFile(`${modelPath}.meta.json`, 'utf8'));
    expect(meta.sha256).toBe(sha256(fullBody));
    expect(meta.size).toBe(fullBody.length);
  });

  it('restarts from scratch when server ignores Range (returns 200)', async () => {
    const modelDir = await mkdtemp(join(tmpdir(), 'vision-no-range-'));
    const modelPath = join(modelDir, GGUF_MODEL_FILE);
    const mmprojPath = join(modelDir, GGUF_MMPROJ_FILE);
    await writeFile(mmprojPath, 'mmproj');
    await writeFile(`${mmprojPath}.meta.json`, JSON.stringify({
      sha256: sha256('mmproj'), size: 6, url: '', downloadedAt: '',
    }));

    const fullBody = 'COMPLETE-DOWNLOAD';
    // Stale partial .tmp that should be overwritten.
    const tmpPath = `${modelPath}.tmp-${process.pid}`;
    await writeFile(tmpPath, 'STALE-PARTIAL');

    await ensureGGUFModel({
      modelDir,
      baseUrl: 'https://example.test',
      fetchFn: async (url) => {
        const file = String(url).split('/').pop() ?? '';
        if (file === GGUF_MMPROJ_FILE) return response('unused');
        // Server returns 200 (full content), ignoring Range.
        return response(fullBody, true, 200);
      },
    });

    const downloaded = await readFile(modelPath, 'utf8');
    expect(downloaded).toBe(fullBody);
  });
});

describe('Checksum verification (VISION_VERIFY_CHECKSUMS)', () => {
  it('re-downloads when stored checksum does not match file content', async () => {
    process.env.VISION_VERIFY_CHECKSUMS = '1';
    const modelDir = await mkdtemp(join(tmpdir(), 'vision-corrupt-'));
    const modelPath = join(modelDir, GGUF_MODEL_FILE);
    const mmprojPath = join(modelDir, GGUF_MMPROJ_FILE);

    // Create "corrupted" model file with a wrong checksum sidecar.
    const corruptBody = 'CORRUPT-MODEL';
    await writeFile(modelPath, corruptBody);
    await writeFile(`${modelPath}.meta.json`, JSON.stringify({
      sha256: 'wrong-hash-will-not-match',
      size: corruptBody.length,
      url: '',
      downloadedAt: '',
    }));

    // mmproj is valid.
    await writeFile(mmprojPath, 'mmproj');
    await writeFile(`${mmprojPath}.meta.json`, JSON.stringify({
      sha256: sha256('mmproj'), size: 6, url: '', downloadedAt: '',
    }));

    const freshBody = 'FRESH-MODEL';
    let modelFetchCount = 0;

    await ensureGGUFModel({
      modelDir,
      baseUrl: 'https://example.test',
      fetchFn: async (url) => {
        const file = String(url).split('/').pop() ?? '';
        if (file === GGUF_MODEL_FILE) {
          modelFetchCount++;
          return response(freshBody, true);
        }
        return response('unused');
      },
    });

    expect(modelFetchCount).toBe(1);
    const downloaded = await readFile(modelPath, 'utf8');
    expect(downloaded).toBe(freshBody);

    // Meta sidecar should now have the correct hash.
    const meta = JSON.parse(await readFile(`${modelPath}.meta.json`, 'utf8'));
    expect(meta.sha256).toBe(sha256(freshBody));
  });

  it('skips download when checksum matches', async () => {
    process.env.VISION_VERIFY_CHECKSUMS = '1';
    const modelDir = await mkdtemp(join(tmpdir(), 'vision-valid-'));
    const modelPath = join(modelDir, GGUF_MODEL_FILE);
    const mmprojPath = join(modelDir, GGUF_MMPROJ_FILE);

    const modelBody = 'GOOD-MODEL';
    const mmprojBody = 'GOOD-MMPROJ';
    await writeFile(modelPath, modelBody);
    await writeFile(`${modelPath}.meta.json`, JSON.stringify({
      sha256: sha256(modelBody), size: modelBody.length, url: '', downloadedAt: '',
    }));
    await writeFile(mmprojPath, mmprojBody);
    await writeFile(`${mmprojPath}.meta.json`, JSON.stringify({
      sha256: sha256(mmprojBody), size: mmprojBody.length, url: '', downloadedAt: '',
    }));

    let fetchCalls = 0;

    const result = await ensureGGUFModel({
      modelDir,
      fetchFn: async () => {
        fetchCalls++;
        return response('unused');
      },
    });

    expect(result).toEqual({ modelPath, mmprojPath });
    expect(fetchCalls).toBe(0);
  });

  it('adopts existing files without sidecar (no re-download)', async () => {
    process.env.VISION_VERIFY_CHECKSUMS = '1';
    const modelDir = await mkdtemp(join(tmpdir(), 'vision-adopt-'));
    const modelPath = join(modelDir, GGUF_MODEL_FILE);
    const mmprojPath = join(modelDir, GGUF_MMPROJ_FILE);

    // Files exist but no .meta.json sidecar.
    await writeFile(modelPath, 'model');
    await writeFile(mmprojPath, 'mmproj');
    // Deliberately no sidecar files.

    let fetchCalls = 0;

    const result = await ensureGGUFModel({
      modelDir,
      fetchFn: async () => {
        fetchCalls++;
        return response('unused');
      },
    });

    expect(result).toEqual({ modelPath, mmprojPath });
    expect(fetchCalls).toBe(0);
    // Files should still be present.
    expect(existsSync(modelPath)).toBe(true);
    expect(existsSync(mmprojPath)).toBe(true);
  });
});
