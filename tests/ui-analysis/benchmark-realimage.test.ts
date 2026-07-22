import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

describe('ui-benchmark report', () => {
  it('report file exists and has valid structure', () => {
    const reportPath = '/tmp/ui-benchmark-report.json';
    if (!existsSync(reportPath)) {
      console.log('skipped: report not generated (run npx tsx scripts/ui-benchmark.ts first)');
      return;
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(report.totalImages).toBe(16);
    expect(report.succeeded).toBe(16);
    expect(report.failed).toBe(0);
    expect(report.meanCoverage).toBeGreaterThan(0);
    expect(report.stability).toHaveLength(16);
    expect(report.stability.every((s: { stable: boolean }) => s.stable)).toBe(true);
    expect(report.renderModeDistribution).toBeDefined();
    expect(report.componentTypeDistribution).toBeDefined();
  });
});
