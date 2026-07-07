import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_CONFIG, getConfig } from './config.js';

export const GGUF_MODEL_REPO = 'ggml-org/SmolVLM-500M-Instruct-GGUF';
export const GGUF_MODEL_FILE = 'SmolVLM-500M-Instruct-Q8_0.gguf';
export const GGUF_MMPROJ_FILE = 'mmproj-SmolVLM-500M-Instruct-Q8_0.gguf';
export const GGUF_MODEL_DIR = DEFAULT_CONFIG.gguf.modelDir;

export const MINICPM_MODEL_REPO = 'bartowski/MiniCPM-V-2_6-GGUF';
export const MINICPM_MODEL_FILE = 'MiniCPM-V-2_6-Q4_K_M.gguf';
export const MINICPM_MMPROJ_FILE = 'mmproj-model-f16.gguf';
export const MINICPM_MODEL_DIR = join(homedir(), '.vision-mcp', 'models', 'bartowski', 'MiniCPM-V-2_6-GGUF');

export const SMOLVLM2_MODEL_REPO = 'ggml-org/SmolVLM2-500M-Video-Instruct-GGUF';
// Q4_K_M is recommended for smaller size; Q8_0 is also valid.  Both work with
// llama-server.  Users can place whichever quantization they prefer in the
// model directory; ensureSmolVLM2Model only checks for the file named below.
export const SMOLVLM2_MODEL_FILE = 'SmolVLM2-500M-Video-Instruct-Q8_0.gguf';
export const SMOLVLM2_MMPROJ_FILE = 'mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf';
export const SMOLVLM2_MODEL_DIR = join(homedir(), '.vision-mcp', 'models', 'ggml-org', 'SmolVLM2-500M-Video-Instruct-GGUF');

export interface GGUFModelPaths {
  modelPath: string;
  mmprojPath: string;
}

interface EnsureGGUFModelOptions {
  modelDir?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export async function ensureGGUFModel(options: EnsureGGUFModelOptions = {}): Promise<GGUFModelPaths> {
  const config = await getConfig();
  const modelDir = options.modelDir ?? config.gguf.modelDir;
  const modelPath = join(modelDir, GGUF_MODEL_FILE);
  const mmprojPath = join(modelDir, GGUF_MMPROJ_FILE);

  if (existsSync(modelPath) && existsSync(mmprojPath)) {
    return { modelPath, mmprojPath };
  }

  await mkdir(modelDir, { recursive: true });
  const baseUrl = options.baseUrl ?? config.gguf.endpoint;
  const fetchFn = options.fetchFn ?? fetch;

  if (!existsSync(modelPath)) {
    await downloadFile(buildModelUrl(baseUrl, GGUF_MODEL_REPO, GGUF_MODEL_FILE), modelPath, fetchFn, 'model file');
  }
  if (!existsSync(mmprojPath)) {
    await downloadFile(buildModelUrl(baseUrl, GGUF_MODEL_REPO, GGUF_MMPROJ_FILE), mmprojPath, fetchFn, 'mmproj file');
  }

  return { modelPath, mmprojPath };
}

export async function ensureMiniCPMModel(options: EnsureGGUFModelOptions = {}): Promise<GGUFModelPaths> {
  const config = await getConfig();
  const modelDir = options.modelDir ?? MINICPM_MODEL_DIR;
  const modelPath = join(modelDir, MINICPM_MODEL_FILE);
  const mmprojPath = join(modelDir, MINICPM_MMPROJ_FILE);

  if (existsSync(modelPath) && existsSync(mmprojPath)) {
    return { modelPath, mmprojPath };
  }

  await mkdir(modelDir, { recursive: true });
  const baseUrl = options.baseUrl ?? config.gguf.endpoint;
  const fetchFn = options.fetchFn ?? fetch;

  if (!existsSync(modelPath)) {
    await downloadFile(buildModelUrl(baseUrl, MINICPM_MODEL_REPO, MINICPM_MODEL_FILE), modelPath, fetchFn, 'model file');
  }
  if (!existsSync(mmprojPath)) {
    await downloadFile(buildModelUrl(baseUrl, MINICPM_MODEL_REPO, MINICPM_MMPROJ_FILE), mmprojPath, fetchFn, 'mmproj file');
  }

  return { modelPath, mmprojPath };
}

export async function ensureSmolVLM2Model(options: EnsureGGUFModelOptions = {}): Promise<GGUFModelPaths> {
  const config = await getConfig();
  const modelDir = options.modelDir ?? SMOLVLM2_MODEL_DIR;
  const modelPath = join(modelDir, SMOLVLM2_MODEL_FILE);
  const mmprojPath = join(modelDir, SMOLVLM2_MMPROJ_FILE);

  if (existsSync(modelPath) && existsSync(mmprojPath)) {
    return { modelPath, mmprojPath };
  }

  await mkdir(modelDir, { recursive: true });
  const baseUrl = options.baseUrl ?? config.gguf.endpoint;
  const fetchFn = options.fetchFn ?? fetch;

  if (!existsSync(modelPath)) {
    await downloadFile(buildModelUrl(baseUrl, SMOLVLM2_MODEL_REPO, SMOLVLM2_MODEL_FILE), modelPath, fetchFn, 'model file');
  }
  if (!existsSync(mmprojPath)) {
    await downloadFile(buildModelUrl(baseUrl, SMOLVLM2_MODEL_REPO, SMOLVLM2_MMPROJ_FILE), mmprojPath, fetchFn, 'mmproj file');
  }

  return { modelPath, mmprojPath };
}

function buildModelUrl(baseUrl: string, repo: string, fileName: string): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  return `${trimmed}/${repo}/resolve/main/${fileName}`;
}

async function downloadFile(
  url: string,
  destination: string,
  fetchFn: typeof fetch,
  label: string,
): Promise<void> {
  const tmpPath = `${destination}.tmp-${process.pid}-${Date.now()}`;

  try {
    const response = await fetchFn(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error(`Failed to download ${label}: empty response`);
    }

    await writeFile(tmpPath, bytes);
    await rename(tmpPath, destination);
  } catch (error) {
    if (existsSync(tmpPath)) {
      await unlink(tmpPath).catch(() => {});
    }
    throw error;
  }
}
