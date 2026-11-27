// Two more rules, defined in runs/outage-scenarios/ADDENDUM.md after the counted runs were scored. Neither reads a trace and
// neither has a window: both look at every request from the start of the run, and are evaluated where load/arm-gap.mjs
// looks, each time a judged request is handed to the rule. They are replayed on the events of a replay; nothing is switched
// off. `untilMs` stops them where Alibi switched off (the earlier runs), without it the whole run is covered.

/** Upper tail of the standard normal, by the Chebyshev fit of Numerical Recipes' erfc (fractional error under 1.2e-7). */
function upperTail(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const erfc =
    t *
    Math.exp(
      -x * x -
        1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  const tail = 0.5 * erfc;
  return z >= 0 ? tail : 1 - tail;
}

/** One-sided two-proportion z-test with pooled variance: the chance of a flag-on failure rate this much above the stable one if the two were equal. */
export function oneSidedTwoProportionP(failedOn, requestsOn, failedOff, requestsOff) {
  const pooled = (failedOn + failedOff) / (requestsOn + requestsOff);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / requestsOn + 1 / requestsOff));
  if (se === 0) return 1;
  return upperTail((failedOn / requestsOn - failedOff / requestsOff) / se);
}

export const EXCESS_THRESHOLD = 15;
export const MIN_PER_VERSION = 20;
export const P_LIMIT = 0.001;

/** The first time each rule acts, as the engine's clock reads it, or null. */
export function extraRules(events, { untilMs = Infinity } = {}) {
  const on = { n: 0, f: 0 };
  const off = { n: 0, f: 0 };
  let excess = null;
  let cumulative = null;
  for (const event of events) {
    if (event.atMs > untilMs) break;
    if (event.type !== 'verdict' || !event.verdict.evaluation) continue;
    const arm = event.verdict.flagOn ? on : off;
    arm.n += 1;
    if (event.verdict.failed) arm.f += 1;
    if (excess === null && on.f - off.f > EXCESS_THRESHOLD) excess = event.atMs;
    if (cumulative === null && on.n >= MIN_PER_VERSION && off.n >= MIN_PER_VERSION && oneSidedTwoProportionP(on.f, on.n, off.f, off.n) < P_LIMIT) cumulative = event.atMs;
    if (excess !== null && cumulative !== null) break;
  }
  return { excessAtMs: excess, cumulativeAtMs: cumulative };
}
