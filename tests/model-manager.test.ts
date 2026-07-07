import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
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

function response(body: string, ok = true, status = 200): Response {
  return new Response(body, { status, statusText: ok ? 'OK' : 'Failed' });
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
