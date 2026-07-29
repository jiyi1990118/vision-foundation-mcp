import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeAnnotationStructure, normalizeAnnotationTree } from '../src/ui-analysis/annotation-workbench/tree.js';
import type { AnnotationFile } from '../src/ui-analysis/benchmark/annotation-loader.js';

const dir = process.argv[2] ?? 'benchmark/datasets/dev/app';
const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('.prediction.') && !f.includes('.review.') && !f.includes('.session.') && !f.includes('.ai-review.'));

let overlap = 0, isolated = 0, sibling = 0;
const overlapFiles: string[] = [];

for (const f of files) {
  const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as AnnotationFile;
  const ann = normalizeAnnotationTree(raw);
  const findings = analyzeAnnotationStructure(ann);
  const ov = findings.filter(x => x.code === 'sibling-overlap').length;
  const iso = findings.filter(x => x.code === 'isolated-content').length;
  const sib = findings.filter(x => x.code === 'sibling-size-inconsistent').length;
  overlap += ov; isolated += iso; sibling += sib;
  if (ov > 0) overlapFiles.push(`${f}: ${ov}`);
}

console.log(`All ${files.length} annotation files (normalized):`);
console.log(`  sibling-overlap: ${overlap} findings`);
console.log(`  isolated-content: ${isolated} findings`);
console.log(`  sibling-size-inconsistent: ${sibling} findings`);
if (overlapFiles.length > 0) {
  console.log(`  sibling-overlap by file: ${overlapFiles.join(', ')}`);
}
