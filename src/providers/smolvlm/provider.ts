/**
 * SmolVLM-500M-Instruct Provider — optimized ONNX inference.
 *
 * Features:
 * - KV cache: 80x speedup (29s → 0.36s per decode step)
 * - Runtime detection: auto-selects CoreML (Apple Silicon) / CUDA (NVIDIA) / CPU
 * - Execution provider fallback chain
 *
 * @see Docs/01-architecture/06-provider-runtime.md
 * @see Docs/01-architecture/08-lifecycle-manager.md
 */

import {
  AutoModelForVision2Seq,
  AutoProcessor,
  RawImage,
  Tensor,
  env,
} from '@huggingface/transformers';
import type {
  InferenceRequest,
  InferenceResponse,
} from '../../types/domain.js';
import type { VisionProvider } from '../types.js';
import { logger } from '../../utils/logger.js';
import { getRuntimeConfig, buildSessionOptions, resetRuntimeCache, type RuntimeConfig } from '../../core/runtime-detector.js';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ── Config ─────────────────────────────────────────────

env.allowRemoteModels = true;
env.cacheDir = path.join(os.homedir(), '.vision-mcp', 'models');

const HF_ENDPOINT = process.env.HF_ENDPOINT || 'https://hf-mirror.com';
env.remoteHost = HF_ENDPOINT;
env.remotePathTemplate = '{model}/resolve/{revision}/';

const MODEL_ID = 'HuggingFaceTB/SmolVLM-500M-Instruct';
const NUM_LAYERS = 32;
const DEFAULT_EOS_TOKEN_ID = 49279;
const VOCAB_SIZE = 49280;

// ── Provider ───────────────────────────────────────────

export class SmolVLMProvider implements VisionProvider {
  readonly name = 'smolvlm';
  readonly runtime = 'onnx';
  readonly supportedRuntimes = ['onnx'];
  readonly supportedSkills = [
    'classify', 'ocr', 'summary', 'moderation',
  ];
  readonly requirements = {
    minMemoryMB: 1024,
    gpuRequired: false,
    modelSizeMB: 800,
  };

  private loaded = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private model: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private processor: any = null;
  private eosTokenId = DEFAULT_EOS_TOKEN_ID;
  private runtimeConfig: RuntimeConfig | null = null;

  async load(): Promise<void> {
    if (this.loaded) return;

    // Detect hardware and get runtime config
    this.runtimeConfig = await getRuntimeConfig();
    logger.info('SmolVLM loading...', {
      modelId: MODEL_ID,
      ep: this.runtimeConfig.provider,
      threads: this.runtimeConfig.threads,
      fallbackChain: this.runtimeConfig.fallbackChain.map((f) => f.label),
    });

    // Try each step in the fallback chain until one succeeds
    const processor = await AutoProcessor.from_pretrained(MODEL_ID);
    let lastError: Error | null = null;

    for (const step of this.runtimeConfig.fallbackChain) {
      const stepConfig: RuntimeConfig = {
        ...this.runtimeConfig,
        provider: step.provider,
        dtype: step.dtype,
      };
      const sessionOpts = buildSessionOptions(stepConfig);

      try {
        logger.info('Trying EP', { label: step.label, provider: step.provider });

        this.model = await AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
          dtype: step.dtype,
          session_options: sessionOpts,
        });
        this.processor = processor;

        // Update active config to the one that worked
        this.runtimeConfig = stepConfig;
        this.eosTokenId = this.readEosTokenId();

        this.loaded = true;
        logger.info('SmolVLM loaded', {
          modelId: MODEL_ID,
          ep: step.provider,
          label: step.label,
          eosTokenId: this.eosTokenId,
          maxTokens: this.runtimeConfig.recommendedMaxTokens,
        });
        return; // Success — stop trying fallbacks
      } catch (e) {
        lastError = e as Error;
        logger.warn('EP load failed, trying next fallback', {
          label: step.label,
          error: (e as Error).message?.slice(0, 100),
        });
      }
    }

    // All fallbacks failed
    logger.error('SmolVLM load failed — all fallbacks exhausted', {
      error: lastError?.message,
    });
    throw lastError ?? new Error('Failed to load SmolVLM with all execution providers');
  }

  async infer(req: InferenceRequest): Promise<InferenceResponse> {
    if (!this.loaded || !this.model || !this.processor) {
      await this.load();
    }

    const start = Date.now();
    const maxTokens = Math.min(
      req.maxTokens,
      this.runtimeConfig?.recommendedMaxTokens ?? 128,
    );

    try {
      // 1. Load image via temp file
      const tmpPath = path.join(tmpdir(), `vision-mcp-${Date.now()}.png`);
      writeFileSync(tmpPath, req.image.buffer);
      let image;
      try {
        image = await RawImage.read(tmpPath);
      } finally {
        unlinkSync(tmpPath);
      }

      // 2. Build prompt + process inputs
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'image' },
            { type: 'text', text: req.prompt },
          ],
        },
      ];
      const prompt = this.processor.apply_chat_template(messages, {
        add_generation_prompt: true,
      });
      const rgbImage = image.rgb();
      const inputs = await this.processor(prompt, [rgbImage]);
      const seqLen = inputs.input_ids.dims[1];

      logger.debug('Inference started', { seqLen, maxTokens });

      // 3. Prefill (first forward: full input → logits + KV cache)
      const tPrefill = Date.now();
      const prefillOutput = await this.model(inputs);
      const prefillTime = Date.now() - tPrefill;

      // Get first token (argmax of last position)
      const token1 = this.argmaxLast(prefillOutput.logits, seqLen);
      const generatedTokens: number[] = [token1];

      if (token1 === this.eosTokenId) {
        void prefillTime;
        return this.buildResult(generatedTokens, start);
      }

      // 4. Extract KV cache from prefill output
      let pastKV = this.extractKVCache(prefillOutput);

      // 5. Decode loop (each step: 1 token + KV cache → 1 token + updated KV cache)
      let currentPosition = seqLen;
      let totalDecodeTime = 0;

      for (let step = 1; step < maxTokens; step++) {
        const tDecode = Date.now();

        const decodeInput = {
          input_ids: new Tensor('int64', BigInt64Array.from([BigInt(generatedTokens[step - 1] ?? 0)]), [1, 1]),
          attention_mask: new Tensor('int64', BigInt64Array.from([1n]), [1, 1]),
          position_ids: new Tensor('int64', BigInt64Array.from([BigInt(currentPosition)]), [1, 1]),
          pixel_values: inputs.pixel_values,
          pixel_attention_mask: inputs.pixel_attention_mask,
          ...pastKV,
        };

        // Call _forward directly (bypass _prepare_inputs_for_generation which resets KV cache)
        const decodeOutput = await this.model._forward(this.model, decodeInput);
        const decodeTime = Date.now() - tDecode;
        totalDecodeTime += decodeTime;

        // Get next token
        const decodeSeqLen = decodeOutput.logits.dims[1];
        const nextToken = this.argmaxLast(decodeOutput.logits, decodeSeqLen);

        if (nextToken === this.eosTokenId) {
          logger.debug('EOS generated', { step, decodeTime });
          break;
        }

        generatedTokens.push(nextToken);

        // Update KV cache for next iteration
        pastKV = this.extractKVCache(decodeOutput);

        currentPosition++;

        if (step % 10 === 0) {
          logger.debug('Generating', {
            step,
            decodeTime: `${decodeTime}ms`,
            total: generatedTokens.length,
          });
        }
      }

      const duration = Date.now() - start;
      logger.info('Inference completed', {
        duration,
        prefillTime,
        decodeSteps: generatedTokens.length - 1,
        avgDecodeTime: totalDecodeTime / (generatedTokens.length - 1),
        textLength: this.processor.decode(generatedTokens, { skip_special_tokens: true }).length,
      });

      void prefillTime;
      void totalDecodeTime;
      return this.buildResult(generatedTokens, start);
    } catch (e) {
      logger.error('Inference failed', { error: (e as Error).message });
      throw e;
    }
  }

  async unload(): Promise<void> {
    if (!this.loaded) return;
    logger.info('SmolVLM unloading...', { provider: this.name });
    this.model = null;
    this.processor = null;
    this.loaded = false;
    this.runtimeConfig = null;
    if (global.gc) global.gc();
    // Reset runtime cache so next load re-detects hardware
    resetRuntimeCache();
    logger.info('SmolVLM unloaded', { provider: this.name });
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  // ── Helpers ──────────────────────────────────────────

  private readEosTokenId(): number {
    try {
      const cacheDir = env.cacheDir ?? path.join(os.homedir(), '.vision-mcp', 'models');
      const genConfigPath = path.join(cacheDir, MODEL_ID, 'generation_config.json');
      if (existsSync(genConfigPath)) {
        const genConfig = JSON.parse(readFileSync(genConfigPath, 'utf8'));
        if (genConfig.eos_token_id) return genConfig.eos_token_id;
      }
    } catch {
      // Use default
    }
    return DEFAULT_EOS_TOKEN_ID;
  }

  private argmaxLast(logits: Tensor, seqLen: number): number {
    const data = logits.data as Float32Array | BigInt64Array;
    const offset = (seqLen - 1) * VOCAB_SIZE;
    let bestId = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < VOCAB_SIZE; i++) {
      const score = data instanceof Float32Array
        ? (data[offset + i] ?? -Infinity)
        : Number(data[offset + i] ?? 0n);
      if (score > bestScore) {
        bestScore = score;
        bestId = i;
      }
    }
    return bestId;
  }

  private extractKVCache(output: Record<string, Tensor>): Record<string, Tensor> {
    const kv: Record<string, Tensor> = {};
    for (let i = 0; i < NUM_LAYERS; i++) {
      const presentKey = `present.${i}.key`;
      const presentVal = `present.${i}.value`;
      const keyTensor = output[presentKey];
      const valTensor = output[presentVal];
      if (keyTensor && valTensor) {
        kv[`past_key_values.${i}.key`] = keyTensor;
        kv[`past_key_values.${i}.value`] = valTensor;
      }
    }
    return kv;
  }

  private buildResult(
    tokens: number[],
    startTime: number,
  ): InferenceResponse {
    const text = this.processor
      .decode(tokens, { skip_special_tokens: true })
      .trim();

    return {
      text,
      duration: Date.now() - startTime,
    };
  }
}
