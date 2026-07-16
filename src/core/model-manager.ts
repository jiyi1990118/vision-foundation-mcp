import { mkdir, rename, stat, unlink, readFile, writeFile, readdir } from 'node:fs/promises';
import { createWriteStream, createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
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

interface ModelFileSpec {
  repo: string;
  modelFile: string;
  mmprojFile: string;
}

/** Sidecar metadata written alongside each downloaded model file. */
interface ModelMeta {
  sha256: string;
  size: number;
  url: string;
  downloadedAt: string;
}

function metaPathFor(filePath: string): string {
  return `${filePath}.meta.json`;
}

function shouldVerifyChecksums(): boolean {
  return process.env.VISION_VERIFY_CHECKSUMS === '1';
}

/**
 * Compute the SHA-256 hash of a file by streaming it through the hash
 * digest.  Used for post-download verification and corruption detection.
 */
async function computeFileHash(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function readMeta(filePath: string): Promise<ModelMeta | undefined> {
  const metaPath = metaPathFor(filePath);
  if (!existsSync(metaPath)) return undefined;
  try {
    return JSON.parse(await readFile(metaPath, 'utf8')) as ModelMeta;
  } catch {
    return undefined;
  }
}

async function writeMeta(filePath: string, meta: ModelMeta): Promise<void> {
  await writeFile(metaPathFor(filePath), JSON.stringify(meta, null, 2), 'utf8');
}

/**
 * Check whether a model file is present and (optionally) checksum-valid.
 * When `verify` is true and a `.meta.json` sidecar exists, the file's
 * SHA-256 is recomputed and compared.  A mismatch marks the file as
 * corrupted so the caller can re-download.
 */
async function isModelFileValid(filePath: string, verify: boolean): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  if (!verify) return true;

  const meta = await readMeta(filePath);
  if (!meta) return true; // No sidecar yet — assume valid, adopt on next download.

  try {
    const actualHash = await computeFileHash(filePath);
    if (actualHash !== meta.sha256) {
      logger.warn('Model file checksum mismatch — will re-download', { filePath });
      await unlink(filePath).catch(() => {});
      await unlink(metaPathFor(filePath)).catch(() => {});
      return false;
    }
    return true;
  } catch {
    logger.warn('Model file verification failed — will re-download', { filePath });
    await unlink(filePath).catch(() => {});
    await unlink(metaPathFor(filePath)).catch(() => {});
    return false;
  }
}

async function ensureModelFiles(
  spec: ModelFileSpec,
  defaultModelDir: string,
  options: EnsureGGUFModelOptions = {},
): Promise<GGUFModelPaths> {
  const modelDir = options.modelDir ?? defaultModelDir;
  const modelPath = join(modelDir, spec.modelFile);
  const mmprojPath = join(modelDir, spec.mmprojFile);
  const verify = shouldVerifyChecksums();

  if (await isModelFileValid(modelPath, verify) && await isModelFileValid(mmprojPath, verify)) {
    return { modelPath, mmprojPath };
  }

  await mkdir(modelDir, { recursive: true });
  const baseUrl = options.baseUrl ?? (await getConfig()).gguf.endpoint;
  const fetchFn = options.fetchFn ?? fetch;

  if (!(await isModelFileValid(modelPath, verify))) {
    await downloadFile(buildModelUrl(baseUrl, spec.repo, spec.modelFile), modelPath, fetchFn, 'model file');
  }
  if (!(await isModelFileValid(mmprojPath, verify))) {
    await downloadFile(buildModelUrl(baseUrl, spec.repo, spec.mmprojFile), mmprojPath, fetchFn, 'mmproj file');
  }

  return { modelPath, mmprojPath };
}

export async function ensureGGUFModel(options: EnsureGGUFModelOptions = {}): Promise<GGUFModelPaths> {
  const { gguf } = await getConfig();
  return ensureModelFiles(
    { repo: GGUF_MODEL_REPO, modelFile: GGUF_MODEL_FILE, mmprojFile: GGUF_MMPROJ_FILE },
    gguf.modelDir,
    options,
  );
}

export async function ensureMiniCPMModel(options: EnsureGGUFModelOptions = {}): Promise<GGUFModelPaths> {
  return ensureModelFiles(
    { repo: MINICPM_MODEL_REPO, modelFile: MINICPM_MODEL_FILE, mmprojFile: MINICPM_MMPROJ_FILE },
    MINICPM_MODEL_DIR,
    options,
  );
}

export async function ensureSmolVLM2Model(options: EnsureGGUFModelOptions = {}): Promise<GGUFModelPaths> {
  return ensureModelFiles(
    { repo: SMOLVLM2_MODEL_REPO, modelFile: SMOLVLM2_MODEL_FILE, mmprojFile: SMOLVLM2_MMPROJ_FILE },
    SMOLVLM2_MODEL_DIR,
    options,
  );
}

function buildModelUrl(baseUrl: string, repo: string, fileName: string): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  return `${trimmed}/${repo}/resolve/main/${fileName}`;
}

/**
 * Remove orphaned `.tmp-*` partial-download files left by crashed processes.
 * Keeps `currentTmpPath` (the current process's resume file) but deletes all
 * other `${destination}.tmp-*` files in the same directory.
 */
async function cleanupStaleTempFiles(destination: string, currentTmpPath: string): Promise<void> {
  const dir = dirname(destination);
  const base = basename(destination);
  const prefix = `${base}.tmp-`;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // Directory doesn't exist yet - nothing to clean.
  }

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const fullPath = join(dir, entry);
    if (fullPath === currentTmpPath) continue; // Keep current process's partial.
    await unlink(fullPath).catch(() => {});
    logger.info('Removed orphaned temp file', { file: entry });
  }
}

/**
 * Download a file with HTTP Range resume support and SHA-256 verification.
 *
 * - If a `.tmp` partial file exists from a previous interrupted attempt,
 *   an HTTP `Range` header is sent to resume from the offset.  Servers
 *   that don't support Range (respond 200 instead of 206) cause a full
 *   restart.
 * - After the download completes, the SHA-256 of the full file is computed
 *   and stored in a `.meta.json` sidecar for future corruption detection.
 * - The file is written to a `.tmp` path and atomically renamed to the
 *   destination only after successful verification.
 */
async function downloadFile(
  url: string,
  destination: string,
  fetchFn: typeof fetch,
  label: string,
): Promise<void> {
  // Use a stable .tmp name (pid-suffixed) so interrupted downloads can be
  // resumed by the same process on the next attempt.
  const tmpPath = `${destination}.tmp-${process.pid}`;

  // Clean up orphaned .tmp files from crashed processes to avoid wasting disk.
  // Keeps the current process's .tmp (for resume) but removes stale ones.
  await cleanupStaleTempFiles(destination, tmpPath);

  const fetchedFromScratch = await streamDownload(url, tmpPath, fetchFn, label);

  const finalStat = await stat(tmpPath);
  if (finalStat.size === 0) {
    throw new Error(`Failed to download ${label}: empty file`);
  }

  // Compute SHA-256 of the complete file for the metadata sidecar.
  const sha256 = await computeFileHash(tmpPath);
  logger.info(`${label} downloaded`, {
    size: finalStat.size,
    sha256: sha256.slice(0, 12),
    resumed: !fetchedFromScratch,
  });

  // Atomic rename to destination.
  await rename(tmpPath, destination);

  // Write metadata sidecar.
  await writeMeta(destination, {
    sha256,
    size: finalStat.size,
    url,
    downloadedAt: new Date().toISOString(),
  });
}

/**
 * Stream a download to `tmpPath`, resuming from a partial `.tmp` file if one
 * exists.  Returns `true` if the download started from scratch (no resume),
 * `false` if it was resumed.
 */
async function streamDownload(
  url: string,
  tmpPath: string,
  fetchFn: typeof fetch,
  label: string,
): Promise<boolean> {
  let offset = 0;
  if (existsSync(tmpPath)) {
    try {
      offset = (await stat(tmpPath)).size;
    } catch {
      offset = 0;
    }
  }

  const headers: Record<string, string> = {};
  if (offset > 0) {
    headers.Range = `bytes=${offset}-`;
    logger.info(`Resuming ${label} download from byte ${offset}`, { offset });
  }

  const response = await fetchFn(url, { headers });

  // Server ignored the Range request and returned the full content — restart.
  if (offset > 0 && response.status === 200) {
    logger.info(`Server does not support Range, restarting ${label} download`);
    offset = 0;
  } else if (!response.ok && response.status !== 206) {
    throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error(`Failed to download ${label}: empty response body`);
  }

  // Append if resuming, otherwise truncate.
  const fileStream = createWriteStream(tmpPath, { flags: offset > 0 ? 'a' : 'w' });
  await new Promise<void>((resolve, reject) => {
    const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
    nodeStream.pipe(fileStream);
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
    nodeStream.on('error', reject);
  });

  return offset === 0;
}
