import { describe, expect, it } from 'vitest';
import { resolveSkillNames } from '../src/core/execution-planner.js';
import {
  buildSkillProviderOverrides,
  buildOcrProviderWarnings,
  selectProvider,
  shouldInspectAnnotationsForRequest,
  shouldRunKeyContentExtraction,
} from '../src/tools/vision-analyze.js';
import type { VisionProvider } from '../src/providers/types.js';
import type { ImageInput, InferenceResponse, InferenceRequest } from '../src/types/domain.js';

function fakeProvider(opts: {
  name: string;
  runtime: string;
  minMemoryMB: number;
  gpuRequired: boolean;
  skills?: string[];
}): VisionProvider {
  return {
    name: opts.name,
    runtime: opts.runtime,
    supportedRuntimes: [opts.runtime],
    supportedSkills: opts.skills ?? ['classify', 'ocr', 'summary'],
    requirements: { minMemoryMB: opts.minMemoryMB, gpuRequired: opts.gpuRequired, modelSizeMB: 100 },
    async load() {},
    async infer(_req: InferenceRequest): Promise<InferenceResponse> {
      return { text: opts.name, duration: 1 };
    },
    async unload() {},
    isLoaded() { return true; },
  };
}

const gguf = fakeProvider({ name: 'gguf-smolvlm', runtime: 'llama-cpp', minMemoryMB: 512, gpuRequired: false });
const minicpm = fakeProvider({ name: 'minicpm-v', runtime: 'llama-cpp', minMemoryMB: 4096, gpuRequired: true });
const ocr = fakeProvider({ name: 'ppu-paddle-ocr', runtime: 'native-ocr', minMemoryMB: 256, gpuRequired: false, skills: ['ocr'] });

const goodResources = { memoryAvailableMB: 8192, hasGPU: true };

describe('selectProvider (vision-analyze routing)', () => {
  it('returns the fast provider by default', () => {
    const p = selectProvider([gguf, minicpm], { options: {}, resources: goodResources, requestedSkills: ['classify'] });
    expect(p.name).toBe('gguf-smolvlm');
  });

  it('returns the high-quality provider when quality=high and resources allow', () => {
    const p = selectProvider([gguf, minicpm], { options: { quality: 'high' }, resources: goodResources, requestedSkills: ['classify'] });
    expect(p.name).toBe('minicpm-v');
  });

  it('routes to high-quality provider on GPU hosts even when transient free memory is low', () => {
    const p = selectProvider([gguf, minicpm], {
      options: { quality: 'high' },
      resources: { memoryAvailableMB: 64, totalMemoryMB: 16384, hasGPU: true },
      requestedSkills: ['classify'],
    });
    expect(p.name).toBe('minicpm-v');
  });

  it('falls back to fast provider when quality=high but GPU missing', () => {
    const p = selectProvider([gguf, minicpm], {
      options: { quality: 'high' },
      resources: { memoryAvailableMB: 8192, hasGPU: false },
      requestedSkills: ['classify'],
    });
    expect(p.name).toBe('gguf-smolvlm');
  });

  it('respects explicit options.provider', () => {
    const p = selectProvider([gguf, minicpm], {
      options: { provider: 'minicpm-v' },
      resources: goodResources,
      requestedSkills: ['classify'],
    });
    expect(p.name).toBe('minicpm-v');
  });

  it('falls back when only one candidate is registered', () => {
    const p = selectProvider([gguf], { options: { quality: 'high' }, resources: goodResources, requestedSkills: ['classify'] });
    expect(p.name).toBe('gguf-smolvlm');
  });

  it('routes OCR-only requests to a dedicated OCR provider when registered', () => {
    const p = selectProvider([gguf, ocr], { options: {}, resources: goodResources, requestedSkills: ['ocr'] });
    expect(p.name).toBe('ppu-paddle-ocr');
  });

  it('keeps mixed screenshot analysis on the default VLM provider', () => {
    const p = selectProvider([ocr, gguf], {
      options: {},
      resources: goodResources,
      requestedSkills: ['classify', 'ocr', 'summary'],
    });
    expect(p.name).toBe('gguf-smolvlm');
  });

  it('includes OCR in auto target requests before provider routing', () => {
    const requestedSkills = resolveSkillNames(undefined, 'auto', { target: { color: 'red', description: '红框内容' } });
    const p = selectProvider([ocr, gguf], {
      options: { target: { color: 'red', description: '红框内容' } },
      resources: goodResources,
      requestedSkills,
    });

    expect(requestedSkills).toEqual(['classify', 'summary', 'ocr']);
    expect(p.name).toBe('gguf-smolvlm');
  });

  it('builds an OCR skill override for mixed requests when a dedicated OCR provider is registered', () => {
    const overrides = buildSkillProviderOverrides([gguf, ocr], gguf, ['classify', 'ocr', 'summary']);
    expect(overrides.ocr?.name).toBe('ppu-paddle-ocr');
  });

  it('does not override OCR-only requests when the selected provider is already OCR-only', () => {
    const overrides = buildSkillProviderOverrides([gguf, ocr], ocr, ['ocr']);
    expect(overrides.ocr).toBeUndefined();
  });

  it('does not run target extraction for explicit classify-only target requests without OCR', () => {
    const requestedSkills = resolveSkillNames(['classify'], '提取红框', { target: { color: 'red' } });

    expect(requestedSkills).toEqual(['classify']);
    expect(shouldRunKeyContentExtraction({
      classify: {
        skill: 'classify',
        success: true,
        data: { category: 'screenshot', confidence: 0.9 },
        duration: 1,
      },
    }, {
      target: { color: 'red' },
      intent: '提取红框',
      annotations: undefined,
      skillNames: requestedSkills,
    })).toBe(false);
  });

  it('runs target extraction for auto target requests after OCR succeeds', () => {
    const requestedSkills = resolveSkillNames(undefined, 'auto', { target: { color: 'red', description: '红框内容' } });

    expect(requestedSkills).toEqual(['classify', 'summary', 'ocr']);
    expect(shouldRunKeyContentExtraction({
      classify: {
        skill: 'classify',
        success: true,
        data: { category: 'screenshot', confidence: 0.9 },
        duration: 1,
      },
      summary: {
        skill: 'summary',
        success: true,
        data: { description: '界面截图' },
        duration: 1,
      },
      ocr: {
        skill: 'ocr',
        success: true,
        data: { texts: [{ text: '红框内容', position: '10,10,100,100', confidence: 0.9 }] },
        duration: 1,
      },
    }, {
      target: { color: 'red', description: '红框内容' },
      intent: 'auto',
      annotations: undefined,
      skillNames: requestedSkills,
    })).toBe(true);
  });

  it('runs target extraction for requirement image requests with detected red annotations', () => {
    const requestedSkills = resolveSkillNames(undefined, '分析 TAPD 需求图片，返回关键内容和总结', {});

    expect(requestedSkills).toEqual(['classify', 'ocr', 'summary']);
    expect(shouldRunKeyContentExtraction({
      classify: {
        skill: 'classify',
        success: true,
        data: { category: 'screenshot', confidence: 0.9 },
        duration: 1,
      },
      ocr: {
        skill: 'ocr',
        success: true,
        data: { texts: [{ text: '变动配料：左：菠萝+1', position: '37,1058,300,1076', confidence: 0.9 }] },
        duration: 1,
      },
    }, {
      intent: '分析 TAPD 需求图片，返回关键内容和总结',
      annotations: { redBoxes: [{ box: '24,1014,702,1118', confidence: 0.75, insideText: [], insideTextLines: [], nearbyText: [] }] },
      skillNames: requestedSkills,
    })).toBe(true);
  });

  it('inspects annotations for requirement image requests before red boxes are known', () => {
    expect(shouldInspectAnnotationsForRequest({
      intent: '分析 TAPD 需求图片，返回关键内容和总结',
      skillNames: ['classify', 'ocr', 'summary'],
      target: undefined,
    })).toBe(true);
  });

  it('warns when requirement OCR falls back to a VLM provider without dedicated OCR', () => {
    expect(buildOcrProviderWarnings({
      intent: '分析 TAPD 需求图片，返回关键内容和总结',
      skillNames: ['classify', 'ocr', 'summary'],
      selectedProvider: gguf,
      providerOverrides: {},
    })).toEqual([
      '未启用专用 OCR provider，需求图红框/小字提取可能不可靠；建议设置 VISION_OCR_PROVIDER=ppu-paddle-ocr。',
    ]);
  });

  it('does not warn when a dedicated OCR override is available', () => {
    expect(buildOcrProviderWarnings({
      intent: '分析 TAPD 需求图片，返回关键内容和总结',
      skillNames: ['classify', 'ocr', 'summary'],
      selectedProvider: gguf,
      providerOverrides: { ocr },
    })).toEqual([]);
  });
});
