// The widest gap between the two versions, by the engine's own arm comparison: over the trailing window (60 seconds),
// with at least a minimum of completed requests in each version, the flag-on error rate minus the stable error rate.
// It is looked at the instants the engine looks at its arm rule: when a judged request is handed to the rule, and at
// each clock tick (every second from the start of the run). A request enters the comparison when the engine hands it
// over, which is after its trace has settled, and counts by the time it ended. `untilMs` stops at the moment the rule
// stops looking (the confirmed switch-off); without it the whole run is covered.
// Both load/repeat.mjs and load/scenarios-matrix.mjs use this one function, on the events of a replay.

const DEFAULT_RULE = { windowMs: 60_000, minRequestsPerArm: 20 };
const TICK_MS = 1000;

/** `events` are the events a replay returned, `header` the run's header. Returns the widest gap in points and when it was. */
export function widestArmGap(events, header, { untilMs = Infinity } = {}) {
  const rule = header.config.armRule ?? DEFAULT_RULE;
  const samples = { on: [], off: [] };
  let best = { points: 0, atMs: null };
  const look = (now) => {
    for (const arm of [samples.on, samples.off]) {
      while (arm.length > 0 && arm[0].t <= now - rule.windowMs) arm.shift();
    }
    if (samples.on.length < rule.minRequestsPerArm || samples.off.length < rule.minRequestsPerArm) return;
    const rate = (arm) => arm.filter((s) => s.f).length / arm.length;
    const points = (rate(samples.on) - rate(samples.off)) * 100;
    if (points > best.points) best = { points, atMs: now };
  };
  let nextTick = header.startedAtMs + TICK_MS;
  for (const event of events) {
    if (event.atMs > untilMs) break;
    for (; nextTick <= event.atMs; nextTick += TICK_MS) look(nextTick);
    if (event.type !== 'verdict' || !event.verdict.evaluation) continue;
    const arm = event.verdict.flagOn ? samples.on : samples.off;
    arm.push({ t: event.verdict.endMs, f: event.verdict.failed });
    arm.sort((a, b) => a.t - b.t);
    look(event.atMs);
  }
  return { points: Math.round(best.points * 10) / 10, atMs: best.atMs };
}
