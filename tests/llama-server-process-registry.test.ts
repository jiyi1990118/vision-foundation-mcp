import { describe, expect, it } from 'vitest';
import {
  extractPortFromCommand,
  extractPidFromLsofLine,
  findExistingLlamaServerProcess,
} from '../src/providers/llama-server/process-registry.js';

describe('llama-server process registry', () => {
  it('extracts --port value from llama-server command', () => {
    expect(extractPortFromCommand('llama-server -m model.gguf --port 48231 --host 127.0.0.1')).toBe(48231);
    expect(extractPortFromCommand('llama-server -m model.gguf --port=48232 --host 127.0.0.1')).toBe(48232);
  });

  it('extracts pid from lsof output line', () => {
    expect(extractPidFromLsofLine('node     12345 jary   22u  IPv4 0x0  TCP 127.0.0.1:48231 (LISTEN)')).toBe(12345);
    expect(extractPidFromLsofLine('COMMAND PID USER FD TYPE')).toBeNull();
  });

  it('finds existing llama-server for a model path and port from ps output', () => {
    const found = findExistingLlamaServerProcess({
      modelPath: '/models/a.gguf',
      listCommands: () => [
        '111 /opt/homebrew/bin/llama-server -m /models/other.gguf --port 41000',
        '222 /opt/homebrew/bin/llama-server -m /models/a.gguf --mmproj /models/mmproj.gguf --port 42001',
      ],
    });

    expect(found).toEqual({ pid: 222, port: 42001 });
  });

  it('returns null when no process matches the model path', () => {
    const found = findExistingLlamaServerProcess({
      modelPath: '/models/missing.gguf',
      listCommands: () => ['111 llama-server -m /models/other.gguf --port 41000'],
    });

    expect(found).toBeNull();
  });
});
