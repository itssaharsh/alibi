/**
 * Build step: runs the engine over every run file and writes what the static page loads:
 *   public/runs/<name>.jsonl, <name>.summary.json (the finished result, small), index.json, and public/probe.json.
 * Run files come from the repository's runs/ folder; with none there, development runs are generated.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayer, parseRun } from '../../../packages/core/src/index.js';
import { metaOf, recordedResults, snapshotOf } from '../src/lib/snapshots';
import type { RunSummary } from '../src/lib/runs';
import { devDir, makeDevRuns } from './make-dev-runs';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const recorded = join(web, '..', '..', 'runs');
const out = join(web, 'public', 'runs');
const MAX_TAGS = 400;

const list = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []);

const NAMES = ['outage', 'coupon-bug', 'slow-host'];
const real = new Map(list(recorded).map((f) => [f.replace('.jsonl', ''), join(recorded, f)]));
const sources = new Map<string, { path: string; dev: boolean }>([...real].map(([n, path]) => [n, { path, dev: false }]));
const missing = NAMES.filter((n) => !real.has(n));
if (missing.length > 0) {
  const banner = `DEVELOPMENT RUNS IN THIS BUILD: ${missing.join(', ')} (no recorded file in runs/). Do not ship this build.`;
  console.warn(`\n${'!'.repeat(banner.length)}\n${banner}\n${'!'.repeat(banner.length)}\n`);
  if (process.env.ALIBI_REQUIRE_REAL_RUNS === '1') {
    console.error('ALIBI_REQUIRE_REAL_RUNS=1: the build fails because a run would be generated.');
    process.exit(1);
  }
  makeDevRuns();
  for (const n of missing) sources.set(n, { path: join(devDir, `${n}.jsonl`), dev: true });
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const order = NAMES;
const files = [...sources.keys()].sort((a, b) => {
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
});

const runs: { name: string; title: string; planted: string; source: string; size: number; dev?: true }[] = [];
let probe: Record<string, unknown> | undefined;

for (const name of files) {
  const { path: file, dev } = sources.get(name) as { path: string; dev: boolean };
  const lines = parseRun(readFileSync(file, 'utf8'));
  const replayer = createReplayer(lines);
  replayer.step(Infinity);
  const result = replayer.result();
  const meta = metaOf(replayer.header);
  meta.name = name;
  const snapshot = snapshotOf(replayer, result.events, true, replayer.endsAtMs - replayer.header.startedAtMs, recordedResults(lines));
  if (snapshot.newTags.length > MAX_TAGS) {
    const counted = snapshot.newTags.filter((t) => t.counted);
    const rest = snapshot.newTags.filter((t) => !t.counted);
    snapshot.newTags = [...counted.slice(0, 100), ...rest.slice(0, MAX_TAGS - Math.min(100, counted.length))];
  }
  const first = snapshot.newTags.find((t) => t.counted) ?? snapshot.newTags[0];
  // Exception stack traces are left out of the summary; the page draws names, bars and times.
  const featured = first
    ? { id: first.id, spans: lines.flatMap((l) => (l.kind === 'spans' ? l.spans.filter((s) => s.traceId === first.id).map((s) => ({ ...s, events: [] })) : [])) }
    : undefined;
  const summary: RunSummary = { meta, snapshot, ...(featured ? { featured } : {}) };
  writeFileSync(join(out, `${name}.summary.json`), JSON.stringify(summary));
  copyFileSync(file, join(out, `${name}.jsonl`));
  runs.push({ name, title: meta.title, planted: meta.planted, source: meta.source, size: statSync(file).size, ...(dev ? { dev: true as const } : {}) });

  if (name === 'outage') {
    const s = result.state;
    const stays = s.switchedOffAtMs === undefined && s.counted === 0;
    probe = {
      run: name,
      ...(dev ? { dev: true } : {}),
      decision: stays ? 'flag stays on' : s.label ?? 'flag switched off',
      counted: s.counted,
      flagOnFailures: s.totals.flagOn.failures,
      plainRuleTrippedAt: s.plainRuleTrippedAtMs === undefined ? null : s.plainRuleTrippedAtMs - replayer.header.startedAtMs,
    };
  }
}

writeFileSync(join(out, 'index.json'), JSON.stringify({ runs, default: runs.find((r) => r.name === 'outage')?.name ?? runs[0]?.name ?? '' }));
writeFileSync(join(web, 'public', 'probe.json'), JSON.stringify(probe ?? { decision: 'no run' }));
console.log(`prepared ${runs.length} runs: ${runs.map((r) => `${r.name}${r.dev ? ' [DEV]' : ''} (${(r.size / 1e6).toFixed(1)} MB)`).join(', ')}`);
