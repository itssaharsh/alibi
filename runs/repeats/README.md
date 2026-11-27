# Repeated runs

Each row is one run of a scenario at 2 requests a second from a fresh stack (Flagsmith 2.295.2). Times are from the start of the run. The full run files are not in the repository; `summary.json` has every number below.

| Scenario | Run | Flag-on failures | Stable failures | Counted | Switched off | Recovered | Label | Plain rule | Arm comparison | Widest gap (before Alibi's switch-off, whole run if none) | Chance to win, completed / latency | Replay = live |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| outage | 1 | 82 dependency | 97 dependency | 0 | never | never | none | +01:11 | never | 1.7 points | 0.5356 / 0.7035 | true |
| outage | 2 | 97 dependency | 82 dependency | 0 | never | never | none | +01:10 | +01:19 | 18.6 points | 0.6951 / 0.3744 | true |
| outage | 3 | 99 dependency | 80 dependency | 0 | never | never | none | +01:12 | +02:54 | 18.5 points | 0.2229 / 0.0957 | true |
| outage | 4 | 94 dependency | 85 dependency | 0 | never | never | none | +01:11 | never | 3.8 points | 0.3795 / 0.395 | true |
| outage | 5 | 97 dependency | 82 dependency | 0 | never | never | none | +01:09 | +01:09 | 15.2 points | 0.234 / 0.3332 | true |
| coupon-bug | 1 | 17 flagged-path | 0 | 16 | +02:30 | +03:30 | probably the feature | +01:55 | +01:55 | 26.2 points | 0.0003 / 0 | true |
| coupon-bug | 2 | 16 flagged-path | 0 | 16 | +02:42 | +03:42 | probably the feature | +01:55 | +01:55 | 25.9 points | 0.0018 / 0 | true |
| coupon-bug | 3 | 16 flagged-path | 0 | 16 | +02:37 | +03:37 | probably the feature | +01:58 | +01:58 | 26.3 points | 0.0001 / 0 | true |
| coupon-bug | 4 | 17 flagged-path | 0 | 16 | +02:21 | +03:21 | probably the feature | +01:48 | +01:48 | 25.8 points | 0.0005 / 0 | true |
| coupon-bug | 5 | 16 flagged-path | 0 | 16 | +02:41 | +03:41 | probably the feature | +02:02 | +01:59 | 24.6 points | 0.0003 / 0 | true |
| degraded-host | 1 | 20 flagged-path | 0 | 16 | +01:51 | never | probably not the feature | +01:43 | +01:43 | 30.4 points | 0 / 0.0713 | true |
| degraded-host | 2 | 20 flagged-path, 2 server | 0 | 16 | +01:51 | never | probably not the feature | +01:40 | +01:40 | 31.6 points | 0 / 0.1125 | true |
| degraded-host | 3 | 20 flagged-path | 1 server | 16 | +01:49 | never | probably not the feature | +01:37 | +01:37 | 29.8 points | 0 / 0.2325 | true |
| degraded-host | 4 | 20 flagged-path, 1 dependency, 1 mixed | 0 | 16 | +01:51 | never | probably not the feature | +01:40 | +01:38 | 30.2 points | 0 / 0.0727 | true |
| degraded-host | 5 | 20 flagged-path, 1 server | 0 | 16 | +01:50 | never | probably not the feature | +01:38 | +01:38 | 28.3 points | 0.0001 / 0.1056 | true |

## Without an experiment (plain flag)

The same scenarios against a flag that is not in an experiment (the example started with `ALIBI_EXAMPLE_MODE=plain`): Alibi disables the flag instead of setting a rollout to 0%, sends no experiment events and reads no experiment numbers. One run each, at 2 requests a second from a fresh stack.

| Scenario | Flag-on failures | Stable failures | Counted | Disabled | Recovered | Label | Plain rule | Arm comparison | Widest gap (before Alibi's switch-off, whole run if none) | Replay = live |
|---|---|---|---|---|---|---|---|---|---|---|
| coupon-bug | 16 flagged-path | 0 | 16 | +02:31 | +03:31 | probably the feature | +01:49 | +01:49 | 26.8 points | true |
| outage | 89 dependency | 90 dependency | 0 | never | never | none | +01:10 | +01:10 | 14.6 points | true |
