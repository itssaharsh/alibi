# Addendum: two more rules, defined after the runs

Written on 27 November 2026, after the 24 counted runs were made and scored, and before either rule below was computed on them. `PLAN.md` is unchanged. Nothing here was in the plan, and every result from it is marked "added after the runs".

## Why

The plan compares Alibi's count with one simple rule: a comparison of the two versions over the trailing 60 seconds at a 20-point margin. Reviewers asked two fair questions. Does that rule lose mostly because of its window? And would a rule that reads no traces and has no window do as well as Alibi? These two rules answer them on the same 24 recordings. No new runs are made.

## The two rules

Neither reads a trace. Both look at every request from the start of the run, with no window, and are evaluated at the same instants the engine evaluates its other rules.

- **Excess failures.** Acts the first time the number of failed requests with the flag on exceeds the number of failed stable requests by more than 15. This is Alibi's own threshold without the traces: instead of asking where each failure started, it subtracts the stable version's failures.
- **Cumulative test.** With at least 20 completed requests in each version, acts the first time a one-sided two-proportion z-test of "the flag-on failure rate is higher than the stable failure rate", over all requests so far, gives p below 0.001. It is looked at after every request with no correction for looking repeatedly, as a simple alert would be.

## Scoring

The same as the plan: what was done to the stack is the truth, acting during an infrastructure-only fault is wrong, and not acting by the end of a run in which the new checkout's own code was failing is wrong. The same caveat applies to the three runs where a service only the feature calls was stopped.

## What is reported

For each of the 24 runs: whether and when each rule acted, and right or wrong. Totals for each rule, next to Alibi's and the 20-point rule's. Where Flagsmith's own experiment numbers were read in a run, what they said. The README reports the totals whichever way they fall; if either rule decides as well as Alibi, it says so.
