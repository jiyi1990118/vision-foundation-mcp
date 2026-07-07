#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const imageArg = process.argv[2];
const intent = process.argv[3] ?? 'describe this image in detail';
if (!imageArg) {
  console.error('Usage: node analyze-one.mjs <image-path> [intent]');
  process.exit(2);
}

const serverScript = '/Users/jary/Desktop/MCP文档/vision-foundation-mcp/dist/index.js';
const proc = spawn('node', [serverScript], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, LOG_LEVEL: 'warn' },
});

let buf = '';
let msgId = 0;
const pending = new Map();

proc.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim() || !line.startsWith('{')) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const resolver = pending.get(msg.id);
    if (resolver) {
      resolver(msg);
      pending.delete(msg.id);
    }
  }
});

proc.stderr.on('data', (d) => process.stderr.write(d));
proc.on('exit', (code) => {
  if (code !== 0 && !process.exited) process.exit(code ?? 1);
});

function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function main() {
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'analyze-one', version: '0.0.1' },
  });
  console.error('initialized:', init.result.serverInfo);
  notify('notifications/initialized', {});

  const list = await send('tools/list', {});
  console.error('tools:', list.result.tools.map((t) => t.name).join(', '));

  const imgBuf = readFileSync(imageArg);
  const dataUri = `data:image/png;base64,${imgBuf.toString('base64')}`;
  const call = await send('tools/call', {
    name: 'vision.analyze',
    arguments: { image: dataUri, intent },
  });

  console.log(JSON.stringify(call.result, null, 2));
  process.exited = true;
  proc.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => {
  console.error('failed:', e);
  proc.kill('SIGTERM');
  process.exit(1);
});