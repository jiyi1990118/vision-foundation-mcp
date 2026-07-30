// src/providers/llama-server/resolver.ts
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';
import { detectPlatform } from './platform-detector.js';
import { downloadAndExtract, buildMirrorUrl } from './downloader.js';

// ES module compatibility: __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  const currentPlatform = platform();
  const exeName = currentPlatform === 'win32' ? 'llama-server.exe' : 'llama-server';

  // Platform-specific system search paths
  const systemPaths: string[] =
    currentPlatform === 'win32'
      ? [
          join(home, 'AppData', 'Local', 'llama.cpp', exeName),
          join(home, 'AppData', 'Local', 'Programs', 'llama.cpp', exeName),
        ]
      : [
          '/opt/homebrew/bin/llama-server',
          '/usr/local/bin/llama-server',
          '/usr/bin/llama-server',
        ];

  return [
    ...(env.LLAMA_SERVER_PATH ? [env.LLAMA_SERVER_PATH] : []),
    join(packageRoot, 'bin', exeName),
    join(home, '.vision-mcp', 'bin', exeName),
    ...systemPaths,
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
    logger.info(`Using project bin directory: ${packageBinDir}`);
    return packageBinDir;
  } catch {
    logger.info(`Project bin directory is not writable, falling back to user directory: ${userBinDir}`);
    mkdirSync(userBinDir, { recursive: true });
    return userBinDir;
  }
}

async function getLatestReleaseTag(): Promise<string> {
  const response = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest');
  if (!response.ok) {
    if (response.status === 429) {
      const resetTime = response.headers.get('X-RateLimit-Reset');
      const resetDate = resetTime ? new Date(Number(resetTime) * 1000).toLocaleString() : 'unknown';
      throw new Error(
        `GitHub API rate limit exceeded (60 requests/hour for unauthenticated requests). ` +
        `Rate limit resets at: ${resetDate}. ` +
        `You can set LLAMA_SERVER_PATH to use an existing llama-server binary.`
      );
    }
    throw new Error(`Failed to fetch latest release: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as { tag_name: string };
  const tag = data.tag_name;
  
  // Validate tag format: non-empty, reasonable length, alphanumeric + dash/dot/underscore
  if (!tag || tag.length === 0 || tag.length > 50) {
    throw new Error(`Invalid tag format: "${tag}" (empty or too long)`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(tag)) {
    throw new Error(`Invalid tag format: "${tag}" (contains invalid characters)`);
  }
  
  return tag;
}

function buildDownloadUrls(tag: string, platformFilename: string): string[] {
  const archiveExt = platform() === 'win32' ? '.zip' : '.tar.gz';
  const filename = `llama-${tag}-bin-${platformFilename}${archiveExt}`;
  const githubUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${filename}`;
  
  const urls = [
    process.env.LLAMA_SERVER_DOWNLOAD_URL,
    githubUrl,
    process.env.LLAMA_DOWNLOAD_MIRROR
      ? buildMirrorUrl(githubUrl, process.env.LLAMA_DOWNLOAD_MIRROR)
      : buildMirrorUrl(githubUrl, 'https://ghproxy.com'),
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
