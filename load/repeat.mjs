#!/usr/bin/env node
// Runs each scenario several times, every run from a fresh stack, and keeps a compact outcome per run.
// Run it from the repository root, with Node 22 and the engine built (cd packages/core && npm install && npm run build):
//
//   node load/repeat.mjs [--n 5] [--only outage|coupon-bug|degraded-host] [--resume]
//   node load/repeat.mjs --analyse <run file> --scenario <name> [--state <state.json>]   (no stack needed)
//
// For every run: `docker compose down -v`, `up -d --build --wait`, the scenario at 2 requests a second (the run arms the
// guard and finishes it), then the guard's final /api/state and the recording are kept under
// ~/gta-evidence/repeats/<scenario>-<n>/, and the recording is replayed through the engine.
// Output: runs/repeats/summary.json (one object per run) and runs/repeats/README.md (a table). The full run files
// stay in ~/gta-evidence/repeats and are not meant for the repository.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = ['compose', '-f', join(ROOT, 'deploy', 'docker-compose.yml')];
const GUARD = process.env.ALIBI_URL ?? 'http://127.0.0.1:4319';
const FLAGSMITH = process.env.FLAGSMITH_URL ?? 'http://127.0.0.1:8000';
const OUT = join(ROOT, 'runs', 'repeats');
const EVIDENCE = join(homedir(), 'gta-evidence', 'repeats');
const SCENARIOS = { outage: 'outage', 'coupon-bug': 'coupon-bug', 'degraded-host': 'slow-host' };
const WINDOW_MS = 60_000;
const MIN_PER_ARM = 10;

const args = (() => {
  const out = { _: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) out._.push(argv[i]);
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) out[argv[i].slice(2)] = true;
    else out[argv[i].slice(2)] = argv[++i];
  }
  return out;
})();

async function loadEngine() {
  try {
    return await import(join(ROOT, 'packages', 'core', 'dist', 'index.js'));
  } catch {
    throw new Error('The engine is not built. Run: cd packages/core && npm install && npm run build');
  }
}

const seconds = (ms, startedAtMs) => (ms === undefined ? null : Math.round((ms - startedAtMs) / 100) / 10);

/** The largest gap, in percentage points, between the flag-on and stable error rates over trailing 60 second windows. */
function largestArmGap(verdicts, startedAtMs) {
  const seen = verdicts.filter((v) => v.evaluation).sort((a, b) => a.endMs - b.endMs);
  if (seen.length === 0) return 0;
  const last = seen[seen.length - 1].endMs;
  let best = 0;
  for (let at = startedAtMs + WINDOW_MS; at <= last; at += 10_000) {
    const inside = seen.filter((v) => v.endMs > at - WINDOW_MS && v.endMs <= at);
    const on = inside.filter((v) => v.flagOn);
    const off = inside.filter((v) => !v.flagOn);
    if (on.length < MIN_PER_ARM || off.length < MIN_PER_ARM) continue;
    const rate = (list) => list.filter((v) => v.failed).length / list.length;
    best = Math.max(best, (rate(on) - rate(off)) * 100);
  }
  return Math.round(best * 10) / 10;
}

function chanceToWin(summary) {
  const out = {};
  const v2 = summary?.variations?.find((v) => v.variation !== 'stable');
  for (const metric of v2?.metrics ?? []) {
    if (metric.chanceToWin !== undefined) out[metric.name] = Math.round(metric.chanceToWin * 10000) / 10000;
  }
  return out;
}

/** The outcome of one run, from its recording replayed through the engine and, when there is one, the guard's final state. */
export function outcomeOf(engine, text, liveState) {
  const lines = engine.parseRun(text);
  const result = engine.replayRun(lines);
  const recordedResults = [...lines].reverse().find((l) => l.kind === 'flagsmith' && l.what === 'results' && l.ok)?.data;
  const startedAtMs = result.header.startedAtMs;
  const byClass = (list) => list.reduce((acc, v) => ({ ...acc, [v.failureClass ?? 'unclassified']: (acc[v.failureClass ?? 'unclassified'] ?? 0) + 1 }), {});
  const failed = result.verdicts.filter((v) => v.failed);
  const state = result.state;
  const out = {
    flagOnFailures: byClass(failed.filter((v) => v.flagOn)),
    stableFailures: byClass(failed.filter((v) => !v.flagOn)),
    counted: state.counted,
    switchedOff: state.switchedOffAtMs !== undefined,
    switchedOffAtS: seconds(state.switchedOffAtMs, startedAtMs),
    recoveredAtS: seconds(state.recoveredAtMs, startedAtMs),
    label: state.label ?? null,
    plainRuleAtS: seconds(state.plainRuleTrippedAtMs, startedAtMs),
    armRuleAtS: seconds(state.armRuleTrippedAtMs, startedAtMs),
    largestArmGapPoints: largestArmGap(result.verdicts, startedAtMs),
    flagsmithChanceToWin: chanceToWin(result.record?.flagsmith ?? recordedResults ?? liveState?.flagsmith?.results),
    flagsmithResultsRead: Boolean(result.record?.flagsmith ?? recordedResults ?? liveState?.flagsmith?.results),
  };
  if (liveState) {
    const live = liveState.state;
    out.replayEqualsLive = live.counted === state.counted && (live.label ?? null) === (state.label ?? null) && live.switchedOffAtMs === state.switchedOffAtMs;
  }
  return out;
}

const compose = (...a) => run('docker', [...COMPOSE, ...a], { maxBuffer: 50_000_000, cwd: ROOT });

async function freshStack() {
  await compose('down', '-v');
  await compose('up', '-d', '--build', '--wait');
}

async function flagsmithVersion() {
  try {
    return (await (await fetch(`${FLAGSMITH}/version/`)).json()).image_tag ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function oneRun(scenario, n, engine) {
  const name = SCENARIOS[scenario];
  const dir = join(EVIDENCE, `${scenario}-${n}`);
  mkdirSync(dir, { recursive: true });
  await freshStack();
  const version = await flagsmithVersion();
  const started = Date.now();
  await run('node', [join(ROOT, 'load', 'run.mjs'), scenario, '--rps', '2'], { maxBuffer: 50_000_000, cwd: ROOT, env: process.env });
  const state = await (await fetch(`${GUARD}/api/state`)).json();
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  const file = join(dir, `${name}.jsonl`);
  await compose('cp', `alibi:/data/runs/${name}.jsonl`, file);
  for (const record of state.records ?? []) {
    for (const ext of ['json', 'md']) await compose('cp', `alibi:/data/records/${record.id}.${ext}`, join(dir, `${record.id}.${ext}`)).catch(() => undefined);
  }
  const outcome = outcomeOf(engine, readFileSync(file, 'utf8'), state);
  return {
    scenario,
    run: n,
    date: new Date(started).toISOString(),
    flagsmithVersion: version,
    runFileBytes: statSync(file).size,
    ...outcome,
  };
}

const cell = (value) => (value === null || value === undefined ? 'none' : String(value));
const classes = (counts) => (Object.keys(counts).length === 0 ? '0' : Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '));
const t = (value) => (value === null ? 'never' : `+${Math.floor(value / 60)}:${String(Math.round(value % 60)).padStart(2, '0')}`);

export function markdown(rows) {
  const out = [
    '# Repeated runs',
    '',
    `Each row is one run of a scenario at 2 requests a second from a fresh stack (Flagsmith ${[...new Set(rows.map((r) => r.flagsmithVersion))].join(', ')}). Times are from the start of the run. The full run files are not in the repository; \`summary.json\` has every number below.`,
    '',
    '| Scenario | Run | Flag-on failures | Stable failures | Counted | Switched off | Recovered | Label | Plain rule | Arm comparison | Largest arm gap | Chance to win, completed / latency | Replay = live |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const win = r.flagsmithChanceToWin;
    out.push(
      `| ${r.scenario} | ${r.run} | ${classes(r.flagOnFailures)} | ${classes(r.stableFailures)} | ${r.counted} | ${t(r.switchedOffAtS)} | ${t(r.recoveredAtS)} | ${cell(r.label)} | ${t(r.plainRuleAtS)} | ${t(r.armRuleAtS)} | ${r.largestArmGapPoints} points | ${cell(win.checkout_completed)} / ${cell(win.checkout_latency_ms)} | ${cell(r.replayEqualsLive)} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

function save(rows) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(join(OUT, 'README.md'), markdown(rows));
}

async function main() {
  const engine = await loadEngine();
  if (args.analyse) {
    const text = readFileSync(resolve(args.analyse), 'utf8');
    const live = args.state ? JSON.parse(readFileSync(resolve(args.state), 'utf8')) : undefined;
    console.log(JSON.stringify(outcomeOf(engine, text, live), null, 2));
    return;
  }
  const n = Number(args.n ?? 5);
  const scenarios = args.only ? [args.only] : Object.keys(SCENARIOS);
  for (const s of scenarios) if (!SCENARIOS[s]) throw new Error(`Unknown scenario ${s}. Use one of: ${Object.keys(SCENARIOS).join(', ')}`);
  const summaryPath = join(OUT, 'summary.json');
  const rows = args.resume && existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : [];
  for (const scenario of scenarios) {
    for (let i = 1; i <= n; i++) {
      if (rows.some((r) => r.scenario === scenario && r.run === i)) continue;
      console.log(`${new Date().toISOString()} ${scenario} run ${i} of ${n}`);
      rows.push(await oneRun(scenario, i, engine));
      save(rows);
    }
  }
  console.log(`Done: ${rows.length} runs in ${OUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
