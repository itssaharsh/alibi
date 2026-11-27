#!/usr/bin/env node
// Runs the outage scenarios of runs/outage-scenarios/PLAN.md, unattended, and scores them.
// From the repository root, with Node 22 and the engine built (cd packages/core && npm install && npm run build):
//
//   node load/scenarios-matrix.mjs --commit <hash> [--rounds 3] [--only <scenario>]   the counted runs, each from a fresh stack
//   node load/scenarios-matrix.mjs --dev <scenario> [--minutes N] [--no-fresh]         one development run, never counted
//   node load/scenarios-matrix.mjs --analyse --commit <hash> [--before-fix <summary.json>] [--runs <dir>] [--earlier <dir>] [--out <dir>]
//        write summary.json and RESULTS.md from the kept runs (by default ~/gta-evidence; --runs, --earlier and --out use an
//        unpacked archive: <runs>/r1-<scenario>/..., <earlier>/recorded/<run>.jsonl and <earlier>/repeats/<scenario>-<n>/...)
//
// Order: O1, O2, O3, O4, M1, M2, M3, H1, and again, so a stop part-way leaves complete rounds. Each run starts with
// `down -v` and `up --wait` with deploy/docker-compose.downstream.yml, which holds Alibi in observe-only mode with the
// simple rule's margin at 20 points. Progress goes to /tmp/scenarios/progress; runs and their checks are kept under
// ~/gta-evidence/scenarios/. A run is void only for the reasons in the plan; a void run is listed and made again.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { widestArmGap } from './arm-gap.mjs';
import { extraRules } from './extra-rules.mjs';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The flaky database scenario brings the stack up with one more file, so the shop takes a connection per request there only.
const profileOf = (scenario) => (scenario.name === 'database-flaky' ? 'downstream-flaky' : 'downstream');
const filesOf = (scenario) => ['docker-compose.yml', 'docker-compose.downstream.yml', ...(scenario.name === 'database-flaky' ? ['docker-compose.downstream-flaky.yml'] : [])].flatMap((f) => ['-f', join(ROOT, 'deploy', f)]);
const GUARD = process.env.ALIBI_URL ?? 'http://127.0.0.1:4319';
const FLAGSMITH = process.env.FLAGSMITH_URL ?? 'http://127.0.0.1:8000';
// Where the kept runs are. --runs, --earlier and --out point the analysis at an unpacked archive and another output folder.
let EVIDENCE = join(homedir(), 'gta-evidence', 'scenarios');
let EARLIER_EVIDENCE = join(homedir(), 'gta-evidence', 'repeats');
let RECORDED = join(ROOT, 'runs');
const PROGRESS = process.env.SCENARIOS_PROGRESS ?? '/tmp/scenarios/progress';
let OUT = join(ROOT, 'runs', 'outage-scenarios');
const MAX_ATTEMPTS = 3;

/** The plan's table: what was done is the truth, and the last column is what a rule has to do to be right. */
const SCENARIOS = [
  { id: 'O1', name: 'shared-service-outage', truth: 'infrastructure', shouldAct: false },
  { id: 'O2', name: 'feature-service-outage', truth: 'infrastructure', shouldAct: false },
  { id: 'O3', name: 'database-flaky', truth: 'infrastructure', shouldAct: false },
  { id: 'O4', name: 'shared-service-outage-low-traffic', truth: 'infrastructure', shouldAct: false },
  { id: 'M1', name: 'database-outage-with-bug', truth: 'flagged path (and infrastructure)', shouldAct: true },
  { id: 'M2', name: 'shared-service-outage-with-bug', truth: 'flagged path (and infrastructure)', shouldAct: true },
  { id: 'M3', name: 'rare-bug', truth: 'flagged path', shouldAct: true },
  { id: 'H1', name: 'healthy', truth: 'healthy', shouldAct: false },
];
const byName = new Map(SCENARIOS.map((s) => [s.name, s]));

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

const compose = (scenario, ...a) => run('docker', ['compose', ...filesOf(scenario), ...a], { maxBuffer: 50_000_000, cwd: ROOT, env: { ...process.env, ALIBI_EXAMPLE_PROFILE: profileOf(scenario) } });
const progress = (line) => {
  mkdirSync(dirname(PROGRESS), { recursive: true });
  appendFileSync(PROGRESS, `${line}\n`);
};

async function loadEngine() {
  try {
    return await import(join(ROOT, 'packages', 'core', 'dist', 'index.js'));
  } catch {
    throw new Error('The engine is not built. Run: cd packages/core && npm install && npm run build');
  }
}

// ---------------------------------------------------------------- one run

async function freshStack(scenario) {
  await compose(scenario, 'down', '-v');
  await compose(scenario, 'up', '-d', '--build', '--wait');
}

async function flagsmithVersion() {
  try {
    return (await (await fetch(`${FLAGSMITH}/version/`)).json()).image_tag ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Runs one scenario on a fresh stack and keeps everything: the run file, the guard's final state, the script's own checks. */
async function oneRun(scenario, dir, extra = [], { fresh = true } = {}) {
  mkdirSync(dir, { recursive: true });
  if (fresh) await freshStack(scenario);
  const version = await flagsmithVersion();
  let stdout = '';
  let failure;
  try {
    ({ stdout } = await run('node', [join(ROOT, 'load', 'run.mjs'), scenario.name, ...extra], { maxBuffer: 100_000_000, cwd: ROOT, env: { ...process.env, ALIBI_EXAMPLE_PROFILE: profileOf(scenario) } }));
  } catch (error) {
    stdout = error.stdout ?? '';
    failure = error.message;
  }
  const state = await (await fetch(`${GUARD}/api/state`)).json();
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  const file = join(dir, `${scenario.name}.jsonl`);
  await compose(scenario, 'cp', `alibi:/data/runs/${scenario.name}.jsonl`, file).catch(() => undefined);
  const outcomeLine = stdout.split('\n').find((l) => l.startsWith('OUTCOME '));
  const outcome = outcomeLine ? JSON.parse(outcomeLine.slice('OUTCOME '.length)) : undefined;
  const info = { scenario: scenario.name, flagsmithVersion: version, outcome, scriptFailure: failure ?? null };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(info, null, 2));
  return info;
}

// ---------------------------------------------------------------- scoring

/** Seconds from the start of the run, to the millisecond; the tables print them with the engine's own formatter. */
const sec = (ms, startedAtMs) => (ms === undefined || ms === null ? null : Math.round(ms - startedAtMs) / 1000);
const countBy = (verdicts) => verdicts.reduce((acc, v) => ({ ...acc, [v.failureClass ?? 'unclassified']: (acc[v.failureClass ?? 'unclassified'] ?? 0) + 1 }), {});

/** Replays a recording with the simple rule's margin set to `points`, whatever the header says. */
function withMargin(engine, lines, points) {
  const [header, ...rest] = lines;
  const config = { ...header.config, armRule: { ...(header.config.armRule ?? { windowMs: 60_000, minRequestsPerArm: 20 }), errorRatePoints: points } };
  return engine.replayRun([{ ...header, config }, ...rest]);
}

/** Why a run would be void under the plan, or undefined. A rule's decision is never a reason. */
function voidReason(scenario, info, lines) {
  const o = info.outcome;
  if (!o) return `the script did not finish${info.scriptFailure ? `: ${info.scriptFailure.slice(0, 120)}` : ''}`;
  for (const s of o.checks?.services ?? []) {
    if (s.stoppedRunning !== false) return `the ${s.service} service did not stop`;
    if (s.startedRunning !== true) return `the ${s.service} service did not start again`;
  }
  const p = o.checks?.proxy;
  if (p && (p.listedWhileOn !== true || p.listedAfter !== false)) return 'the fault proxy did not add or remove the failing connections';
  const wantsCoupons = ['database-outage-with-bug', 'shared-service-outage-with-bug', 'rare-bug'].includes(scenario.name);
  if (wantsCoupons && !(o.couponCartsNewCheckout > 0)) return 'no coupon carts were sent to the new checkout';
  const last = lines[lines.length - 1];
  const ended = lines.some((l) => l.kind === 'world' && l.text === `Run "${scenario.name}" ended.`);
  if (!ended || !last) return 'the recording is incomplete';
  return undefined;
}

export function analyse(engine, scenario, info, text) {
  const lines = engine.parseRun(text);
  const header = lines[0];
  const startedAtMs = header.startedAtMs;
  const result = engine.replayRun(lines);
  const ten = withMargin(engine, lines, 10);
  const failed = result.verdicts.filter((v) => v.failed);
  const crossed = result.events.find((e) => e.type === 'threshold-crossed');
  const alibiAtS = crossed ? sec(crossed.atMs, startedAtMs) : null;
  const rule20AtS = sec(result.state.armRuleTrippedAtMs, startedAtMs);
  return {
    id: scenario.id,
    scenario: scenario.name,
    truth: scenario.truth,
    shouldAct: scenario.shouldAct,
    flagsmithVersion: info.flagsmithVersion,
    date: new Date(startedAtMs).toISOString(),
    requests: info.outcome?.requests ?? null,
    newCheckoutFailures: countBy(failed.filter((v) => v.flagOn)),
    stableFailures: countBy(failed.filter((v) => !v.flagOn)),
    alibiActed: Boolean(crossed),
    alibiAtS,
    rule20Acted: rule20AtS !== null,
    rule20AtS,
    widestGapPoints: widestArmGap(result.events, header).points,
    notices: result.events.filter((e) => e.type === 'notice').map((e) => ({ kind: e.notice.kind ?? null, span: e.notice.span, atS: sec(e.atMs, startedAtMs), text: e.notice.text })),
    rule10AtS: sec(ten.state.armRuleTrippedAtMs, startedAtMs),
    plainRuleAtS: sec(result.state.plainRuleTrippedAtMs, startedAtMs),
    alibiRight: Boolean(crossed) === scenario.shouldAct,
    rule20Right: (rule20AtS !== null) === scenario.shouldAct,
    checks: info.outcome?.checks ?? null,
    couponCarts: info.outcome?.couponCarts ?? 0,
    couponCartsNewCheckout: info.outcome?.couponCartsNewCheckout ?? 0,
    voidReason: voidReason(scenario, info, lines) ?? null,
    ...addedRules(result.events, scenario, startedAtMs, {}),
    ...flagsmithNumbers(lines),
  };
}

/** The two rules of ADDENDUM.md, added after the runs: when each acted by the engine's clock, and whether that was right. */
function addedRules(events, scenario, startedAtMs, options) {
  const { excessAtMs, cumulativeAtMs } = extraRules(events, options);
  return {
    excessRuleActed: excessAtMs !== null,
    excessRuleAtS: sec(excessAtMs, startedAtMs),
    excessRuleRight: (excessAtMs !== null) === scenario.shouldAct,
    cumulativeRuleActed: cumulativeAtMs !== null,
    cumulativeRuleAtS: sec(cumulativeAtMs, startedAtMs),
    cumulativeRuleRight: (cumulativeAtMs !== null) === scenario.shouldAct,
  };
}

/** What Flagsmith's own experiment numbers said, when the recording holds a read of them (an observe-only run that crossed does not). */
function flagsmithNumbers(lines) {
  const line = [...lines].reverse().find((l) => l.kind === 'flagsmith' && l.what === 'results' && l.ok && l.data);
  const v2 = line?.data?.variations?.find((v) => v.variation !== 'stable');
  const completed = v2?.metrics?.find((m) => m.name === 'checkout_completed');
  return { flagsmithResultsRead: Boolean(line), flagsmithChanceToWinCompleted: completed?.chanceToWin ?? null };
}

/** The 18 earlier runs, scored after the fact by the same definition: right is what the plan's last column says. */
function scoreEarlier(engine) {
  const truthOf = { outage: ['infrastructure', false], 'coupon-bug': ['flagged path', true], 'slow-host': ['infrastructure (the host)', false], 'degraded-host': ['infrastructure (the host)', false] };
  const rows = [];
  const one = (label, scenario, file) => {
    const [truth, shouldAct] = truthOf[scenario];
    const lines = engine.parseRun(readFileSync(file, 'utf8'));
    const result = engine.replayRun(lines);
    const header = lines[0];
    const off = result.state.switchedOffAtMs;
    const gap = widestArmGap(result.events, header, { untilMs: off ?? Infinity }).points;
    const alibiActed = off !== undefined;
    rows.push({
      run: label,
      scenario,
      truth,
      shouldAct,
      alibiActed,
      alibiAtS: sec(off, header.startedAtMs),
      gapBeforeSwitchOffPoints: gap,
      rule20Acted: gap >= 20,
      alibiRight: alibiActed === shouldAct,
      rule20Right: gap >= 20 === shouldAct,
      rule10AtS: sec(withMargin(engine, lines, 10).state.armRuleTrippedAtMs, header.startedAtMs),
      plainRuleAtS: sec(result.state.plainRuleTrippedAtMs, header.startedAtMs),
      ...addedRules(result.events, { shouldAct }, header.startedAtMs, { untilMs: off ?? Infinity }),
    });
  };
  for (const name of ['outage', 'coupon-bug', 'slow-host']) one(`runs/${name}.jsonl`, name, join(RECORDED, `${name}.jsonl`));
  const names = { outage: 'outage', 'coupon-bug': 'coupon-bug', 'degraded-host': 'slow-host' };
  for (const scenario of ['outage', 'coupon-bug', 'degraded-host']) {
    for (let n = 1; n <= 5; n++) {
      const file = join(EARLIER_EVIDENCE, `${scenario}-${n}`, `${names[scenario]}.jsonl`);
      if (existsSync(file)) one(`repeat ${scenario} ${n}`, scenario === 'degraded-host' ? 'slow-host' : scenario, file);
    }
  }
  return rows;
}

// ---------------------------------------------------------------- output

let formatRelative = () => '';
const t = (v) => (v === null || v === undefined ? 'never' : formatRelative(v * 1000));
const classes = (c) => (Object.keys(c).length === 0 ? '0' : Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', '));
const noticeCell = (notices) =>
  notices.length === 0
    ? 'none'
    : notices.map((n) => `${n.kind === 'flagged-path-only' ? 'a dependency only the flagged path calls' : 'a shared dependency failing far more with the flag on'} (${n.span}) at ${t(n.atS)}`).join('; ');
const verdictWord = (right) => (right ? 'right' : 'wrong');

function totals(rows) {
  const tally = (list, key) => ({ right: list.filter((r) => r[key]).length, wrong: list.filter((r) => !r[key]).length });
  return { alibi: tally(rows, 'alibiRight'), rule20: tally(rows, 'rule20Right') };
}

/** Harness defects found in development runs and fixed before the counted runs, as the plan allows. They are listed in RESULTS.md. */
const HARNESS_NOTES = [
  'A development run of the scenario where the rules service is stopped showed database connection timeouts for both versions, which nothing in that scenario should cause. The cause was name resolution: Node looks host names up on four shared threads, a stopped container\'s name takes Docker\'s resolver five seconds to give up on, and those hung lookups held every thread, so lookups the shop needed for other things (the database proxy, which was reached on a new connection per request, and the flag service) waited behind them until the 1.5 second connect timeout.',
  'The shop now gets the addresses of the tax service, the rules service and the fault proxy in its hosts file, on a network with fixed addresses, so a stopped service simply does not answer and only its callers fail; and the shop uses its normal connection pool in every scenario except the flaky database one, where it takes a connection per request so that the proxy\'s share of failing connections is the share of failing requests.',
];

export function resultsMarkdown(counted, voids, earlier, meta) {
  const out = [
    '# Outage scenarios: results',
    '',
    `Harness commit: \`${meta.commit}\`. Flagsmith ${[...new Set(counted.map((r) => r.flagsmithVersion))].join(', ')}. Runs made ${counted.map((r) => r.date).sort()[0]?.slice(0, 10)} to ${counted.map((r) => r.date).sort().slice(-1)[0]?.slice(0, 10)}. The plan is \`PLAN.md\` in this folder. Times are from the start of the run.`,
    '',
    '## The counted runs',
    '',
    '| Run | Scenario | Truth | New checkout failures | Stable failures | Alibi: count passed 15 | 20-point rule acted | Widest gap (whole run) | Alibi | 20-point rule | 10-point rule (not scored) | Plain rule (not scored) | Notices |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of counted) {
    out.push(
      `| ${r.id}-${r.round} | ${r.scenario} | ${r.truth} | ${classes(r.newCheckoutFailures)} | ${classes(r.stableFailures)} | ${r.alibiActed ? t(r.alibiAtS) : 'no'} | ${r.rule20Acted ? t(r.rule20AtS) : 'no'} | ${r.widestGapPoints} points | ${verdictWord(r.alibiRight)} | ${verdictWord(r.rule20Right)} | ${t(r.rule10AtS)} | ${t(r.plainRuleAtS)} | ${noticeCell(r.notices)} |`,
    );
  }
  out.push('', '## Totals', '', `| | Alibi right | Alibi wrong | 20-point rule right | 20-point rule wrong |`, '|---|---|---|---|---|');
  const all = totals(counted);
  out.push(`| All ${counted.length} runs | ${all.alibi.right} | ${all.alibi.wrong} | ${all.rule20.right} | ${all.rule20.wrong} |`);
  for (const s of SCENARIOS) {
    const rows = counted.filter((r) => r.scenario === s.name);
    if (rows.length === 0) continue;
    const x = totals(rows);
    out.push(`| ${s.id} ${s.name} (${rows.length} runs) | ${x.alibi.right} | ${x.alibi.wrong} | ${x.rule20.right} | ${x.rule20.wrong} |`);
  }
  out.push('', '## Harness notes before the counted runs', '', ...HARNESS_NOTES.flatMap((n) => [n, '']));
  out.push(
    '## After the runs',
    '',
    'The recordings are unchanged. The tables were regenerated from them on 27 November, after the counted runs, to add the Notices column, to print every time with the engine\'s own formatter, and to compute the widest gap with one function (`load/arm-gap.mjs`) at the instants the engine evaluates its comparison. That moved the printed widest gaps by under 3 points in the counted runs, and no right or wrong changed. In the counted runs, each rule\'s "acted" time is the engine\'s own event, not derived from the gap column. In the table of the 18 earlier runs, scored after the fact, it is derived: the 20-point rule counts as having acted when the widest gap before Alibi\'s switch-off reached 20 points.',
    '',
  );
  if (meta.beforeFix) {
    const before = meta.beforeFix.counted;
    const noticeText = (list) => (list.length === 0 ? 'none' : list.map((n) => `${n.kind === 'flagged-path-only' ? 'a dependency only the flagged path calls' : 'a shared dependency both versions call'} (${n.span}) at ${t(n.atS)}`).join('; '));
    const rows = counted.filter((r) => noticeText(r.notices) !== noticeText(before.find((b) => b.id === r.id && b.round === r.round)?.notices ?? []));
    const ignore = new Set(['notices']);
    const changed = counted.flatMap((r) => {
      const b = before.find((x) => x.id === r.id && x.round === r.round);
      return Object.keys(r).filter((k) => !ignore.has(k) && JSON.stringify(r[k]) !== JSON.stringify(b?.[k])).map((k) => `${r.id}-${r.round} ${k}`);
    });
    out.push(
      '### An engine defect found while analysing',
      '',
      'The engine identified a dependency by its span name, and the HTTP client spans for the tax service and the rules service are both named `GET`, so a call to the rules service was taken for a call both versions make. The engine now identifies a dependency by its name and its target. The recordings were replayed with the engine before and after the fix; the Notices column reads:',
      '',
      '| Run | Before the fix | After the fix |',
      '|---|---|---|',
      ...rows.map((r) => `| ${r.id}-${r.round} | ${noticeText(before.find((b) => b.id === r.id && b.round === r.round)?.notices ?? [])} | ${noticeText(r.notices)} |`),
      '',
      changed.length === 0
        ? 'Comparing the two summaries, nothing else differs: no count, time or right or wrong changed, and every other column is the same.'
        : `Comparing the two summaries, these also differ: ${changed.join(', ')}.`,
      '',
    );
  }
  out.push('## Void runs', '');
  if (voids.length === 0) out.push('None.');
  else for (const v of voids) out.push(`- ${v.scenario}, attempt ${v.attempt}: ${v.reason}`);
  out.push(
    '',
    '## Checks that the scripted fault happened',
    '',
    '| Run | Stopped service, running after stop / after start | Proxy toxic listed while on / after removal | Coupon carts sent / to the new checkout |',
    '|---|---|---|---|',
  );
  for (const r of counted) {
    const svc = (r.checks?.services ?? []).map((s) => `${s.service}: ${s.stoppedRunning} / ${s.startedRunning}`).join('; ') || 'none';
    const px = r.checks?.proxy ? `${r.checks.proxy.listedWhileOn} / ${r.checks.proxy.listedAfter}` : 'none';
    out.push(`| ${r.id}-${r.round} | ${svc} | ${px} | ${r.couponCarts} / ${r.couponCartsNewCheckout} |`);
  }
  out.push(
    '',
    '## The 18 earlier runs, scored after the fact',
    '',
    'Scored by the same definition, after the plan was written. Alibi acted when it switched the flag off. The 20-point rule counts as having acted when the widest gap between the versions, up to Alibi\'s switch-off (the whole run when it did not switch off), was at least 20 points.',
    '',
    '| Run | Truth | Alibi acted | Widest gap (before Alibi\'s switch-off, whole run if none) | 20-point rule acted | Alibi | 20-point rule | 10-point rule (not scored) | Plain rule (not scored) |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of earlier) {
    out.push(
      `| ${r.run} | ${r.truth} | ${r.alibiActed ? t(r.alibiAtS) : 'no'} | ${r.gapBeforeSwitchOffPoints} points | ${r.rule20Acted ? 'yes' : 'no'} | ${verdictWord(r.alibiRight)} | ${verdictWord(r.rule20Right)} | ${t(r.rule10AtS)} | ${t(r.plainRuleAtS)} |`,
    );
  }
  const e = totals(earlier);
  out.push('', `Totals over ${earlier.length} earlier runs: Alibi ${e.alibi.right} right, ${e.alibi.wrong} wrong; 20-point rule ${e.rule20.right} right, ${e.rule20.wrong} wrong.`);
  for (const name of ['outage', 'coupon-bug', 'slow-host']) {
    const rows = earlier.filter((r) => r.scenario === name);
    const x = totals(rows);
    out.push(`- ${name} (${rows.length} runs): Alibi ${x.alibi.right} right, ${x.alibi.wrong} wrong; 20-point rule ${x.rule20.right} right, ${x.rule20.wrong} wrong.`);
  }
  out.push(...addedSection(counted, earlier), '');
  return out.join('\n');
}

/** The section for ADDENDUM.md: two rules defined after the runs, with their per-run results and totals. */
function addedSection(counted, earlier) {
  const out = [
    '',
    '## Two more rules, added after the runs',
    '',
    'Defined in `ADDENDUM.md` after the 24 counted runs were scored and before these rules were computed on them. Neither reads a trace and neither has a window; both look at every request from the start of the run. **Excess failures** acts the first time the failed flag-on requests exceed the failed stable requests by more than 15. **Cumulative test** acts the first time, with at least 20 completed requests in each version, a one-sided two-proportion z-test of "the flag-on failure rate is higher" over all requests so far gives p below 0.001. Scored as the plan scores.',
    '',
    '| Run | Scenario | Truth | Excess failures acted | Cumulative test acted | Excess failures | Cumulative test |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of counted) {
    out.push(`| ${r.id}-${r.round} | ${r.scenario} | ${r.truth} | ${r.excessRuleActed ? t(r.excessRuleAtS) : 'no'} | ${r.cumulativeRuleActed ? t(r.cumulativeRuleAtS) : 'no'} | ${verdictWord(r.excessRuleRight)} | ${verdictWord(r.cumulativeRuleRight)} |`);
  }
  const tally = (rows, key) => rows.filter((r) => r[key]).length;
  const rules = [['Alibi', 'alibiRight'], ['20-point rule', 'rule20Right'], ['Excess failures (added after the runs)', 'excessRuleRight'], ['Cumulative test (added after the runs)', 'cumulativeRuleRight']];
  out.push('', '### Totals, right out of 24, and by scenario (out of 3)', '', `| Rule | All 24 | ${SCENARIOS.map((s) => s.id).join(' | ')} |`, `|---|---|${SCENARIOS.map(() => '---').join('|')}|`);
  for (const [label, key] of rules) {
    out.push(`| ${label} | ${tally(counted, key)} | ${SCENARIOS.map((s) => tally(counted.filter((r) => r.scenario === s.name), key)).join(' | ')} |`);
  }
  out.push('', '### The same two rules on the 18 earlier runs', '', 'Scored after the fact as above, over the requests before Alibi\'s switch-off (the whole run when it did not switch off).', '', '| Run | Truth | Alibi acted | Excess failures acted | Cumulative test acted | Excess failures | Cumulative test |', '|---|---|---|---|---|---|---|');
  for (const r of earlier) {
    out.push(`| ${r.run} | ${r.truth} | ${r.alibiActed ? t(r.alibiAtS) : 'no'} | ${r.excessRuleActed ? t(r.excessRuleAtS) : 'no'} | ${r.cumulativeRuleActed ? t(r.cumulativeRuleAtS) : 'no'} | ${verdictWord(r.excessRuleRight)} | ${verdictWord(r.cumulativeRuleRight)} |`);
  }
  out.push('', `Totals over the 18 earlier runs, right: Alibi ${tally(earlier, 'alibiRight')}, 20-point rule ${tally(earlier, 'rule20Right')}, excess failures ${tally(earlier, 'excessRuleRight')}, cumulative test ${tally(earlier, 'cumulativeRuleRight')}.`);
  const read = counted.filter((r) => r.flagsmithResultsRead);
  out.push('', '### What Flagsmith\'s own experiment numbers said', '');
  if (read.length === 0) out.push('No run in observe mode read Flagsmith\'s experiment numbers.');
  else {
    out.push('Read at the end of the run, when Alibi had not crossed its threshold (a run in which it had holds no read). Chance that the new checkout beats the stable one on completed checkouts, as Flagsmith reports it:', '', '| Run | Scenario | Chance to win, completed checkouts |', '|---|---|---|');
    for (const r of read) out.push(`| ${r.id}-${r.round} | ${r.scenario} | ${r.flagsmithChanceToWinCompleted === null ? 'not given' : r.flagsmithChanceToWinCompleted.toFixed(4)} |`);
  }
  return out;
}

/** Reads every kept run, takes the first three non-void runs of each scenario in the order they were made, and writes the files. */
function writeAnalysis(engine, meta) {
  const counted = [];
  const voids = [];
  const dirs = existsSync(EVIDENCE) ? readdirSync(EVIDENCE).filter((d) => /^r\d+-/.test(d) && statSync(join(EVIDENCE, d)).isDirectory()).sort() : [];
  const attempts = new Map();
  for (const dir of dirs) {
    const [, name] = /^r\d+-(.+?)(?:\.a\d+)?$/.exec(dir) ?? [];
    const scenario = byName.get(name);
    if (!scenario) continue;
    const info = JSON.parse(readFileSync(join(EVIDENCE, dir, 'run.json'), 'utf8'));
    const file = join(EVIDENCE, dir, `${scenario.name}.jsonl`);
    const attempt = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, attempt);
    let row;
    try {
      row = analyse(engine, scenario, info, readFileSync(file, 'utf8'));
    } catch {
      voids.push({ scenario: name, attempt, reason: 'the recording is incomplete or unreadable' });
      continue;
    }
    if (row.voidReason) {
      voids.push({ scenario: name, attempt, reason: row.voidReason });
      continue;
    }
    row.round = counted.filter((r) => r.scenario === name).length + 1;
    if (row.round <= 3) counted.push(row);
  }
  counted.sort((a, b) => a.round - b.round || SCENARIOS.findIndex((s) => s.name === a.scenario) - SCENARIOS.findIndex((s) => s.name === b.scenario));
  const earlier = scoreEarlier(engine);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify({ harnessCommit: meta.commit, counted, voids, earlierRunsScoredAfterTheFact: earlier }, null, 2)}\n`);
  writeFileSync(join(OUT, 'RESULTS.md'), resultsMarkdown(counted, voids, earlier, meta));
  return { counted: counted.length, voids: voids.length, earlier: earlier.length };
}

// ---------------------------------------------------------------- main

async function main() {
  const engine = await loadEngine();
  if (args.runs) EVIDENCE = resolve(args.runs);
  if (args.earlier) {
    RECORDED = join(resolve(args.earlier), 'recorded');
    EARLIER_EVIDENCE = join(resolve(args.earlier), 'repeats');
  }
  if (args.out) OUT = resolve(args.out);
  formatRelative = engine.formatRelative;
  if (args.analyse) {
    const beforeFix = args['before-fix'] ? JSON.parse(readFileSync(resolve(args['before-fix']), 'utf8')) : undefined;
    console.log(JSON.stringify(writeAnalysis(engine, { commit: args.commit ?? 'unknown', beforeFix })));
    return;
  }
  if (args.dev) {
    const scenario = SCENARIOS.find((s) => s.name === args.dev || s.id === args.dev);
    if (!scenario) throw new Error(`Unknown scenario ${args.dev}`);
    const dir = join(EVIDENCE, 'dev', `${scenario.name}-${Date.now()}`);
    const info = await oneRun(scenario, dir, args.minutes ? ['--minutes', String(args.minutes)] : [], { fresh: !args['no-fresh'] });
    console.log(JSON.stringify({ dir, checks: info.outcome?.checks, requests: info.outcome?.requests }, null, 2));
    return;
  }
  if (!args.commit) throw new Error('The counted runs need --commit <the harness commit hash>');
  const rounds = Number(args.rounds ?? 3);
  const scenarios = args.only ? SCENARIOS.filter((s) => s.name === args.only || s.id === args.only) : SCENARIOS;
  for (let round = 1; round <= rounds; round++) {
    for (const scenario of scenarios) {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const dir = join(EVIDENCE, `r${round}-${scenario.name}${attempt > 1 ? `.a${attempt}` : ''}`);
        if (existsSync(join(dir, 'run.json'))) {
          // made already (a restart with the same arguments): keep it, and stop if it was a good run
          const info = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
          const file = join(dir, `${scenario.name}.jsonl`);
          if (existsSync(file) && !analyse(engine, scenario, info, readFileSync(file, 'utf8')).voidReason) break;
          continue;
        }
        console.log(`${new Date().toISOString()} round ${round} ${scenario.id} ${scenario.name} attempt ${attempt}`);
        const info = await oneRun(scenario, dir);
        const file = join(dir, `${scenario.name}.jsonl`);
        let reason;
        try {
          reason = analyse(engine, scenario, info, readFileSync(file, 'utf8')).voidReason;
        } catch {
          reason = 'the recording is incomplete or unreadable';
        }
        progress(reason ? `void ${scenario.id} round ${round} attempt ${attempt}: ${reason}` : `finished ${scenario.id} round ${round}`);
        if (!reason) break;
      }
    }
    writeAnalysis(engine, { commit: args.commit });
  }
  writeAnalysis(engine, { commit: args.commit });
  progress('all-done');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
