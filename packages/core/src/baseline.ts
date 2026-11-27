import type { BaselineRow, TraceVerdict } from './types.js';
import { percentile95 } from './stats.js';
import { dependencyKey } from './target.js';

interface Point {
  route: string;
  /** What people read: the span name, with the target when the name alone would not say it. */
  span: string;
  name: string;
  target?: string;
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
      const key = `${verdict.route}\u0000${dependencyKey(origin.name, origin.target)}`;
      const point: Point = failingPoints.get(key) ?? {
        route: verdict.route,
        span: origin.label ?? origin.name,
        name: origin.name,
        ...(origin.target === undefined ? {} : { target: origin.target }),
        reasons: new Map(),
      };
      point.reasons.set(origin.detail, (point.reasons.get(origin.detail) ?? 0) + 1);
      failingPoints.set(key, point);
    }
  }

  const measure = (group: readonly TraceVerdict[], route: string, name: string, target: string | undefined) => {
    const same = (p: { name: string; target?: string }) => p.name === name && p.target === target;
    const onRoute = group.filter((v) => v.route === route);
    const through = onRoute.filter((v) => (v.points ?? []).some(same));
    const durations = through.flatMap((v) => (v.points ?? []).filter(same).map((p) => p.durationMs));
    const failures = through.filter((v) => v.failed && v.origins.some(same)).length;
    return { onRoute, through, stats: { requests: through.length, failures, p95Ms: percentile95(durations) } };
  };

  const rows: BaselineRow[] = [];
  for (const point of failingPoints.values()) {
    const on = measure(flagOn, point.route, point.name, point.target);
    const off = measure(stable, point.route, point.name, point.target);
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
