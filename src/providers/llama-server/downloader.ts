// src/providers/llama-server/downloader.ts
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { extract } from 'tar';
import { join } from 'node:path';
import { mkdirSync, renameSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { logger } from '../../utils/logger.js';

export interface DownloadOptions {
  url: string;
  destPath: string;
  timeout?: number;
  onProgress?: (percent: number) => void;
}

export async function downloadFile(options: DownloadOptions): Promise<void> {
  const { url, destPath, timeout = 60000 } = options;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, { signal: controller.signal });
    
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    
    await pipeline(response.body, createWriteStream(destPath));
    logger.info(`Downloaded: ${destPath}`);
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(`Download timeout after ${timeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function buildMirrorUrl(githubUrl: string, mirrorBase?: string): string {
  if (!mirrorBase) return githubUrl;
  return `${mirrorBase}/${githubUrl}`;
}

export async function downloadWithRetry(
  urls: string[],
  destPath: string,
  timeout: number = 60000
): Promise<void> {
  let lastError: Error | undefined;
  
  for (const url of urls) {
    try {
      logger.info(`Trying: ${url} (${timeout}ms timeout)`);
      await downloadFile({ url, destPath, timeout });
      return;
    } catch (error) {
      lastError = error as Error;
      logger.warn(`Download failed from ${url}: ${lastError.message}`);
    }
  }
  
  throw new Error(`Failed to download from all sources. Last error: ${lastError?.message}`);
}

export async function downloadAndExtract(
  urls: string[],
  destDir: string,
  binaryName: string,
  timeout: number = 60000
): Promise<string> {
  const tempDir = join(destDir, '.downloading');
  mkdirSync(tempDir, { recursive: true });

  const isWindows = platform() === 'win32';
  const archiveExt = isWindows ? '.zip' : '.tar.gz';
  const archivePath = join(tempDir, `download${archiveExt}`);

  try {
    await downloadWithRetry(urls, archivePath, timeout);

    logger.info('Extracting archive...');

    let extractedBinary: string;

    if (isWindows) {
      extractedBinary = await extractZipAndFindBinary(tempDir, archivePath, binaryName);
    } else {
      await extract({ file: archivePath, cwd: tempDir });
      extractedBinary = join(tempDir, 'bin', binaryName);
    }

    if (!existsSync(extractedBinary)) {
      throw new Error(`Binary ${binaryName} not found in extracted archive`);
    }

    mkdirSync(destDir, { recursive: true });
    const finalPath = join(destDir, binaryName);
    renameSync(extractedBinary, finalPath);

    logger.info(`Installed: ${finalPath}`);
    return finalPath;
  } finally {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Extract a .zip archive on Windows using PowerShell's Expand-Archive,
 * then find the binary (may be in a nested bin/ subdirectory).
 */
async function extractZipAndFindBinary(
  tempDir: string,
  zipPath: string,
  binaryName: string,
): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const extractDir = join(tempDir, 'extracted');
  mkdirSync(extractDir, { recursive: true });

  execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command',
     `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`],
    { encoding: 'utf8' },
  );

  // Search for the binary in the extracted directory tree
  const directPath = join(extractDir, 'bin', binaryName);
  if (existsSync(directPath)) return directPath;

  // Fallback: recursively search for the binary
  return findFileRecursive(extractDir, binaryName) ?? directPath;
}

/** Recursively search for a file by name. */
function findFileRecursive(dir: string, fileName: string): string | null {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      const found = findFileRecursive(fullPath, fileName);
      if (found) return found;
    } else if (entry === fileName) {
      return fullPath;
    }
  }
  return null;
}
