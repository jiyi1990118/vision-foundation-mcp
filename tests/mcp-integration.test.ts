/**
 * MCP Integration Test — verify the MCP server responds to tool calls via stdio.
 *
 * This test starts the MCP server as a subprocess, sends MCP protocol messages
 * via stdin/stdout, and verifies the responses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { join } from 'node:path';

const SERVER_SCRIPT = join(process.cwd(), 'dist', 'index.js');
const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'mcp-e2e.png');

describe('MCP Integration via stdio', { timeout: 120000 }, () => {
  let serverProcess: ReturnType<typeof spawn> | null = null;
  let messageId = 0;

  function send(msg: object): void {
    const data = JSON.stringify(msg) + '\n';
    serverProcess?.stdin?.write(data);
  }

  function waitForResponse(timeoutMs = 30000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        reject(new Error(`MCP response timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      const handler = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.trim() && line.startsWith('{')) {
            clearTimeout(timer);
            serverProcess?.stdout?.off('data', handler);
            try {
              resolve(JSON.parse(line));
            } catch {
              // Not valid JSON yet, keep waiting
            }
            return;
          }
        }
      };

      serverProcess?.stdout?.on('data', handler);
    });
  }

  beforeAll(async () => {
    // Create test image if not exists
    try {
      const img = await sharp({
        create: { width: 128, height: 128, channels: 3, background: { r: 100, g: 150, b: 200 } },
      })
        .composite([{
          input: Buffer.from('<svg width="128" height="128"><rect x="20" y="20" width="80" height="80" fill="red"/></svg>'),
          top: 0, left: 0,
        }])
        .png()
        .toBuffer();
      writeFileSync(FIXTURE, img);
    } catch { /* fixture might already exist */ }

    // Kill any existing llama-server
    try { execSync('pkill -f llama-server 2>/dev/null'); } catch {}
    await new Promise(r => setTimeout(r, 2000));

    // Start MCP server as subprocess
    serverProcess = spawn('node', [SERVER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LOG_LEVEL: 'warn' },
    });

    // Give it a moment to start
    await new Promise(r => setTimeout(r, 3000));

    serverProcess.stderr?.on('data', (d: Buffer) => {
      // Log stderr for debugging but don't fail
    });
  }, 30000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
    }
    try { execSync('pkill -f llama-server 2>/dev/null'); } catch {}
  }, 10000);

  it('responds to initialize request', async () => {
    send({
      jsonrpc: '2.0',
      id: ++messageId,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.1.0' },
      },
    });

    const resp = await waitForResponse(10000);
    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBe(1);
    expect(resp.result).toBeDefined();
    expect(resp.result.serverInfo).toBeDefined();
  }, 15000);

  it('lists vision.analyze tool', async () => {
    // First send initialized notification
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // Then list tools
    send({
      jsonrpc: '2.0',
      id: ++messageId,
      method: 'tools/list',
      params: {},
    });

    const resp = await waitForResponse(10000);
    expect(resp.result).toBeDefined();
    expect(resp.result.tools).toBeDefined();
    const toolNames = (resp.result.tools as Array<{ name: string }>).map(t => t.name);
    expect(toolNames).toContain('vision.analyze');
  }, 15000);

  it('analyzes image via vision.analyze tool', async () => {
    const imgBuf = readFileSync(FIXTURE);
    const base64 = imgBuf.toString('base64');

    send({
      jsonrpc: '2.0',
      id: ++messageId,
      method: 'tools/call',
      params: {
        name: 'vision.analyze',
        arguments: {
          image: `data:image/png;base64,${base64}`,
          intent: 'describe',
        },
      },
    });

    const resp = await waitForResponse(60000);
    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBeDefined();
    expect(resp.result?.isError).not.toBe(true);
    expect(resp.result?.content).toBeDefined();
    expect(resp.result?.structuredContent).toBeDefined();
    const structured = resp.result?.structuredContent as { metadata?: { provider?: string; runtime?: string } };
    expect(structured.metadata?.provider).toBe('gguf-smolvlm2');
    expect(structured.metadata?.runtime).toBe('llama-cpp');
  }, 90000);
});
