/**
 * SmolVLM2 GGUF Provider - SmolVLM2-500M-Video-Instruct via llama.cpp.
 *
 * Thin configuration of BaseLlamaCppProvider. Intended as the default
 * fast-tier provider (better description quality than SmolVLM-500M) while
 * preserving the same provider/runtime contract.
 */
import { BaseLlamaCppProvider } from '../llama-server/base-provider.js';
import { ensureSmolVLM2Model } from '../../core/model-manager.js';

export class SmolVLM2Provider extends BaseLlamaCppProvider {
  constructor() {
    super({
      name: 'gguf-smolvlm2',
      requirements: { minMemoryMB: 256, gpuRequired: false, modelSizeMB: 500 },
      maxOutputTokens: 768,
      maxImageDimension: 1024,
      minFreeRamMB: 512,
      minVramMB: 2048,
      ensureModel: ensureSmolVLM2Model,
    });
  }
}
