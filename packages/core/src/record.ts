import type { FlagsmithExperimentSummary, GuardState, InvestigationRecord, Rates, TraceVerdict } from './types.js';
import { buildBaseline } from './baseline.js';
import { recordIdFor } from './guard.js';
import { describeLevel, stableLevelLabel } from './format.js';
import { formatMs, makeRates } from './stats.js';

export function buildRecord(
  state: GuardState,
  verdicts: readonly TraceVerdict[],
  timeline: readonly { atMs: number; text: string }[],
  flagsmith?: FlagsmithExperimentSummary,
): InvestigationRecord {
  const { label, switchedOffAtMs, watchEndsAtMs, stableBaseline } = state;
  if (!label || switchedOffAtMs === undefined || watchEndsAtMs === undefined || !stableBaseline) {
    throw new Error('The watch has not finished, so there is no record yet.');
  }
  const evaluated = verdicts.filter((v) => v.evaluation !== undefined);
  const after = evaluated.filter((v) => v.endMs > switchedOffAtMs && v.endMs <= watchEndsAtMs);
  const traces = verdicts
    .filter((v) => v.failed && v.flagOn)
    .sort((a, b) => Number(b.counted) - Number(a.counted) || a.startMs - b.startMs || (a.traceId < b.traceId ? -1 : 1));
  const record: InvestigationRecord = {
    id: recordIdFor(state.config.flag, switchedOffAtMs),
    flag: state.config.flag,
    label,
    nextStep: 'A person investigates. Alibi does not declare the cause.',
    openedAtMs: watchEndsAtMs,
    switchedOffAtMs,
    threshold: state.config.threshold,
    counted: state.counted,
    notCounted: { ...state.notCounted },
    stableBaseline,
    ...(state.stableBaselineWindow ? { stableBaselineWindow: state.stableBaselineWindow } : {}),
    afterSwitchOff: makeRates(
      after.map((v) => v.durationMs),
      after.filter((v) => v.failed).length,
    ),
    baseline: buildBaseline(verdicts, switchedOffAtMs),
    traces,
    timeline: timeline.map(({ atMs, text }) => ({ atMs, text })),
  };
  if (state.recoveredAtMs !== undefined) record.recoveredAtMs = state.recoveredAtMs;
  if (flagsmith) record.flagsmith = flagsmith;
  return record;
}

const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
const stamp = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
const cell = (value: string | number): string => String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function ratesLine(rates: Rates): string {
  return `${rates.requests} requests, ${rates.failures} failed (${percent(rates.errorRate)}), p95 ${formatMs(rates.p95Ms)}`;
}

export function recordToMarkdown(record: InvestigationRecord): string {
  const out: string[] = [];
  out.push(`# Investigation record: ${record.flag}`, '');
  out.push(`**${record.label}** (not proven)`, '');
  out.push(`Next step: ${record.nextStep}`, '');
  out.push(`Record ${record.id}. Flag switched off at ${stamp(record.switchedOffAtMs)}. Watch ended at ${stamp(record.openedAtMs)}.`, '');

  out.push('## Counts', '');
  const { notCounted } = record;
  out.push(`- Counted: ${record.counted} failures with the flag on, inside the flagged path. The switch-off needs more than ${record.threshold}.`);
  out.push(`- Not counted: ${notCounted.dependency} from a dependency, ${notCounted.server} from the server, ${notCounted.mixed} mixed.`);
  out.push(`- ${stableLevelLabel(record.stableBaselineWindow)}: ${describeLevel(record.stableBaseline)}.`);
  out.push(`- Everyone after the switch-off, within the watch: ${ratesLine(record.afterSwitchOff)}.`);
  out.push(
    record.recoveredAtMs === undefined
      ? '- Error rate and latency did not return to the stable version\'s level inside the watch.'
      : `- Error rate and latency returned to the stable version's level at ${clock(record.recoveredAtMs)} UTC.`,
    '',
  );

  out.push('## Same failing points, flag on against stable', '');
  if (record.baseline.length === 0) {
    out.push('No failing points were recorded.', '');
  } else {
    out.push('| Route | Failing point | Flag on: requests / failed / p95 | Stable: requests / failed / p95 | Why it failed |');
    out.push('|---|---|---|---|---|');
    for (const row of record.baseline) {
      const on = `${row.flagOn.requests} / ${row.flagOn.failures} / ${formatMs(row.flagOn.p95Ms)}`;
      const off = `${row.stable.requests} / ${row.stable.failures} / ${formatMs(row.stable.p95Ms)}`;
      const stable = row.spanExistsInStable ? off : `${off} (the stable version does not run this span; compared at the route)`;
      out.push(`| ${cell(row.route)} | ${cell(row.span)} | ${on} | ${cell(stable)} | ${cell(row.why)} |`);
    }
    out.push('');
  }

  out.push('## Failing requests with the flag on', '');
  if (record.traces.length === 0) out.push('None.', '');
  for (const trace of record.traces) {
    out.push(`- ${trace.counted ? 'Counted' : 'Not counted'}, ${trace.failureClass ?? 'unclassified'}, ${trace.route}, trace ${trace.traceId}`);
    out.push(`  ${trace.reason}`);
  }
  if (record.traces.length > 0) out.push('');

  if (record.flagsmith) {
    out.push('## Flagsmith experiment numbers', '');
    out.push(`Experiment ${record.flagsmith.experimentId}, read at ${stamp(record.flagsmith.readAtMs)}.`, '');
    for (const variation of record.flagsmith.variations) {
      out.push(`- ${variation.variation}: ${variation.exposures} exposures`);
      for (const metric of variation.metrics) out.push(`  - ${metric.name}: ${metric.value}`);
    }
    out.push('');
  }

  out.push('## Timeline', '');
  for (const entry of record.timeline) out.push(`- ${clock(entry.atMs)} ${entry.text}`);
  out.push('');
  return out.join('\n');
}
