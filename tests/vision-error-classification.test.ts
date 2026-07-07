import { describe, expect, it } from 'vitest';
import { NormalizeError } from '../src/core/request-normalizer.js';
import { PolicyDeniedError } from '../src/core/policy-engine.js';
import { classifyVisionError } from '../src/tools/vision-analyze.js';

describe('vision error classification', () => {
  it('preserves NormalizeError codes as non-retryable user input errors', () => {
    const classified = classifyVisionError(
      new NormalizeError('NORMALIZE_INVALID_INPUT', 'bad image'),
    );

    expect(classified).toEqual({
      code: 'NORMALIZE_INVALID_INPUT',
      message: 'bad image',
      retryable: false,
    });
  });

  it('maps file-not-found normalization errors to invalid input', () => {
    const classified = classifyVisionError(
      new NormalizeError('NORMALIZE_FILE_NOT_FOUND', 'File not found: missing.png'),
    );

    expect(classified).toEqual({
      code: 'NORMALIZE_INVALID_INPUT',
      message: 'File not found: missing.png',
      retryable: false,
    });
  });

  it('maps policy denial to POLICY_DENIED', () => {
    const classified = classifyVisionError(
      new PolicyDeniedError('reject-huge', 'Request denied by policy: reject-huge'),
    );

    expect(classified).toEqual({
      code: 'POLICY_DENIED',
      message: 'Request denied by policy: reject-huge',
      retryable: false,
    });
  });

  it('maps timeout errors to retryable TIMEOUT', () => {
    const classified = classifyVisionError(new Error('Vision analysis timed out'));

    expect(classified).toEqual({
      code: 'TIMEOUT',
      message: 'Vision analysis timed out',
      retryable: true,
    });
  });

  it('maps llama-server missing errors to RUNTIME_NOT_FOUND', () => {
    const classified = classifyVisionError(new Error('llama-server not found. Install llama.cpp'));

    expect(classified).toEqual({
      code: 'RUNTIME_NOT_FOUND',
      message: 'llama-server not found. Install llama.cpp',
      retryable: false,
    });
  });

  it('maps missing model files to retryable MODEL_DOWNLOAD_FAILED', () => {
    const classified = classifyVisionError(new Error('Model file not found: /tmp/model.gguf'));

    expect(classified).toEqual({
      code: 'MODEL_DOWNLOAD_FAILED',
      message: 'Model file not found: /tmp/model.gguf',
      retryable: true,
    });
  });
});
