import { loadDatasetWithExclusions } from '../src/ui-analysis/benchmark/annotation-loader.js';

const { entries, excluded } = loadDatasetWithExclusions('benchmark/datasets/dev/app');
console.log(`Eligible: ${entries.length}`);
console.log(`Excluded: ${excluded.length}`);
const byReason: Record<string, number> = {};
for (const e of excluded) { byReason[e.reason] = (byReason[e.reason] ?? 0) + 1; }
for (const [r, c] of Object.entries(byReason)) console.log(`  ${r}: ${c}`);
const gate5 = excluded.filter(e => e.reason === 'open-high-severity-findings');
if (gate5.length > 0) {
  console.log('\nGate #5 excluded:');
  for (const e of gate5) console.log(`  ${e.file}`);
}
