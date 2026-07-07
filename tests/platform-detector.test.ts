// tests/platform-detector.test.ts
import { describe, it, expect } from 'vitest';
import { detectPlatform } from '../src/providers/llama-server/platform-detector.js';

describe('detectPlatform', () => {
  it('should detect macOS ARM64', () => {
    const info = detectPlatform({ platform: 'darwin', arch: 'arm64' });
    expect(info.platform).toBe('darwin');
    expect(info.arch).toBe('arm64');
    expect(info.releaseFilename).toBe('macos-arm64');
  });

  it('should detect macOS x64', () => {
    const info = detectPlatform({ platform: 'darwin', arch: 'x64' });
    expect(info.releaseFilename).toBe('macos-x64');
  });

  it('should detect Linux x64', () => {
    const info = detectPlatform({ platform: 'linux', arch: 'x64' });
    expect(info.releaseFilename).toBe('ubuntu-x64');
  });

  it('should detect Windows x64', () => {
    const info = detectPlatform({ platform: 'win32', arch: 'x64' });
    expect(info.releaseFilename).toBe('win-cuda-cu12.4-x64');
  });

  it('should throw on unsupported platform', () => {
    expect(() => detectPlatform({ platform: 'freebsd' }))
      .toThrow('not supported');
  });
});
