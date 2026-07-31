import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadConfig, computePipelineTimeout } from '../src/core/config.js';

describe('runtime config', () => {
  it('returns defaults when no config file exists', async () => {
    const config = await loadConfig({ configPath: join(tmpdir(), 'missing-vision-config.json'), env: {} });

    expect(config.server.maxConcurrent).toBe(4);
    expect(config.server.requestTimeoutMs).toBe(60_000);
    expect(config.security.maxImageSizeBytes).toBe(10 * 1024 * 1024);
    expect(config.gguf.port).toBe(18082);
    expect(config.gguf.endpoint).toBe('https://hf-mirror.com');
  });

  it('loads JSON config overrides without losing defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vision-config-'));
    const configPath = join(dir, 'default.json');
    await writeFile(configPath, JSON.stringify({
      server: { maxConcurrent: 2 },
      gguf: { port: 19090, endpoint: 'https://example.test' },
    }));

    const config = await loadConfig({ configPath, env: {} });

    expect(config.server.maxConcurrent).toBe(2);
    expect(config.server.requestTimeoutMs).toBe(60_000);
    expect(config.gguf.port).toBe(19090);
    expect(config.gguf.endpoint).toBe('https://example.test');
    expect(config.security.maxImageSizeBytes).toBe(10 * 1024 * 1024);
  });

  it('applies environment overrides after JSON config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vision-config-env-'));
    const configPath = join(dir, 'default.json');
    await writeFile(configPath, JSON.stringify({
      server: { maxConcurrent: 2, requestTimeoutMs: 10_000 },
      gguf: { port: 19090, endpoint: 'https://example.test' },
    }));

    const config = await loadConfig({
      configPath,
      env: {
        VISION_MAX_CONCURRENT: '8',
        VISION_REQUEST_TIMEOUT_MS: '45000',
        VISION_MAX_IMAGE_SIZE_BYTES: '2097152',
        LLAMA_SERVER_PORT: '18083',
        HF_ENDPOINT: 'https://mirror.test',
      },
    });

    expect(config.server.maxConcurrent).toBe(8);
    expect(config.server.requestTimeoutMs).toBe(45_000);
    expect(config.security.maxImageSizeBytes).toBe(2 * 1024 * 1024);
    expect(config.gguf.port).toBe(18083);
    expect(config.gguf.endpoint).toBe('https://mirror.test');
  });
});

describe('computePipelineTimeout', () => {
  it('uses the base timeout when skill count is low', () => {
    expect(computePipelineTimeout(1, 60_000)).toBe(60_000);
    expect(computePipelineTimeout(3, 60_000)).toBe(60_000);
  });

  it('scales up for multi-skill plans', () => {
    expect(computePipelineTimeout(5, 60_000)).toBe(100_000);
    expect(computePipelineTimeout(8, 60_000)).toBe(160_000);
  });

  it('caps at 300 seconds', () => {
    expect(computePipelineTimeout(20, 60_000)).toBe(300_000);
  });
});
