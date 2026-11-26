import type { GuardConfig, GuardEvent, Rates } from './types.js';
import type { ReplayResult } from './replay.js';

export interface TimelineEntry {
  atMs: number;
  text: string;
  /** True for a line about one failing request; the record leaves these to its trace list. */
  failure?: boolean;
}

/** `+00:21` for 21 seconds into the run. */
export function formatRelative(ms: number): string {
  const sign = ms < 0 ? '-' : '+';
  const total = Math.floor(Math.abs(ms) / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

function span(ms: number): string {
  if (ms % 60000 === 0) {
    const minutes = ms / 60000;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${Math.round(ms / 1000)} seconds`;
}

function level(rates: Rates): string {
  return `${percent(rates.errorRate)} errors, p95 ${Math.round(rates.p95Ms)} ms, ${rates.requests} requests`;
}

/** One timeline line for an event, or nothing when the event is not worth a line. */
export function describeEvent(event: GuardEvent, config: GuardConfig): TimelineEntry | undefined {
  switch (event.type) {
    case 'verdict': {
      const v = event.verdict;
      if (!v.failed) return undefined;
      const who = v.evaluation ? (v.flagOn ? 'Flag-on' : 'Stable') : 'Unflagged';
      return { atMs: event.atMs, failure: true, text: `${who} request failed on ${v.route} (trace ${v.traceId.slice(0, 8)}). ${v.reason}` };
    }
    case 'plain-rule-tripped':
      return {
        atMs: event.atMs,
        text: `Plain error-rate rule: would have switched the flag off here, ${percent(event.errorRate)} of ${event.requests} flag-on requests failed in ${Math.round(config.plainRule.windowMs / 1000)} seconds.`,
      };
    case 'threshold-crossed':
      return {
        atMs: event.atMs,
        text: `Counter passed ${event.threshold}: ${event.counted} failures on the flagged path with the flag on. Switch-off requested.`,
      };
    case 'switched-off':
      return {
        atMs: event.atMs,
        text: event.confirmed ? `Flagsmith confirmed the switch-off: ${event.detail}` : `Switch-off not confirmed: ${event.detail}`,
      };
    case 'watch-started':
      return {
        atMs: event.atMs,
        text: `Watch started for ${span(event.endsAtMs - event.atMs)}. Stable version level: ${level(event.stableBaseline)}.`,
      };
    case 'recovered':
      return { atMs: event.atMs, text: `Error rate and latency are back at the stable version's level: ${level(event.after)}.` };
    case 'labelled':
      return {
        atMs: event.atMs,
        text: `Label: ${event.label} (not proven). A person investigates. After the switch-off: ${level(event.after)}. Record ${event.recordId}.`,
      };
  }
}

/** The text the command line prints for a finished replay. */
export function formatReport(result: ReplayResult): string {
  const { header, state, timeline } = result;
  const lines: string[] = [header.title, `Planted: ${header.planted}`, `Source: ${header.source}`, '', 'Timeline'];
  for (const entry of timeline) lines.push(`${formatRelative(entry.atMs - header.startedAtMs)}  ${entry.text}`);

  const { notCounted } = state;
  lines.push('', 'Summary');
  lines.push(`  Flag-on failures: ${state.totals.flagOn.failures}`);
  lines.push(`  Counted toward the switch-off: ${state.counted} (the flag goes off above ${state.config.threshold})`);
  lines.push(`  Not counted: ${notCounted.dependency} from a dependency, ${notCounted.server} from the server, ${notCounted.mixed} mixed`);
  lines.push(
    state.plainRuleTrippedAtMs === undefined
      ? '  Plain error-rate rule: would not have switched anything off'
      : `  Plain error-rate rule: would have switched the flag off at ${formatRelative(state.plainRuleTrippedAtMs - header.startedAtMs)}`,
  );
  if (state.label) {
    lines.push(`  Result: ${state.label} (not proven). A person investigates.`);
  } else if (state.phase === 'switching-off') {
    lines.push('  Result: the switch-off was requested but Flagsmith did not confirm it.');
  } else if (state.phase === 'watching') {
    lines.push('  Result: the run ended during the watch, so there is no label yet.');
  } else {
    lines.push('  Result: the flag stayed on.');
  }
  return `${lines.join('\n')}\n`;
}
