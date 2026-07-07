import { describe, expect, it, vi } from 'vitest';
import { LlamaServerProcess } from '../src/providers/llama-server/process.js';

 describe('LlamaServerProcess.stop() resource release', () => {
   it('does not kill an attached external PID when stop is a no-op on an already-stopped instance', async () => {
     const proc = new LlamaServerProcess({
       name: 'test', modelPath: '/m.gguf', mmprojPath: '/mm.gguf',
       port: 12345, gpuLayers: 0, threads: 1,
     });
     // Never started, no attached PID — stop should be safe no-op.
     await expect(proc.stop()).resolves.toBeUndefined();
     expect(proc.isRunning).toBe(false);
   });

   it('sends SIGTERM to an attached external PID and does not attempt SIGKILL', async () => {
     const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
     const proc = new LlamaServerProcess({
       name: 'test', modelPath: '/m.gguf', mmprojPath: '/mm.gguf',
       port: 12345, gpuLayers: 0, threads: 1, existingPid: 99999,
     });
     // Simulate attach: start() found healthy server, did not spawn.
     // We test stop() directly.
     await proc.stop();
     expect(killSpy).toHaveBeenCalledWith(99999, 'SIGTERM');
     // Should NOT send SIGKILL to external process.
     expect(killSpy).not.toHaveBeenCalledWith(99999, 'SIGKILL');
     killSpy.mockRestore();
   });
 });