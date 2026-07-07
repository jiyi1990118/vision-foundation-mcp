#!/usr/bin/env tsx
/**
 * Explicit llama.cpp setup helper.
 *
 * This is intentionally a setup-time command, not runtime auto-install. The MCP
 * server must keep stdout reserved for JSON-RPC, while this script can print
 * user-facing progress and instructions safely.
 */
import { chmod, mkdir } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { resolveLlamaServerPath } from '../src/providers/llama-server/process.js';

const INSTALL_DIR = join(homedir(), '.vision-mcp', 'bin');

interface PlatformPlan {
  binName: string;
  instructions: string[];
}

function getPlatformPlan(): PlatformPlan {
  const current = platform();
  if (current === 'darwin') {
    return {
      binName: 'llama-server',
      instructions: [
        'Recommended macOS install:',
        '  brew install llama.cpp',
        '',
        'After install, this MCP will find /opt/homebrew/bin/llama-server or PATH automatically.',
      ],
    };
  }
  if (current === 'linux') {
    return {
      binName: 'llama-server',
      instructions: [
        'Recommended Linux install:',
        '  Build llama.cpp from source, or download a release that includes llama-server.',
        '  Then copy/symlink llama-server to ~/.vision-mcp/bin/llama-server or set LLAMA_SERVER_PATH.',
      ],
    };
  }
  if (current === 'win32') {
    return {
      binName: 'llama-server.exe',
      instructions: [
        'Recommended Windows install:',
        '  Download a llama.cpp Windows release zip that includes llama-server.exe.',
        '  Put llama-server.exe in %USERPROFILE%\\.vision-mcp\\bin or set LLAMA_SERVER_PATH.',
      ],
    };
  }
  return {
    binName: current === 'win32' ? 'llama-server.exe' : 'llama-server',
    instructions: ['Unsupported platform. Install llama.cpp manually and set LLAMA_SERVER_PATH.'],
  };
}

async function download(url: string, outPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(outPath));
}

async function main(): Promise<void> {
  const plan = getPlatformPlan();
  await mkdir(INSTALL_DIR, { recursive: true });

  const existing = resolveLlamaServerPath({ exists: existsSync });
  if (existing !== 'llama-server' && existing !== 'llama-server.exe') {
    console.log(`llama-server already available: ${existing}`);
    return;
  }

  const url = process.env.LLAMA_SERVER_DOWNLOAD_URL;
  if (url) {
    const destination = join(INSTALL_DIR, plan.binName);
    console.log(`Downloading llama-server from ${url}`);
    await download(url, destination);
    if (platform() !== 'win32') await chmod(destination, 0o755);
    console.log(`Installed ${basename(destination)} to ${destination}`);
    return;
  }

  if (platform() === 'darwin') {
    const brew = spawnSync('brew', ['--version'], { stdio: 'ignore' });
    if (brew.status === 0) {
      console.log('Homebrew detected. Run: brew install llama.cpp');
    }
  }

  console.log('llama-server was not found in known locations.');
  console.log(`Preferred local install path: ${join(INSTALL_DIR, plan.binName)}`);
  console.log('');
  for (const line of plan.instructions) console.log(line);
  console.log('');
  console.log('Advanced: set LLAMA_SERVER_DOWNLOAD_URL to a trusted llama-server binary URL to download into ~/.vision-mcp/bin.');
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
