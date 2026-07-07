// src/providers/llama-server/resolver.ts
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { logger } from '../../utils/logger.js';
import { detectPlatform } from './platform-detector.js';
import { downloadAndExtract, buildMirrorUrl } from './downloader.js';

export interface ResolverOptions {
  env?: Record<string, string | undefined>;
  packageRoot?: string;
  homeDir?: string;
  skipAutoInstall?: boolean;
}

export function resolveLlamaServerCandidates(options: ResolverOptions = {}): string[] {
  const env = options.env ?? process.env;
  const packageRoot = options.packageRoot ?? join(__dirname, '..', '..', '..');
  const home = options.homeDir ?? homedir();
  const exeName = platform() === 'win32' ? 'llama-server.exe' : 'llama-server';
  
  return [
    ...(env.LLAMA_SERVER_PATH ? [env.LLAMA_SERVER_PATH] : []),
    join(packageRoot, 'bin', exeName),
    join(home, '.vision-mcp', 'bin', exeName),
    '/opt/homebrew/bin/llama-server',
    '/usr/local/bin/llama-server',
    '/usr/bin/llama-server',
    exeName,
  ];
}

function getDownloadDestination(): string {
  const packageRoot = join(__dirname, '..', '..', '..');
  const packageBinDir = join(packageRoot, 'bin');
  const userBinDir = join(homedir(), '.vision-mcp', 'bin');
  
  try {
    mkdirSync(packageBinDir, { recursive: true });
    const testFile = join(packageBinDir, '.write-test');
    writeFileSync(testFile, '');
    unlinkSync(testFile);
    return packageBinDir;
  } catch {
    mkdirSync(userBinDir, { recursive: true });
    return userBinDir;
  }
}

async function getLatestReleaseTag(): Promise<string> {
  const response = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest');
  if (!response.ok) {
    throw new Error(`Failed to fetch latest release: ${response.status}`);
  }
  const data = await response.json() as { tag_name: string };
  return data.tag_name;
}

function buildDownloadUrls(tag: string, platformFilename: string): string[] {
  const filename = `llama-${tag}-bin-${platformFilename}.tar.gz`;
  const githubUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${filename}`;
  
  const urls = [
    process.env.LLAMA_SERVER_DOWNLOAD_URL,
    githubUrl,
    buildMirrorUrl(githubUrl, process.env.LLAMA_DOWNLOAD_MIRROR || 'https://ghproxy.com'),
    buildMirrorUrl(githubUrl, 'https://gh.api.99988866.xyz'),
  ].filter(Boolean) as string[];
  
  return urls;
}

export async function ensureLlamaServer(options: ResolverOptions = {}): Promise<string> {
  const candidates = resolveLlamaServerCandidates(options);
  
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      logger.info(`Found llama-server: ${candidate}`);
      return candidate;
    }
  }
  
  if (options.skipAutoInstall) {
    throw new Error('llama-server not found and auto-install is skipped');
  }
  
  logger.info('llama-server not found, downloading...');
  
  const platformInfo = detectPlatform();
  const tag = await getLatestReleaseTag();
  const urls = buildDownloadUrls(tag, platformInfo.releaseFilename);
  const destDir = getDownloadDestination();
  const binaryName = platform() === 'win32' ? 'llama-server.exe' : 'llama-server';
  
  const installedPath = await downloadAndExtract(urls, destDir, binaryName, 60000);
  
  if (platform() !== 'win32') {
    const { chmodSync } = await import('node:fs');
    chmodSync(installedPath, 0o755);
  }
  
  logger.info(`Auto-install complete: ${installedPath}`);
  return installedPath;
}
