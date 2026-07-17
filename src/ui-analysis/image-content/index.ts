/**
 * Barrel export for the UI analysis image-content layer (Stream S13).
 *
 * Produces recoverable image/icon/logo info (crop rectangle + alt text) from
 * algorithmically detected `MediaArea`s, plus an opt-in VLM description path
 * (`describeImageContents`) gated by `use_llm=true`, and an opt-in base64
 * data-URL embedder (`embedImageDataUrls`) for the default no-VLM path.
 *
 * @see ./image-content-extractor.ts  (extractImageContents / ImageContentInfo)
 */
export { extractImageContents } from './image-content-extractor.js';
export type { ImageContentInfo } from './image-content-extractor.js';
export { describeImageContents } from './image-describer.js';
export type { DescribeOptions } from './image-describer.js';
export { embedImageDataUrls } from './image-embedder.js';
export type { EmbedOptions } from './image-embedder.js';
