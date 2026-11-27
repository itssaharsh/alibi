import type { Rates } from './types.js';

/** Nearest-rank 95th percentile. Integer arithmetic keeps the rank exact. */
export function percentile95(durations: readonly number[]): number {
  if (durations.length === 0) return 0;
  const sorted = [...durations].sort((a, b) => a - b);
  const rank = Math.ceil((95 * sorted.length) / 100);
  return sorted[Math.max(rank, 1) - 1] ?? 0;
}

export function makeRates(durations: readonly number[], failures: number): Rates {
  const requests = durations.length;
  return {
    requests,
    failures,
    errorRate: requests === 0 ? 0 : failures / requests,
    p95Ms: percentile95(durations),
  };
}

export function emptyRates(): Rates {
  return makeRates([], 0);
}

/** Milliseconds for people: under 1 ms, one decimal under 10 ms, whole milliseconds above. */
export function formatMs(ms: number): string {
  if (ms < 1) return 'under 1 ms';
  if (ms < 9.95) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}
