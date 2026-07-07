// tests/resolver.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveLlamaServerCandidates, ensureLlamaServer } from '../src/providers/llama-server/resolver.js';
import { join } from 'node:path';

describe('resolver', () => {
  describe('resolveLlamaServerCandidates', () => {
    it('should return candidates in correct priority order', () => {
      const candidates = resolveLlamaServerCandidates({
        env: { LLAMA_SERVER_PATH: '/custom/path' },
        packageRoot: '/project',
        homeDir: '/home/user',
      });
      
      expect(candidates[0]).toBe('/custom/path');
      expect(candidates[1]).toBe('/project/bin/llama-server');
      expect(candidates[2]).toBe('/home/user/.vision-mcp/bin/llama-server');
    });

    it('should include system paths', () => {
      const candidates = resolveLlamaServerCandidates({});
      expect(candidates).toContain('/opt/homebrew/bin/llama-server');
    });
  });

  describe('ensureLlamaServer', () => {
    it('should return existing path if found', async () => {
      // Mock: 假设找到了已存在的llama-server
      const result = await ensureLlamaServer({ 
        skipAutoInstall: true // 测试时跳过自动安装
      });
      expect(typeof result).toBe('string');
    });
  });
});
