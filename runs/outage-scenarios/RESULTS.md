# Outage scenarios: results

Harness commit: `10b9a0552f1cec65ad947ed5d944cef734d9cc70`. Flagsmith 2.295.2. Runs made 2026-11-27 to 2026-11-27. The plan is `PLAN.md` in this folder. Times are from the start of the run.

## The counted runs

| Run | Scenario | Truth | New checkout failures | Stable failures | Alibi: count passed 15 | 20-point rule acted | Widest gap (whole run) | Alibi | 20-point rule | 10-point rule (not scored) | Plain rule (not scored) | Notices |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| O1-1 | shared-service-outage | infrastructure | 91 dependency | 90 dependency | no | no | 14.6 points | right | right | +02:13 | +01:38 | none |
| O2-1 | feature-service-outage | infrastructure | 86 dependency | 0 | no | +01:43 | 100 points | right | wrong | +01:39 | +01:39 | a dependency only the flagged path calls (GET rules:3000) at +01:39 |
| O3-1 | database-flaky | infrastructure | 46 dependency | 61 dependency | no | no | 18.8 points | right | right | +01:58 | +01:45 | none |
| O4-1 | shared-service-outage-low-traffic | infrastructure | 45 dependency | 45 dependency | no | +02:14 | 20.1 points | right | wrong | +01:46 | never | none |
| M1-1 | database-outage-with-bug | flagged path (and infrastructure) | 50 flagged-path, 97 dependency | 84 dependency | +04:32 | +04:38 | 33.3 points | right | right | +01:42 | +01:37 | none |
| M2-1 | shared-service-outage-with-bug | flagged path (and infrastructure) | 83 dependency, 36 flagged-path | 98 dependency | +04:45 | +05:14 | 21.1 points | right | right | +01:57 | +01:38 | none |
| M3-1 | rare-bug | flagged path | 33 flagged-path | 0 | +05:37 | no | 10 points | right | wrong | +05:13 | never | none |
| H1-1 | healthy | healthy | 0 | 0 | no | no | 0 points | right | right | never | never | none |
| O1-2 | shared-service-outage | infrastructure | 94 dependency | 87 dependency | no | no | 12.2 points | right | right | +01:39 | +01:36 | none |
| O2-2 | feature-service-outage | infrastructure | 98 dependency | 0 | no | +01:43 | 100 points | right | wrong | +01:38 | +01:39 | a dependency only the flagged path calls (GET rules:3000) at +01:38 |
| O3-2 | database-flaky | infrastructure | 76 dependency | 63 dependency | no | no | 9.6 points | right | right | never | +01:47 | none |
| O4-2 | shared-service-outage-low-traffic | infrastructure | 42 dependency | 48 dependency | no | no | 13.3 points | right | right | +02:24 | never | none |
| M1-2 | database-outage-with-bug | flagged path (and infrastructure) | 84 dependency, 46 flagged-path | 97 dependency | +04:25 | +03:49 | 25 points | right | right | +03:14 | +01:38 | none |
| M2-2 | shared-service-outage-with-bug | flagged path (and infrastructure) | 90 dependency, 39 flagged-path | 91 dependency | +04:43 | +03:39 | 23.7 points | right | right | +03:20 | +01:40 | none |
| M3-2 | rare-bug | flagged path | 24 flagged-path | 0 | +07:48 | no | 9.1 points | right | wrong | never | never | none |
| H1-2 | healthy | healthy | 0 | 0 | no | no | 0 points | right | right | never | never | none |
| O1-3 | shared-service-outage | infrastructure | 92 dependency | 89 dependency | no | no | 14.9 points | right | right | +02:12 | +01:40 | none |
| O2-3 | feature-service-outage | infrastructure | 84 dependency | 0 | no | +01:46 | 100 points | right | wrong | +01:43 | +01:46 | a dependency only the flagged path calls (GET rules:3000) at +01:43 |
| O3-3 | database-flaky | infrastructure | 63 dependency | 57 dependency | no | no | 14.2 points | right | right | +01:45 | +01:41 | none |
| O4-3 | shared-service-outage-low-traffic | infrastructure | 45 dependency | 45 dependency | no | no | 8.4 points | right | right | never | never | none |
| M1-3 | database-outage-with-bug | flagged path (and infrastructure) | 79 dependency, 46 flagged-path | 102 dependency | +04:50 | +05:08 | 33.3 points | right | right | +03:51 | +01:41 | none |
| M2-3 | shared-service-outage-with-bug | flagged path (and infrastructure) | 100 dependency, 45 flagged-path | 81 dependency | +04:55 | +05:08 | 23.6 points | right | right | +03:34 | +01:39 | none |
| M3-3 | rare-bug | flagged path | 25 flagged-path | 0 | +08:25 | no | 9.4 points | right | wrong | never | never | none |
| H1-3 | healthy | healthy | 0 | 0 | no | no | 0 points | right | right | never | never | none |

## Totals

| | Alibi right | Alibi wrong | 20-point rule right | 20-point rule wrong |
|---|---|---|---|---|
| All 24 runs | 24 | 0 | 17 | 7 |
| O1 shared-service-outage (3 runs) | 3 | 0 | 3 | 0 |
| O2 feature-service-outage (3 runs) | 3 | 0 | 0 | 3 |
| O3 database-flaky (3 runs) | 3 | 0 | 3 | 0 |
| O4 shared-service-outage-low-traffic (3 runs) | 3 | 0 | 2 | 1 |
| M1 database-outage-with-bug (3 runs) | 3 | 0 | 3 | 0 |
| M2 shared-service-outage-with-bug (3 runs) | 3 | 0 | 3 | 0 |
| M3 rare-bug (3 runs) | 3 | 0 | 0 | 3 |
| H1 healthy (3 runs) | 3 | 0 | 3 | 0 |

## Harness notes before the counted runs

A development run of the scenario where the rules service is stopped showed database connection timeouts for both versions, which nothing in that scenario should cause. The cause was name resolution: Node looks host names up on four shared threads, a stopped container's name takes Docker's resolver five seconds to give up on, and those hung lookups held every thread, so lookups the shop needed for other things (the database proxy, which was reached on a new connection per request, and the flag service) waited behind them until the 1.5 second connect timeout.

The shop now gets the addresses of the tax service, the rules service and the fault proxy in its hosts file, on a network with fixed addresses, so a stopped service simply does not answer and only its callers fail; and the shop uses its normal connection pool in every scenario except the flaky database one, where it takes a connection per request so that the proxy's share of failing connections is the share of failing requests.

## After the runs

The recordings are unchanged. The tables were regenerated from them on 27 November, after the counted runs, to add the Notices column, to print every time with the engine's own formatter, and to compute the widest gap with one function (`load/arm-gap.mjs`) at the instants the engine evaluates its comparison. That moved the printed widest gaps by under 3 points in the counted runs, and no right or wrong changed. In the counted runs, each rule's "acted" time is the engine's own event, not derived from the gap column. In the table of the 18 earlier runs, scored after the fact, it is derived: the 20-point rule counts as having acted when the widest gap before Alibi's switch-off reached 20 points.

### An engine defect found while analysing

The engine identified a dependency by its span name, and the HTTP client spans for the tax service and the rules service are both named `GET`, so a call to the rules service was taken for a call both versions make. The engine now identifies a dependency by its name and its target. The recordings were replayed with the engine before and after the fix; the Notices column reads:

| Run | Before the fix | After the fix |
|---|---|---|
| O2-1 | a shared dependency both versions call (GET) at +02:06 | a dependency only the flagged path calls (GET rules:3000) at +01:39 |
| O2-2 | a shared dependency both versions call (GET) at +02:12 | a dependency only the flagged path calls (GET rules:3000) at +01:38 |
| O2-3 | a shared dependency both versions call (GET) at +02:16 | a dependency only the flagged path calls (GET rules:3000) at +01:43 |

Comparing the two summaries, nothing else differs: no count, time or right or wrong changed, and every other column is the same.

## Void runs

None.

## Checks that the scripted fault happened

| Run | Stopped service, running after stop / after start | Proxy toxic listed while on / after removal | Coupon carts sent / to the new checkout |
|---|---|---|---|
| O1-1 | tax: false / true | none | 0 / 0 |
| O2-1 | rules: false / true | none | 0 / 0 |
| O3-1 | none | true / false | 0 / 0 |
| O4-1 | tax: false / true | none | 0 / 0 |
| M1-1 | shop-db: false / true | none | 123 / 72 |
| M2-1 | tax: false / true | none | 122 / 50 |
| M3-1 | none | none | 49 / 33 |
| H1-1 | none | none | 0 / 0 |
| O1-2 | tax: false / true | none | 0 / 0 |
| O2-2 | rules: false / true | none | 0 / 0 |
| O3-2 | none | true / false | 0 / 0 |
| O4-2 | tax: false / true | none | 0 / 0 |
| M1-2 | shop-db: false / true | none | 122 / 69 |
| M2-2 | tax: false / true | none | 122 / 60 |
| M3-2 | none | none | 49 / 24 |
| H1-2 | none | none | 0 / 0 |
| O1-3 | tax: false / true | none | 0 / 0 |
| O2-3 | rules: false / true | none | 0 / 0 |
| O3-3 | none | true / false | 0 / 0 |
| O4-3 | tax: false / true | none | 0 / 0 |
| M1-3 | shop-db: false / true | none | 122 / 63 |
| M2-3 | tax: false / true | none | 122 / 68 |
| M3-3 | none | none | 49 / 25 |
| H1-3 | none | none | 0 / 0 |

## The 18 earlier runs, scored after the fact

Scored by the same definition, after the plan was written. Alibi acted when it switched the flag off. The 20-point rule counts as having acted when the widest gap between the versions, up to Alibi's switch-off (the whole run when it did not switch off), was at least 20 points.

| Run | Truth | Alibi acted | Widest gap (before Alibi's switch-off, whole run if none) | 20-point rule acted | Alibi | 20-point rule | 10-point rule (not scored) | Plain rule (not scored) |
|---|---|---|---|---|---|---|---|---|
| runs/outage.jsonl | infrastructure | no | 19.2 points | no | right | right | +01:22 | +01:16 |
| runs/coupon-bug.jsonl | flagged path | +02:30 | 33.3 points | yes | right | right | +01:58 | +01:58 |
| runs/slow-host.jsonl | infrastructure (the host) | +01:48 | 26.7 points | yes | wrong | wrong | +01:36 | +01:36 |
| repeat outage 1 | infrastructure | no | 1.7 points | no | right | right | never | +01:11 |
| repeat outage 2 | infrastructure | no | 18.6 points | no | right | right | +01:19 | +01:10 |
| repeat outage 3 | infrastructure | no | 18.5 points | no | right | right | +02:54 | +01:12 |
| repeat outage 4 | infrastructure | no | 3.8 points | no | right | right | never | +01:11 |
| repeat outage 5 | infrastructure | no | 15.2 points | no | right | right | +01:09 | +01:09 |
| repeat coupon-bug 1 | flagged path | +02:30 | 26.2 points | yes | right | right | +01:55 | +01:55 |
| repeat coupon-bug 2 | flagged path | +02:42 | 25.9 points | yes | right | right | +01:55 | +01:55 |
| repeat coupon-bug 3 | flagged path | +02:37 | 26.3 points | yes | right | right | +01:58 | +01:58 |
| repeat coupon-bug 4 | flagged path | +02:21 | 25.8 points | yes | right | right | +01:48 | +01:48 |
| repeat coupon-bug 5 | flagged path | +02:41 | 24.6 points | yes | right | right | +01:59 | +02:02 |
| repeat degraded-host 1 | infrastructure (the host) | +01:51 | 30.4 points | yes | wrong | wrong | +01:43 | +01:43 |
| repeat degraded-host 2 | infrastructure (the host) | +01:51 | 31.6 points | yes | wrong | wrong | +01:40 | +01:40 |
| repeat degraded-host 3 | infrastructure (the host) | +01:49 | 29.8 points | yes | wrong | wrong | +01:37 | +01:37 |
| repeat degraded-host 4 | infrastructure (the host) | +01:51 | 30.2 points | yes | wrong | wrong | +01:38 | +01:40 |
| repeat degraded-host 5 | infrastructure (the host) | +01:50 | 28.3 points | yes | wrong | wrong | +01:38 | +01:38 |

Totals over 18 earlier runs: Alibi 12 right, 6 wrong; 20-point rule 12 right, 6 wrong.
- outage (6 runs): Alibi 6 right, 0 wrong; 20-point rule 6 right, 0 wrong.
- coupon-bug (6 runs): Alibi 6 right, 0 wrong; 20-point rule 6 right, 0 wrong.
- slow-host (6 runs): Alibi 0 right, 6 wrong; 20-point rule 0 right, 6 wrong.

## Two more rules, added after the runs

Defined in `ADDENDUM.md` after the 24 counted runs were scored and before these rules were computed on them. Neither reads a trace and neither has a window; both look at every request from the start of the run. **Excess failures** acts the first time the failed flag-on requests exceed the failed stable requests by more than 15. **Cumulative test** acts the first time, with at least 20 completed requests in each version, a one-sided two-proportion z-test of "the flag-on failure rate is higher" over all requests so far gives p below 0.001. Scored as the plan scores.

| Run | Scenario | Truth | Excess failures acted | Cumulative test acted | Excess failures | Cumulative test |
|---|---|---|---|---|---|---|
| O1-1 | shared-service-outage | infrastructure | no | no | right | right |
| O2-1 | feature-service-outage | infrastructure | +01:48 | +01:41 | wrong | wrong |
| O3-1 | database-flaky | infrastructure | no | no | right | right |
| O4-1 | shared-service-outage-low-traffic | infrastructure | no | no | right | right |
| M1-1 | database-outage-with-bug | flagged path (and infrastructure) | +02:09 | +05:07 | right | right |
| M2-1 | shared-service-outage-with-bug | flagged path (and infrastructure) | +06:27 | no | right | wrong |
| M3-1 | rare-bug | flagged path | +05:37 | +03:54 | right | right |
| H1-1 | healthy | healthy | no | no | right | right |
| O1-2 | shared-service-outage | infrastructure | no | no | right | right |
| O2-2 | feature-service-outage | infrastructure | +01:47 | +01:42 | wrong | wrong |
| O3-2 | database-flaky | infrastructure | +02:59 | no | wrong | right |
| O4-2 | shared-service-outage-low-traffic | infrastructure | no | no | right | right |
| M1-2 | database-outage-with-bug | flagged path (and infrastructure) | +05:34 | no | right | wrong |
| M2-2 | shared-service-outage-with-bug | flagged path (and infrastructure) | +04:49 | no | right | wrong |
| M3-2 | rare-bug | flagged path | +07:48 | +05:08 | right | right |
| H1-2 | healthy | healthy | no | no | right | right |
| O1-3 | shared-service-outage | infrastructure | no | no | right | right |
| O2-3 | feature-service-outage | infrastructure | +01:49 | +01:45 | wrong | wrong |
| O3-3 | database-flaky | infrastructure | no | no | right | right |
| O4-3 | shared-service-outage-low-traffic | infrastructure | no | no | right | right |
| M1-3 | database-outage-with-bug | flagged path (and infrastructure) | +06:24 | no | right | wrong |
| M2-3 | shared-service-outage-with-bug | flagged path (and infrastructure) | +02:08 | +06:44 | right | right |
| M3-3 | rare-bug | flagged path | +08:25 | +04:55 | right | right |
| H1-3 | healthy | healthy | no | no | right | right |

### Totals, right out of 24, and by scenario (out of 3)

| Rule | All 24 | O1 | O2 | O3 | O4 | M1 | M2 | M3 | H1 |
|---|---|---|---|---|---|---|---|---|---|
| Alibi | 24 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| 20-point rule | 17 | 3 | 0 | 3 | 2 | 3 | 3 | 0 | 3 |
| Excess failures (added after the runs) | 20 | 3 | 0 | 2 | 3 | 3 | 3 | 3 | 3 |
| Cumulative test (added after the runs) | 17 | 3 | 0 | 3 | 3 | 1 | 1 | 3 | 3 |

### The same two rules on the 18 earlier runs

Scored after the fact as above, over the requests before Alibi's switch-off (the whole run when it did not switch off).

| Run | Truth | Alibi acted | Excess failures acted | Cumulative test acted | Excess failures | Cumulative test |
|---|---|---|---|---|---|---|
| runs/outage.jsonl | infrastructure | no | +02:18 | no | wrong | right |
| runs/coupon-bug.jsonl | flagged path | +02:30 | +02:29 | +02:13 | right | right |
| runs/slow-host.jsonl | infrastructure (the host) | +01:48 | +01:48 | +01:44 | wrong | wrong |
| repeat outage 1 | infrastructure | no | no | no | right | right |
| repeat outage 2 | infrastructure | no | +02:26 | no | wrong | right |
| repeat outage 3 | infrastructure | no | +01:50 | no | wrong | right |
| repeat outage 4 | infrastructure | no | no | no | right | right |
| repeat outage 5 | infrastructure | no | +01:31 | no | wrong | right |
| repeat coupon-bug 1 | flagged path | +02:30 | +02:29 | +02:00 | right | right |
| repeat coupon-bug 2 | flagged path | +02:42 | +02:41 | +02:09 | right | right |
| repeat coupon-bug 3 | flagged path | +02:37 | +02:36 | +02:10 | right | right |
| repeat coupon-bug 4 | flagged path | +02:21 | +02:21 | +02:06 | right | right |
| repeat coupon-bug 5 | flagged path | +02:41 | +02:40 | +02:11 | right | right |
| repeat degraded-host 1 | infrastructure (the host) | +01:51 | +01:50 | +01:46 | wrong | wrong |
| repeat degraded-host 2 | infrastructure (the host) | +01:51 | +01:49 | +01:46 | wrong | wrong |
| repeat degraded-host 3 | infrastructure (the host) | +01:49 | +01:49 | +01:39 | wrong | wrong |
| repeat degraded-host 4 | infrastructure (the host) | +01:51 | +01:50 | +01:46 | wrong | wrong |
| repeat degraded-host 5 | infrastructure (the host) | +01:50 | +01:50 | +01:44 | wrong | wrong |

Totals over the 18 earlier runs, right: Alibi 12, 20-point rule 12, excess failures 8, cumulative test 12.

### What Flagsmith's own experiment numbers said

Read at the end of the run, when Alibi had not crossed its threshold (a run in which it had holds no read). Chance that the new checkout beats the stable one on completed checkouts, as Flagsmith reports it:

| Run | Scenario | Chance to win, completed checkouts |
|---|---|---|
| O1-1 | shared-service-outage | 0.3908 |
| O2-1 | feature-service-outage | 0.0000 |
| O3-1 | database-flaky | 0.2521 |
| O4-1 | shared-service-outage-low-traffic | 0.2411 |
| H1-1 | healthy | 0.5000 |
| O1-2 | shared-service-outage | 0.2490 |
| O2-2 | feature-service-outage | 0.0000 |
| O3-2 | database-flaky | 0.8112 |
| O4-2 | shared-service-outage-low-traffic | 0.8880 |
| H1-2 | healthy | 0.5000 |
| O1-3 | shared-service-outage | 0.0948 |
| O2-3 | feature-service-outage | 0.0000 |
| O3-3 | database-flaky | 0.7444 |
| O4-3 | shared-service-outage-low-traffic | 0.6690 |
| H1-3 | healthy | 0.5000 |
