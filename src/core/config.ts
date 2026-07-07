import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface VisionConfig {
  server: {
    maxConcurrent: number;
    requestTimeoutMs: number;
  };
  security: {
    maxImageSizeBytes: number;
  };
  gguf: {
    modelDir: string;
    endpoint: string;
    port: number;
  };
}

interface LoadConfigOptions {
  configPath?: string;
  env?: Record<string, string | undefined>;
}

export const DEFAULT_CONFIG: VisionConfig = {
  server: {
    maxConcurrent: 4,
    requestTimeoutMs: 30_000,
  },
  security: {
    maxImageSizeBytes: 10 * 1024 * 1024,
  },
  gguf: {
    modelDir: join(homedir(), '.vision-mcp', 'models', 'ggml-org', 'SmolVLM-500M-Instruct-GGUF'),
    endpoint: 'https://hf-mirror.com',
    port: 18082,
  },
};

let cachedConfig: VisionConfig | null = null;

export async function getConfig(): Promise<VisionConfig> {
  if (cachedConfig) return cachedConfig;
  cachedConfig = await loadConfig();
  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<VisionConfig> {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? env.VISION_CONFIG_PATH ?? 'config/default.json';
  let config = cloneConfig(DEFAULT_CONFIG);

  if (existsSync(configPath)) {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as PartialVisionConfig;
    config = mergeConfig(config, parsed);
  }

  return applyEnvOverrides(config, env);
}

type PartialVisionConfig = {
  server?: Partial<VisionConfig['server']>;
  security?: Partial<VisionConfig['security']>;
  gguf?: Partial<VisionConfig['gguf']>;
};

function cloneConfig(config: VisionConfig): VisionConfig {
  return {
    server: { ...config.server },
    security: { ...config.security },
    gguf: { ...config.gguf },
  };
}

function mergeConfig(base: VisionConfig, override: PartialVisionConfig): VisionConfig {
  return {
    server: { ...base.server, ...override.server },
    security: { ...base.security, ...override.security },
    gguf: { ...base.gguf, ...override.gguf },
  };
}

function applyEnvOverrides(config: VisionConfig, env: Record<string, string | undefined>): VisionConfig {
  const result = cloneConfig(config);
  result.server.maxConcurrent = numberEnv(env.VISION_MAX_CONCURRENT, result.server.maxConcurrent);
  result.server.requestTimeoutMs = numberEnv(env.VISION_REQUEST_TIMEOUT_MS, result.server.requestTimeoutMs);
  result.security.maxImageSizeBytes = numberEnv(env.VISION_MAX_IMAGE_SIZE_BYTES, result.security.maxImageSizeBytes);
  result.gguf.port = numberEnv(env.LLAMA_SERVER_PORT, result.gguf.port);
  result.gguf.modelDir = env.VISION_GGUF_MODEL_DIR ?? result.gguf.modelDir;
  result.gguf.endpoint = env.HF_ENDPOINT ?? result.gguf.endpoint;
  return result;
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
