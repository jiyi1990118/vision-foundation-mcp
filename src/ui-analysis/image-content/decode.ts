/**
 * Shared raw-image decoder. The orchestrator decodes the source image exactly
 * once and passes the {@link DecodedImage} to every pixel-sampling engine
 * (media-area filter / style extractor / overlay detector), avoiding three
 * independent `sharp(...).raw()` passes over the same buffer.
 *
 * Pure decode + strip alpha; no resizing. Mirrors the inline pattern each
 * consumer previously ran. Re-exported from the image-content barrel.
 *
 * @see ../ir/types.js  (DecodedImage)
 */
import sharp from 'sharp';
import type { ImageInput } from '../../types/domain.js';
import type { DecodedImage } from '../ir/types.js';

export async function decodeRawImage(image: ImageInput): Promise<DecodedImage> {
  const { data, info } = await sharp(image.buffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, stride: info.channels };
}

export type { DecodedImage } from '../ir/types.js';
