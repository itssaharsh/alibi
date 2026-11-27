/**
 * Build step: runs the engine over every run file and writes what the static page loads:
 *   public/runs/<name>.jsonl, <name>.summary.json (the finished result, small), index.json, and public/probe.json.
 * Run files come from the repository's runs/ folder; with none there, development runs are generated.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayer, parseRun } from '../../../packages/core/src/index.js';
import { metaOf, snapshotOf } from '../src/lib/snapshots';
import type { RunSummary } from '../src/lib/runs';
import { devDir, makeDevRuns } from './make-dev-runs';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const recorded = join(web, '..', '..', 'runs');
const out = join(web, 'public', 'runs');
const MAX_TAGS = 400;

const list = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []);

let dir = recorded;
if (list(recorded).length === 0) {
  console.log('No recorded runs in runs/. Using development runs.');
  makeDevRuns();
  dir = devDir;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const order = ['outage', 'coupon-bug', 'slow-host'];
const files = list(dir).sort((a, b) => {
  const ia = order.indexOf(a.replace('.jsonl', ''));
  const ib = order.indexOf(b.replace('.jsonl', ''));
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
});

const runs: { name: string; title: string; planted: string; source: string; size: number }[] = [];
let probe: Record<string, unknown> | undefined;

for (const file of files) {
  const lines = parseRun(readFileSync(join(dir, file), 'utf8'));
  const replayer = createReplayer(lines);
  replayer.step(Infinity);
  const result = replayer.result();
  const meta = metaOf(replayer.header);
  const name = file.replace('.jsonl', '');
  meta.name = name;
  const snapshot = snapshotOf(replayer, result.events, true, replayer.endsAtMs - replayer.header.startedAtMs);
  if (snapshot.newTags.length > MAX_TAGS) {
    const counted = snapshot.newTags.filter((t) => t.counted);
    const rest = snapshot.newTags.filter((t) => !t.counted);
    snapshot.newTags = [...counted.slice(0, 100), ...rest.slice(0, MAX_TAGS - Math.min(100, counted.length))];
  }
  const first = snapshot.newTags.find((t) => t.counted) ?? snapshot.newTags[0];
  const featured = first
    ? { id: first.id, spans: lines.flatMap((l) => (l.kind === 'spans' ? l.spans.filter((s) => s.traceId === first.id) : [])) }
    : undefined;
  const summary: RunSummary = { meta, snapshot, ...(featured ? { featured } : {}) };
  writeFileSync(join(out, `${name}.summary.json`), JSON.stringify(summary));
  copyFileSync(join(dir, file), join(out, `${name}.jsonl`));
  runs.push({ name, title: meta.title, planted: meta.planted, source: meta.source, size: statSync(join(dir, file)).size });

  if (name === 'outage' || (!probe && files.length === 1)) {
    const s = result.state;
    const stays = s.switchedOffAtMs === undefined && s.counted === 0;
    probe = {
      run: name,
      decision: stays ? 'flag stays on' : s.label ?? 'flag switched off',
      counted: s.counted,
      flagOnFailures: s.totals.flagOn.failures,
      plainRuleTrippedAt: s.plainRuleTrippedAtMs === undefined ? null : s.plainRuleTrippedAtMs - replayer.header.startedAtMs,
    };
  }
}

writeFileSync(join(out, 'index.json'), JSON.stringify({ runs, default: runs.find((r) => r.name === 'outage')?.name ?? runs[0]?.name ?? '' }));
writeFileSync(join(web, 'public', 'probe.json'), JSON.stringify(probe ?? { decision: 'no run' }));
console.log(`prepared ${runs.length} runs from ${dir}: ${runs.map((r) => `${r.name} (${(r.size / 1e6).toFixed(1)} MB)`).join(', ')}`);
