#!/usr/bin/env node
/**
 * Base64 输入示例 — 直接传入 base64 编码的图片数据，而非文件路径。
 *
 * 适用于：图片来自网络请求、数据库 BLOB、剪贴板等非文件来源。
 *
 * 用法:
 *   node examples/base64-input.mjs <image-path>
 *   （示例仍从文件读取，但演示如何构造 base64 data URI 传入 MCP）
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverScript = join(__dirname, '..', 'dist', 'index.js');

const imageArg = process.argv[2];
if (!imageArg) {
  console.error('Usage: node examples/base64-input.mjs <image-path>');
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
    clientInfo: { name: 'example-base64', version: '0.0.1' },
  });
  notify('notifications/initialized', {});

  const imgBuf = readFileSync(imageArg);
  const ext = imageArg.toLowerCase().endsWith('.png') ? 'png'
    : imageArg.toLowerCase().endsWith('.webp') ? 'webp'
    : 'jpeg';
  const base64 = imgBuf.toString('base64');
  const dataUri = `data:image/${ext};base64,${base64}`;

  console.log(`Image: ${imageArg} (${(imgBuf.length / 1024).toFixed(1)}KB → ${base64.length} base64 chars)`);

  const call = await send('tools/call', {
    name: 'vision.analyze',
    arguments: {
      image: dataUri,
      intent: 'classify this image and describe its main visual elements',
    },
  });

  const sc = call.result?.structuredContent;
  if (sc) {
    console.log('\n=== Result ===');
    console.log('Category :', sc.category);
    console.log('Confidence:', sc.confidence);
    console.log('Summary  :', sc.summary);
    if (sc.classify?.reasoning) console.log('Reasoning:', sc.classify.reasoning);
    console.log('Provider :', sc.metadata?.provider);
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
