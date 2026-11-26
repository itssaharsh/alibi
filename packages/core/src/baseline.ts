import type { BaselineRow, TraceVerdict } from './types.js';
import { percentile95 } from './stats.js';

interface Point {
  route: string;
  span: string;
  reasons: Map<string, number>;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * For each failing point among flag-on failures (route and origin span name), the same span in
 * flag-on and in stable requests over the same period, which ends at `untilMs`.
 */
export function buildBaseline(verdicts: readonly TraceVerdict[], untilMs: number = Infinity): BaselineRow[] {
  const inPeriod = verdicts.filter((v) => v.evaluation !== undefined && v.endMs <= untilMs);
  const flagOn = inPeriod.filter((v) => v.flagOn);
  const stable = inPeriod.filter((v) => !v.flagOn);

  const failingPoints = new Map<string, Point>();
  for (const verdict of flagOn) {
    if (!verdict.failed) continue;
    for (const origin of verdict.origins) {
      const key = `${verdict.route}\u0000${origin.name}`;
      const point = failingPoints.get(key) ?? { route: verdict.route, span: origin.name, reasons: new Map() };
      point.reasons.set(origin.detail, (point.reasons.get(origin.detail) ?? 0) + 1);
      failingPoints.set(key, point);
    }
  }

  const measure = (group: readonly TraceVerdict[], route: string, span: string) => {
    const onRoute = group.filter((v) => v.route === route);
    const through = onRoute.filter((v) => (v.points ?? []).some((p) => p.name === span));
    const durations = through.flatMap((v) => (v.points ?? []).filter((p) => p.name === span).map((p) => p.durationMs));
    const failures = through.filter((v) => v.failed && v.origins.some((o) => o.name === span)).length;
    return { onRoute, through, stats: { requests: through.length, failures, p95Ms: percentile95(durations) } };
  };

  const rows: BaselineRow[] = [];
  for (const point of failingPoints.values()) {
    const on = measure(flagOn, point.route, point.span);
    const off = measure(stable, point.route, point.span);
    const spanExistsInStable = off.through.length > 0;
    const why = [...point.reasons.entries()].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))[0]?.[0] ?? '';
    rows.push({
      route: point.route,
      span: point.span,
      flagOn: on.stats,
      stable: spanExistsInStable
        ? off.stats
        : {
            requests: off.onRoute.length,
            failures: off.onRoute.filter((v) => v.failed).length,
            p95Ms: percentile95(off.onRoute.map((v) => v.durationMs)),
          },
      spanExistsInStable,
      why,
    });
  }
  return rows.sort((a, b) => b.flagOn.failures - a.flagOn.failures || compare(a.route, b.route) || compare(a.span, b.span));
}
