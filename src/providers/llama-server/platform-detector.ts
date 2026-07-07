// src/providers/llama-server/platform-detector.ts
import { platform, arch } from 'node:os';

export interface PlatformInfo {
  platform: 'darwin' | 'linux' | 'win32';
  arch: 'arm64' | 'x64';
  releaseFilename: string;
}

export interface DetectOptions {
  platform?: string;
  arch?: string;
}

export function detectPlatform(options: DetectOptions = {}): PlatformInfo {
  const currentPlatform = options.platform ?? platform();
  const currentArch = options.arch ?? arch();
  
  // macOS
  if (currentPlatform === 'darwin') {
    if (currentArch === 'arm64') {
      return { platform: 'darwin', arch: 'arm64', releaseFilename: 'macos-arm64' };
    }
    if (currentArch === 'x64') {
      return { platform: 'darwin', arch: 'x64', releaseFilename: 'macos-x64' };
    }
  }
  
  // Linux
  if (currentPlatform === 'linux' && currentArch === 'x64') {
    return { platform: 'linux', arch: 'x64', releaseFilename: 'ubuntu-x64' };
  }
  
  // Windows
  if (currentPlatform === 'win32' && currentArch === 'x64') {
    return { platform: 'win32', arch: 'x64', releaseFilename: 'win-cuda-cu12.4-x64' };
  }
  
  throw new Error(
    `Platform ${currentPlatform}-${currentArch} not supported for auto-install.\n` +
    `Please build llama.cpp from source or set LLAMA_SERVER_PATH.`
  );
}
