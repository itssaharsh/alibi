/**
 * Development runs: the engine's synthetic outage, feature-bug and degraded-host runs from its tests, written in the
 * shape of recorded runs. Real recorded runs in the repository's runs/ folder take their place with no code change.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { percentile95, serialiseRun, type FlatSpan, type FlagsmithExperimentSummary, type RunLine } from '../../../packages/core/src/index.js';
import { buildRun, type RunName } from '../../../packages/core/tests/fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
export const devDir = join(here, '..', '.dev-runs');

const FILES: Record<RunName, { file: string; title: string }> = {
  outage: { file: 'outage', title: 'The database outage' },
  'feature-bug': { file: 'coupon-bug', title: 'The coupon bug' },
  'degraded-host': { file: 'slow-host', title: 'The slow host' },
};

function experiment(lines: RunLine[], readAtMs: number): FlagsmithExperimentSummary {
  const byVariation = new Map<string, { ms: number[]; failed: number }>();
  for (const line of lines) {
    if (line.kind !== 'spans') continue;
    const root = line.spans.find((s: FlatSpan) => s.parentSpanId === undefined);
    const handler = line.spans.find((s) => s.events.some((e) => e.name === 'feature_flag.evaluation'));
    const variation = handler?.events.find((e) => e.name === 'feature_flag.evaluation')?.attrs['feature_flag.result.variant'];
    if (!root || typeof variation !== 'string') continue;
    const entry = byVariation.get(variation) ?? { ms: [], failed: 0 };
    entry.ms.push(root.durationMs);
    entry.failed += root.error ? 1 : 0;
    byVariation.set(variation, entry);
  }
  const stable = byVariation.get('stable');
  const rate = (v?: { ms: number[]; failed: number }): number => (v && v.ms.length ? 1 - v.failed / v.ms.length : 0);
  return {
    experimentId: 1,
    readAtMs,
    variations: [...byVariation.entries()].sort(([a]) => (a === 'stable' ? -1 : 1)).map(([variation, v]) => ({
      variation,
      exposures: v.ms.length,
      metrics: [
        { name: 'checkout_completed', value: rate(v), ...(variation !== 'stable' && stable ? { lift: rate(v) / Math.max(rate(stable), 1e-9) - 1 } : {}) },
        { name: 'error_rate', value: v.ms.length ? v.failed / v.ms.length : 0 },
        { name: 'p95_latency_ms', value: Math.round(percentile95(v.ms)) },
      ],
    })),
  };
}

export function makeDevRuns(): string {
  mkdirSync(devDir, { recursive: true });
  for (const [name, { file, title }] of Object.entries(FILES) as [RunName, (typeof FILES)[RunName]][]) {
    const lines = buildRun(name);
    const header = lines[0];
    if (!header || header.kind !== 'alibi-run') throw new Error('no header');
    header.name = file;
    header.title = title;
    header.source = 'development run, scripted traffic';
    // Trace ids that look like real ones, not counters.
    const tid = (id: string): string => createHash('md5').update(`${name}${id}`).digest('hex');
    for (const line of lines) if (line.kind === 'spans') for (const span of line.spans) span.traceId = tid(span.traceId);
    const off = lines.find((l): l is Extract<RunLine, { kind: 'flagsmith' }> => l.kind === 'flagsmith' && l.what === 'switch-off');
    if (off) lines.push({ kind: 'flagsmith', atMs: off.atMs + 150_000, what: 'results', ok: true, detail: 'experiment results', data: experiment(lines, off.atMs + 150_000) });
    writeFileSync(join(devDir, `${file}.jsonl`), serialiseRun(lines));
  }
  return devDir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(`wrote development runs to ${makeDevRuns()}`);
