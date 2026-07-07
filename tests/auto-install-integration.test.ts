// tests/auto-install-integration.test.ts
import { describe, it, expect } from 'vitest';
import { ensureLlamaServer } from '../src/providers/llama-server/resolver.js';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

describe('auto-install integration', () => {
  it('should download and install llama-server', async () => {
    const path = await ensureLlamaServer();
    
    expect(existsSync(path)).toBe(true);
    
    const result = spawnSync(path, ['--version']);
    expect(result.status).toBe(0);
    
    // llama-server --version outputs to stderr
    const output = result.stderr.toString() + result.stdout.toString();
    expect(output).toContain('version');
  }, 180000); // 3分钟超时
});
