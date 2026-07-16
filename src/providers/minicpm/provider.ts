/**
 * MiniCPM-V Provider - high-quality vision model via llama.cpp llama-server.
 *
 * Thin configuration of BaseLlamaCppProvider for MiniCPM-V 2.6. Routes
 * `quality=high` requests; requires a GPU (Metal/CUDA) and ~2GB model.
 *
 * @see Docs/01-architecture/06-provider-runtime.md
 */
import { BaseLlamaCppProvider } from '../llama-server/base-provider.js';
import { ensureMiniCPMModel } from '../../core/model-manager.js';

export class MiniCPMProvider extends BaseLlamaCppProvider {
  constructor() {
    super({
      name: 'minicpm-v',
      requirements: { minMemoryMB: 4096, gpuRequired: true, modelSizeMB: 2048 },
      maxOutputTokens: 1024,
      maxImageDimension: 2048,
      minFreeRamMB: 1024,
      minVramMB: 4096,
      ensureModel: ensureMiniCPMModel,
    });
  }
}
