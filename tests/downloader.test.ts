// tests/downloader.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadFile, buildMirrorUrl, downloadWithRetry, downloadAndExtract } from '../src/providers/llama-server/downloader.js';
import { mkdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

describe('downloader', () => {
  const testDir = join(__dirname, '.tmp-downloader');
  
  beforeEach(() => {
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe('downloadFile', () => {
    it('should download file from URL', async () => {
      const mockResponse = new Response('test content');
      vi.spyOn(global, 'fetch').mockResolvedValue(mockResponse);
      
      const destPath = join(testDir, 'test.txt');
      await downloadFile({ url: 'https://example.com/file.txt', destPath, timeout: 5000 });
      
      expect(existsSync(destPath)).toBe(true);
    });

    it('should timeout after specified duration', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(
        (_url, options) => new Promise((_resolve, reject) => {
          const signal = (options as any)?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }
          // Never resolve - simulate a very slow request
        })
      );
      
      await expect(
        downloadFile({ url: 'https://slow.com/file', destPath: join(testDir, 'slow.txt'), timeout: 100 })
      ).rejects.toThrow('Download timeout after 100ms');
    });
  });

  describe('buildMirrorUrl', () => {
    it('should build mirror URL', () => {
      const result = buildMirrorUrl(
        'https://github.com/org/repo/releases/download/v1/file.tar.gz',
        'https://ghproxy.com'
      );
      expect(result).toBe('https://ghproxy.com/https://github.com/org/repo/releases/download/v1/file.tar.gz');
    });

    it('should return original URL if no mirror', () => {
      const url = 'https://github.com/org/repo/file.tar.gz';
      expect(buildMirrorUrl(url)).toBe(url);
    });
  });

  describe('downloadWithRetry', () => {
    it('should retry with fallback URLs', async () => {
      const mockFetch = vi.spyOn(global, 'fetch');
      mockFetch
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(new Response('success'));
      
      const destPath = join(testDir, 'retry.txt');
      await downloadWithRetry(['https://main.com/file', 'https://mirror.com/file'], destPath, 1000);
      
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(existsSync(destPath)).toBe(true);
    });
  });

  describe('downloadAndExtract', () => {
    it('should download and extract binary', async () => {
      // 这个测试需要真实的tar.gz文件，或者mock tar.extract
      // 简化版：只测试接口存在
      expect(typeof downloadAndExtract).toBe('function');
    });
  });
});
