/**
 * Request Normalizer — unifies all image input formats into ImageInput.
 * @see Docs/01-architecture/02-request-lifecycle.md (Stage 2)
 */
import sharp from 'sharp';
import type { ImageInput } from '../types/domain.js';
import { logger } from '../utils/logger.js';
import { getConfig } from './config.js';

/**
 * Convert various image input formats into a unified ImageInput.
 * Supports: file path, base64 string, data URI, http(s) URL.
 */
export async function normalizeImageInput(raw: string): Promise<ImageInput> {
  const config = await getConfig();
  if (!raw || typeof raw !== 'string') {
    throw new NormalizeError('NORMALIZE_INVALID_INPUT', 'Image input is empty or not a string');
  }

  let buffer: Buffer;
  let source: string;

  if (raw.startsWith('data:image/')) {
    // data:image/png;base64,xxxx
    buffer = parseDataUri(raw);
    source = 'data-uri';
  } else if (raw.startsWith('http://') || raw.startsWith('https://')) {
    buffer = await fetchUrl(raw);
    source = 'url';
  } else if (raw.startsWith('file://')) {
    buffer = await readFile(raw.slice('file://'.length));
    source = 'file';
  } else if (/^[A-Za-z0-9+/=\r\n]+$/.test(raw) && raw.length > 100) {
    // Heuristic: looks like base64
    buffer = Buffer.from(raw, 'base64');
    source = 'base64';
  } else {
    // Treat as file path
    buffer = await readFile(raw);
    source = 'file';
  }

  // Size check
  if (buffer.length > config.security.maxImageSizeBytes) {
    throw new NormalizeError(
      'NORMALIZE_TOO_LARGE',
      `Image size ${buffer.length} exceeds limit ${config.security.maxImageSizeBytes}`,
    );
  }

  // Format validation via magic numbers
  const mimeType = detectMimeType(buffer);

  logger.debug('Image normalized', { source, size: buffer.length, mimeType });

  return {
    buffer,
    mimeType,
    source,
    size: buffer.length,
  };
}

function parseDataUri(uri: string): Buffer {
  const match = uri.match(/^data:image\/[\w+]+;base64,(.+)$/);
  if (!match || !match[1]) {
    throw new NormalizeError('NORMALIZE_INVALID_INPUT', 'Invalid data URI format');
  }
  return Buffer.from(match[1], 'base64');
}

async function fetchUrl(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new NormalizeError('NORMALIZE_INVALID_INPUT', `Unsupported protocol: ${parsed.protocol}`);
  }
  // SSRF protection: block private IPs
  // (full implementation in security module, basic check here)
  const hostname = parsed.hostname;
  if (
    hostname === 'localhost' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('169.254.')
  ) {
    throw new NormalizeError('NORMALIZE_INVALID_INPUT', 'URL resolves to private IP (SSRF blocked)');
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new NormalizeError(
      'NORMALIZE_INVALID_INPUT',
      `Failed to fetch URL: ${response.status} ${response.statusText}`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function readFile(path: string): Promise<Buffer> {
  const fs = await import('node:fs/promises');
  try {
    return await fs.readFile(path);
  } catch {
    throw new NormalizeError('NORMALIZE_FILE_NOT_FOUND', `File not found: ${path}`);
  }
}

function detectMimeType(buffer: Buffer): string {
  if (buffer.length < 4) {
    throw new NormalizeError('NORMALIZE_INVALID_INPUT', 'Buffer too small to be a valid image');
  }
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // WebP: RIFF .... WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer.length >= 12 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  throw new NormalizeError(
    'NORMALIZE_INVALID_INPUT',
    'Unrecognized image format (magic number mismatch)',
  );
}

/** Validate that a buffer is a decodable image and return sharp instance. */
export async function validateImage(buffer: Buffer): Promise<sharp.Sharp> {
  try {
    const image = sharp(buffer);
    const meta = await image.metadata();
    if (!meta.width || !meta.height) {
      throw new NormalizeError('NORMALIZE_INVALID_INPUT', 'Image has no dimensions');
    }
    return image;
  } catch (e) {
    if (e instanceof NormalizeError) throw e;
    throw new NormalizeError('NORMALIZE_INVALID_INPUT', 'Image decode failed');
  }
}

export class NormalizeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NormalizeError';
  }
}
