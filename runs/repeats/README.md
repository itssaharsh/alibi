# Repeated runs

Each row is one run of a scenario at 2 requests a second from a fresh stack (Flagsmith 2.295.2). Times are from the start of the run. The full run files are not in the repository; `summary.json` has every number below.

| Scenario | Run | Flag-on failures | Stable failures | Counted | Switched off | Recovered | Label | Plain rule | Arm comparison | Largest arm gap | Chance to win, completed / latency | Replay = live |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| outage | 1 | 82 dependency | 97 dependency | 0 | never | never | none | +1:12 | never | 0 points | 0.5356 / 0.7035 | true |
| outage | 2 | 97 dependency | 82 dependency | 0 | never | never | none | +1:11 | +1:20 | 15.5 points | 0.6951 / 0.3744 | true |
| outage | 3 | 99 dependency | 80 dependency | 0 | never | never | none | +1:13 | +2:55 | 14 points | 0.2229 / 0.0957 | true |
| outage | 4 | 94 dependency | 85 dependency | 0 | never | never | none | +1:12 | never | 1.2 points | 0.3795 / 0.395 | true |
| outage | 5 | 97 dependency | 82 dependency | 0 | never | never | none | +1:10 | +1:10 | 15.3 points | 0.234 / 0.3332 | true |
| coupon-bug | 1 | 17 flagged-path | 0 | 16 | +2:31 | +3:31 | probably the feature | +1:56 | +1:56 | 30.8 points | 0.0003 / 0 | true |
| coupon-bug | 2 | 16 flagged-path | 0 | 16 | +2:43 | +3:43 | probably the feature | +1:56 | +1:56 | 26.8 points | 0.0018 / 0 | true |
| coupon-bug | 3 | 16 flagged-path | 0 | 16 | +2:38 | +3:38 | probably the feature | +1:58 | +1:58 | 25 points | 0.0001 / 0 | true |
| coupon-bug | 4 | 17 flagged-path | 0 | 16 | +2:22 | +3:22 | probably the feature | +1:49 | +1:49 | 35.3 points | 0.0005 / 0 | true |
| coupon-bug | 5 | 16 flagged-path | 0 | 16 | +2:42 | +3:42 | probably the feature | +2:03 | +1:59 | 23.5 points | 0.0003 / 0 | true |
| degraded-host | 1 | 20 flagged-path | 0 | 16 | +1:52 | never | probably not the feature | +1:43 | +1:43 | 100 points | 0 / 0.0713 | true |
| degraded-host | 2 | 20 flagged-path, 2 server | 0 | 16 | +1:51 | never | probably not the feature | +1:40 | +1:40 | 100 points | 0 / 0.1125 | true |
| degraded-host | 3 | 20 flagged-path | 1 server | 16 | +1:50 | never | probably not the feature | +1:38 | +1:38 | 99 points | 0 / 0.2325 | true |
| degraded-host | 4 | 20 flagged-path, 1 dependency, 1 mixed | 0 | 16 | +1:52 | never | probably not the feature | +1:41 | +1:39 | 100 points | 0 / 0.0727 | true |
| degraded-host | 5 | 20 flagged-path, 1 server | 0 | 16 | +1:51 | never | probably not the feature | +1:38 | +1:38 | 100 points | 0.0001 / 0.1056 | true |
