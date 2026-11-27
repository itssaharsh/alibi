# Outage scenarios: results

Harness commit: `10b9a0552f1cec65ad947ed5d944cef734d9cc70`. Flagsmith 2.295.2. Runs made 2026-11-27 to 2026-11-27. The plan is `PLAN.md` in this folder. Times are from the start of the run.

## The counted runs

| Run | Scenario | Truth | New checkout failures | Stable failures | Alibi: count passed 15 | 20-point rule acted | Widest gap | Alibi | 20-point rule | 10-point rule (not scored) | Plain rule (not scored) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| O1-1 | shared-service-outage | infrastructure | 91 dependency | 90 dependency | no | no | 16.4 points | right | right | +2:14 | +1:39 |
| O2-1 | feature-service-outage | infrastructure | 86 dependency | 0 | no | +1:43 | 100 points | right | wrong | +1:40 | +1:40 |
| O3-1 | database-flaky | infrastructure | 46 dependency | 61 dependency | no | no | 16.9 points | right | right | +1:59 | +1:46 |
| O4-1 | shared-service-outage-low-traffic | infrastructure | 45 dependency | 45 dependency | no | +2:15 | 21.2 points | right | wrong | +1:47 | never |
| M1-1 | database-outage-with-bug | flagged path (and infrastructure) | 50 flagged-path, 97 dependency | 84 dependency | +4:33 | +4:39 | 31.6 points | right | right | +1:43 | +1:37 |
| M2-1 | shared-service-outage-with-bug | flagged path (and infrastructure) | 83 dependency, 36 flagged-path | 98 dependency | +4:45 | +5:15 | 20.7 points | right | right | +1:58 | +1:39 |
| M3-1 | rare-bug | flagged path | 33 flagged-path | 0 | +5:38 | no | 9.5 points | right | wrong | +5:14 | never |
| H1-1 | healthy | healthy | 0 | 0 | no | no | 0 points | right | right | never | never |
| O1-2 | shared-service-outage | infrastructure | 94 dependency | 87 dependency | no | no | 12.2 points | right | right | +1:40 | +1:37 |
| O2-2 | feature-service-outage | infrastructure | 98 dependency | 0 | no | +1:44 | 100 points | right | wrong | +1:39 | +1:40 |
| O3-2 | database-flaky | infrastructure | 76 dependency | 63 dependency | no | no | 6.9 points | right | right | never | +1:48 |
| O4-2 | shared-service-outage-low-traffic | infrastructure | 42 dependency | 48 dependency | no | no | 12.1 points | right | right | +2:25 | never |
| M1-2 | database-outage-with-bug | flagged path (and infrastructure) | 84 dependency, 46 flagged-path | 97 dependency | +4:26 | +3:49 | 25.1 points | right | right | +3:15 | +1:39 |
| M2-2 | shared-service-outage-with-bug | flagged path (and infrastructure) | 90 dependency, 39 flagged-path | 91 dependency | +4:44 | +3:40 | 22.6 points | right | right | +3:21 | +1:41 |
| M3-2 | rare-bug | flagged path | 24 flagged-path | 0 | +7:48 | no | 8.3 points | right | wrong | never | never |
| H1-2 | healthy | healthy | 0 | 0 | no | no | 0 points | right | right | never | never |
| O1-3 | shared-service-outage | infrastructure | 92 dependency | 89 dependency | no | no | 13.6 points | right | right | +2:12 | +1:41 |
| O2-3 | feature-service-outage | infrastructure | 84 dependency | 0 | no | +1:47 | 100 points | right | wrong | +1:44 | +1:47 |
| O3-3 | database-flaky | infrastructure | 63 dependency | 57 dependency | no | no | 13.1 points | right | right | +1:46 | +1:41 |
| O4-3 | shared-service-outage-low-traffic | infrastructure | 45 dependency | 45 dependency | no | no | 8.7 points | right | right | never | never |
| M1-3 | database-outage-with-bug | flagged path (and infrastructure) | 79 dependency, 46 flagged-path | 102 dependency | +4:50 | +5:09 | 32.7 points | right | right | +3:52 | +1:42 |
| M2-3 | shared-service-outage-with-bug | flagged path (and infrastructure) | 100 dependency, 45 flagged-path | 81 dependency | +4:55 | +5:09 | 23.6 points | right | right | +3:35 | +1:40 |
| M3-3 | rare-bug | flagged path | 25 flagged-path | 0 | +8:25 | no | 9.1 points | right | wrong | never | never |
| H1-3 | healthy | healthy | 0 | 0 | no | no | 0 points | right | right | never | never |

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

| Run | Truth | Alibi acted | Widest gap before the switch-off | 20-point rule acted | Alibi | 20-point rule | 10-point rule (not scored) | Plain rule (not scored) |
|---|---|---|---|---|---|---|---|---|
| runs/outage.jsonl | infrastructure | no | 18.1 points | no | right | right | +1:23 | +1:17 |
| runs/coupon-bug.jsonl | flagged path | +2:31 | 34 points | yes | right | right | +1:58 | +1:59 |
| runs/slow-host.jsonl | infrastructure (the host) | +1:49 | 32.2 points | yes | wrong | wrong | +1:37 | +1:37 |
| repeat outage 1 | infrastructure | no | 1.3 points | no | right | right | never | +1:12 |
| repeat outage 2 | infrastructure | no | 17.8 points | no | right | right | +1:20 | +1:11 |
| repeat outage 3 | infrastructure | no | 16.3 points | no | right | right | +2:55 | +1:13 |
| repeat outage 4 | infrastructure | no | 3.2 points | no | right | right | never | +1:12 |
| repeat outage 5 | infrastructure | no | 16.8 points | no | right | right | +1:10 | +1:10 |
| repeat coupon-bug 1 | flagged path | +2:31 | 26.2 points | yes | right | right | +1:56 | +1:56 |
| repeat coupon-bug 2 | flagged path | +2:43 | 26.8 points | yes | right | right | +1:56 | +1:56 |
| repeat coupon-bug 3 | flagged path | +2:38 | 25.5 points | yes | right | right | +1:58 | +1:58 |
| repeat coupon-bug 4 | flagged path | +2:22 | 26.6 points | yes | right | right | +1:49 | +1:49 |
| repeat coupon-bug 5 | flagged path | +2:42 | 23.3 points | yes | right | right | +1:59 | +2:03 |
| repeat degraded-host 1 | infrastructure (the host) | +1:52 | 35.7 points | yes | wrong | wrong | +1:43 | +1:43 |
| repeat degraded-host 2 | infrastructure (the host) | +1:51 | 38.6 points | yes | wrong | wrong | +1:40 | +1:40 |
| repeat degraded-host 3 | infrastructure (the host) | +1:50 | 35.4 points | yes | wrong | wrong | +1:38 | +1:38 |
| repeat degraded-host 4 | infrastructure (the host) | +1:52 | 33.8 points | yes | wrong | wrong | +1:39 | +1:41 |
| repeat degraded-host 5 | infrastructure (the host) | +1:51 | 34.4 points | yes | wrong | wrong | +1:38 | +1:38 |

Totals over 18 earlier runs: Alibi 12 right, 6 wrong; 20-point rule 12 right, 6 wrong.
- outage (6 runs): Alibi 6 right, 0 wrong; 20-point rule 6 right, 0 wrong.
- coupon-bug (6 runs): Alibi 6 right, 0 wrong; 20-point rule 6 right, 0 wrong.
- slow-host (6 runs): Alibi 0 right, 6 wrong; 20-point rule 0 right, 6 wrong.
