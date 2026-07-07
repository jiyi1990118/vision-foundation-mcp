#!/usr/bin/env node
/**
 * 自定义意图示例 — 演示如何传入任意分析意图，让 Skill 引擎自由匹配。
 *
 * 不预设 intent，直接用自然语言描述需求：
 *   - "count the number of people in this image"
 *   - "what colors dominate this image?"
 *   - "is this image suitable for a professional presentation?"
 *
 * 用法:
 *   node examples/custom-intent.mjs <image-path> "your question here"
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverScript = join(__dirname, '..', 'dist', 'index.js');

const imageArg = process.argv[2];
const intentArg = process.argv[3] || 'analyze this image and tell me anything notable';
if (!imageArg) {
  console.error('Usage: node examples/custom-intent.mjs <image-path> "your question"');
  console.error('  e.g. node examples/custom-intent.mjs photo.jpg "how many people are visible?"');
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
    clientInfo: { name: 'example-custom-intent', version: '0.0.1' },
  });
  notify('notifications/initialized', {});

  const imgBuf = readFileSync(imageArg);
  const ext = imageArg.toLowerCase().endsWith('.png') ? 'png'
    : imageArg.toLowerCase().endsWith('.webp') ? 'webp'
    : 'jpeg';
  const dataUri = `data:image/${ext};base64,${imgBuf.toString('base64')}`;

  console.log(`Image : ${imageArg}`);
  console.log(`Intent: "${intentArg}"\n`);

  const call = await send('tools/call', {
    name: 'vision.analyze',
    arguments: { image: dataUri, intent: intentArg },
  });

  const sc = call.result?.structuredContent;
  if (sc) {
    console.log('=== Result ===');
    console.log('Category :', sc.category);
    console.log('Confidence:', sc.confidence);
    console.log('Summary  :', sc.summary);
    if (sc.ocr?.text?.length) {
      console.log('OCR text :', sc.ocr.text.join(' | '));
    }
    console.log('Provider :', sc.metadata?.provider);
    console.log('Skill    :', sc.metadata?.skill);
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
