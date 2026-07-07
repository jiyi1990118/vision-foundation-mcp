import { describe, expect, it } from 'vitest';
import { resolveLlamaServerCandidates, resolveLlamaServerPath } from '../src/providers/llama-server/process.js';

describe('llama-server resolver', () => {
  it('prefers explicit LLAMA_SERVER_PATH when provided and existing', () => {
    const existing = new Set(['/custom/llama-server']);
    const result = resolveLlamaServerPath({
      env: { LLAMA_SERVER_PATH: '/custom/llama-server' },
      platform: 'darwin',
      homeDir: '/home/user',
      exists: (p) => existing.has(p),
    });

    expect(result).toBe('/custom/llama-server');
  });

  it('checks ~/.vision-mcp/bin before system locations', () => {
    const candidates = resolveLlamaServerCandidates({
      env: {},
      platform: 'linux',
      homeDir: '/home/user',
    });

    expect(candidates[0]).toBe('/home/user/.vision-mcp/bin/llama-server');
    expect(candidates).toContain('/usr/local/bin/llama-server');
  });

  it('uses llama-server.exe candidates on Windows', () => {
    const candidates = resolveLlamaServerCandidates({
      env: {},
      platform: 'win32',
      homeDir: 'C:/Users/me',
    });

    expect(candidates[0]).toBe('C:/Users/me/.vision-mcp/bin/llama-server.exe');
    expect(candidates).toContain('llama-server.exe');
  });

  it('falls back to PATH candidate when no file candidate exists', () => {
    const result = resolveLlamaServerPath({
      env: {},
      platform: 'linux',
      homeDir: '/home/user',
      exists: () => false,
    });

    expect(result).toBe('llama-server');
  });
});
