/**
 * Build step: runs the engine over every run file and writes what the static page loads:
 *   public/runs/<name>.jsonl, <name>.summary.json (the finished result, small), index.json, and public/probe.json.
 * Run files come from the repository's runs/ folder; the build fails if a recorded run is missing.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayer, parseRun } from '../../../packages/core/src/index.js';
import { metaOf, recordedResults, snapshotOf } from '../src/lib/snapshots';
import type { RunSummary } from '../src/lib/runs';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const recorded = join(web, '..', '..', 'runs');
const out = join(web, 'public', 'runs');
const MAX_TAGS = 400;

const list = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []);

const NAMES = ['outage', 'coupon-bug', 'slow-host'];
const found = list(recorded).map((f) => f.replace('.jsonl', ''));
const absent = NAMES.filter((n) => !found.includes(n));
if (absent.length > 0) {
  console.error(`The recorded run files runs/${absent.join('.jsonl, runs/')}.jsonl are missing. The page only ships recorded runs.`);
  process.exit(1);
}
const sources = new Map<string, string>(found.map((n) => [n, join(recorded, `${n}.jsonl`)]));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const order = NAMES;
const files = [...sources.keys()].sort((a, b) => {
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
});

const runs: { name: string; title: string; planted: string; source: string; size: number }[] = [];
let probe: Record<string, unknown> | undefined;

for (const name of files) {
  const file = sources.get(name) as string;
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
  if ((snapshot.newStableTags?.length ?? 0) > MAX_TAGS) snapshot.newStableTags = (snapshot.newStableTags ?? []).slice(0, MAX_TAGS);
  const first = snapshot.newTags.find((t) => t.counted) ?? snapshot.newTags[0];
  // Exception stack traces are left out of the summary; the page draws names, bars and times.
  const featured = first
    ? { id: first.id, spans: lines.flatMap((l) => (l.kind === 'spans' ? l.spans.filter((s) => s.traceId === first.id).map((s) => ({ ...s, events: [] })) : [])) }
    : undefined;
  const summary: RunSummary = { meta, snapshot, ...(featured ? { featured } : {}) };
  writeFileSync(join(out, `${name}.summary.json`), JSON.stringify(summary));
  copyFileSync(file, join(out, `${name}.jsonl`));
  runs.push({ name, title: meta.title, planted: meta.planted, source: meta.source, size: statSync(file).size });

  if (name === 'outage') {
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
// The demo video is optional: when public/alibi-demo.mp4 exists the page shows a link and a player, otherwise neither.
const publicDir = join(web, 'public');
const videoFile = join(publicDir, 'alibi-demo.mp4');
const videoJson = join(publicDir, 'video.json');
if (existsSync(videoFile)) {
  const meta = existsSync(join(publicDir, 'video.meta.json')) ? (JSON.parse(readFileSync(join(publicDir, 'video.meta.json'), 'utf8')) as { seconds?: number }) : {};
  const seconds = Number(process.env.ALIBI_VIDEO_SECONDS) > 0 ? Number(process.env.ALIBI_VIDEO_SECONDS) : meta.seconds;
  writeFileSync(
    videoJson,
    JSON.stringify({
      file: 'alibi-demo.mp4',
      ...(existsSync(join(publicDir, 'alibi-demo-poster.jpg')) ? { poster: 'alibi-demo-poster.jpg' } : {}),
      ...(existsSync(join(publicDir, 'alibi-demo.vtt')) ? { captions: 'alibi-demo.vtt' } : {}),
      ...(seconds ? { seconds } : {}),
    }),
  );
  console.log(`demo video found${seconds ? `, ${seconds} s` : ', no duration given'}`);
} else {
  rmSync(videoJson, { force: true });
}

// Real stills of Flagsmith's own experiment page, when they are in public/: the page shows them under the record.
const stills = [
  ['rollout.png', 'flagsmith-rollout.png'],
  ['results.png', 'flagsmith-results.png'],
].filter(([, f]) => existsSync(join(publicDir, f as string)));
const figuresJson = join(publicDir, 'figures.json');
if (stills.length > 0) writeFileSync(figuresJson, JSON.stringify({ rollout: stills.some(([k]) => k === 'rollout.png') ? 'flagsmith-rollout.png' : undefined, results: stills.some(([k]) => k === 'results.png') ? 'flagsmith-results.png' : undefined }));
else rmSync(figuresJson, { force: true });

console.log(`prepared ${runs.length} runs: ${runs.map((r) => `${r.name} (${(r.size / 1e6).toFixed(1)} MB)`).join(', ')}`);
