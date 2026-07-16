import { describe, it, expect } from 'vitest';
import { LlamaServerProcess } from '../src/providers/llama-server/process.js';

describe('LlamaServerProcess.inferWithRetry abort handling', () => {
  it('fails fast without restart when the signal is already aborted', async () => {
    const proc = new LlamaServerProcess({
      name: 'test',
      modelPath: '/dummy',
      mmprojPath: '/dummy',
      port: 12345,
      gpuLayers: 0,
      threads: 1,
    });
    const controller = new AbortController();
    controller.abort();

    let restartCalls = 0;
    await expect(
      proc.inferWithRetry({}, async () => { restartCalls++; }, 2, controller.signal),
    ).rejects.toThrow('Inference aborted by caller');
    expect(restartCalls).toBe(0);
  });
});
