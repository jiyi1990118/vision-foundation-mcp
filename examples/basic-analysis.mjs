#!/usr/bin/env node
/**
 * 基础图片分析示例 — 使用默认 SmolVLM fast provider。
 *
 * 用法:
 *   node examples/basic-analysis.mjs <image-path>
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverScript = join(__dirname, '..', 'dist', 'index.js');

const imageArg = process.argv[2];
if (!imageArg) {
  console.error('Usage: node examples/basic-analysis.mjs <image-path>');
  process.exit(2);
}

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
    try {
      const msg = JSON.parse(line);
      const resolver = pending.get(msg.id);
      if (resolver) { resolver(msg); pending.delete(msg.id); }
    } catch {}
  }
});

proc.stderr.on('data', (d) => process.stderr.write(d));

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
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'example', version: '0.0.1' },
  });
  notify('notifications/initialized', {});

  const imgBuf = readFileSync(imageArg);
  const ext = imageArg.toLowerCase().endsWith('.jpeg') || imageArg.toLowerCase().endsWith('.jpg') ? 'jpeg' : 'png';
  const dataUri = `data:image/${ext};base64,${imgBuf.toString('base64')}`;

  const call = await send('tools/call', {
    name: 'vision.analyze',
    arguments: { image: dataUri, intent: 'describe this image in detail' },
  });

  const sc = call.result?.structuredContent;
  if (sc) {
    console.log('Category :', sc.category);
    console.log('Confidence:', sc.confidence);
    console.log('Summary  :', sc.summary);
    console.log('Provider :', sc.metadata?.provider);
    console.log('Runtime :', sc.metadata?.runtime);
    console.log('Duration :', sc.metadata?.duration, 'ms');
  } else {
    console.log(JSON.stringify(call.result, null, 2));
  }

  proc.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => {
  console.error('Failed:', e.message);
  proc.kill('SIGTERM');
  process.exit(1);
});