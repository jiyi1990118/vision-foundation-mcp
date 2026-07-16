/**
 * GGUF Provider - SmolVLM-500M via llama.cpp llama-server.
 *
 * Thin configuration of BaseLlamaCppProvider for the SmolVLM-500M-Instruct
 * GGUF model. All lifecycle, caching, and inference logic lives in the base.
 *
 * @see Docs/01-architecture/06-provider-runtime.md
 */
import { BaseLlamaCppProvider } from '../llama-server/base-provider.js';
import { ensureGGUFModel } from '../../core/model-manager.js';

export class GGUFProvider extends BaseLlamaCppProvider {
  constructor() {
    super({
      name: 'gguf-smolvlm',
      requirements: { minMemoryMB: 256, gpuRequired: false, modelSizeMB: 417 },
      maxOutputTokens: 512,
      maxImageDimension: 512,
      minFreeRamMB: 512,
      minVramMB: 2048,
      ensureModel: ensureGGUFModel,
    });
  }
}
