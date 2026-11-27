# Outage scenarios: the plan, written before any of them was run

Committed on 27 November 2026, before the scenarios below existed in code and before any of them was run. The results go in `RESULTS.md` in this folder and in the main README, next to the 18 earlier runs, whichever way they fall.

## Why

The author's rule exists for one case in particular: requests failing because a server or a dependency is down while the experiment runs, unrelated to the feature. The 18 earlier runs cover one such case (the shop's database stopped). On those runs a simple rule that compares the two versions at a 20-point margin decided as well as Alibi, and sooner. This plan tests more outage shapes, mixed with runs where the feature's own code fails, and scores both rules the same way.

## The two rules being compared

- **Alibi's count.** A request counts when it had the flag on, it failed, and every span where an error started is on the flagged code path. Alibi acts when more than 15 have counted. Settings as shipped (`defaultConfig` in `packages/core/src/guard.ts`); nothing is tuned for these runs.
- **The simple 20-point rule.** Over the trailing 60 seconds, with at least 20 completed requests in each version, it acts the first time the flag-on error rate is at least 20 percentage points above the stable error rate. This is the engine's arm comparison with its margin set to 20. It reads no traces.

Also reported, not scored: the same comparison at a 10-point margin, and the plain error-rate rule (flag-on errors over 20% in 30 seconds, at least 20 requests).

## How the runs are made

- The example stack on self-hosted Flagsmith, in experiment mode, half of the shoppers on each version, from a fresh stack for every run.
- Two small services are added for these scenarios: a **tax service** that both checkouts call on every request, and a **rules service** that only the new checkout calls, inside the flagged code path. The shop reaches its database through a fault proxy so that a share of its connections can be made to fail.
- Traffic is 2 requests a second from 600 scripted shoppers unless a scenario says otherwise. No coupon carts unless a scenario says so.
- **Alibi observes and does not switch the flag off in these runs.** If it did, the flag-on traffic would stop and the simple rule would have nothing left to compare, so the two rules would not be judged on the same requests. Alibi's decision in a run is whether, and when, its count passes 15. Its real switch-off, the confirmation and the five-minute watch are what the 18 earlier runs exercise.
- Both rules are evaluated by replaying each run's recording through the engine, the same way the earlier runs are replayed.

## The scenarios and what counts as right

What was done to the stack is the truth. A fault in infrastructure means a dependency or the server was made to fail while the new checkout's code was left correct. A fault in the flagged path means the new checkout's own code was made to fail.

| # | Scenario | What is done | Truth | Right decision |
|---|---|---|---|---|
| O1 | Shared service outage | The tax service is stopped from +01:30 to +03:00. Run length 5 minutes | infrastructure | does not act |
| O2 | Outage of a service only the feature calls | The rules service is stopped from +01:30 to +03:00. 5 minutes | infrastructure | does not act |
| O3 | Flaky database | From +01:30 to +04:30 about 35% of the shop's database connections fail. 6 minutes | infrastructure | does not act |
| O4 | Shared service outage at low traffic | As O1, at 1 request a second. 5 minutes | infrastructure | does not act |
| M1 | Database outage with a bug in the feature | The database is stopped from +01:30 to +03:00. From +01:30 to the end, 1 cart in 5 carries the coupon that crashes the new checkout. 7 minutes | flagged path (and infrastructure) | acts before the run ends |
| M2 | Shared service outage with a bug in the feature | The tax service is stopped from +01:30 to +03:00. Same coupon bug from +01:30 to the end. 7 minutes | flagged path (and infrastructure) | acts before the run ends |
| M3 | A rare bug in the feature | From +01:30 to the end, 1 cart in 20 carries the crashing coupon. No infrastructure fault. 12 minutes | flagged path | acts before the run ends |
| H1 | Nothing wrong | No fault. 5 minutes | healthy | does not act |

Three runs of each, 24 in all.

A rule is **right** in a run when it does what the last column says, and **wrong** otherwise. Acting during an infrastructure-only fault is wrong however reasonable it may look. Not acting by the end of a run in which the feature's own code was failing is wrong.

### What this scoring assumes

- "Right" here is the author's rule: a dependency being down is infrastructure, not the feature. In O2 the dependency that is down is one only the feature uses, so the simple rule is expected to act and be scored wrong, by construction. A team that would rather switch a feature off when its own dependency is down would score O2 the other way. The README will say this beside the result.
- M3 is not an outage. It is here because the plan asks for runs where the flagged path itself fails, and a low failure rate is where a margin on rates and a count of failures can differ.
- Three runs a scenario show what happened three times. They are not a study.

## What is reported

- Every run: failures by class for each version, whether and when Alibi's count passed 15, whether and when the 20-point rule acted, the widest gap between the versions, right or wrong for each rule, and the two unscored rules' times.
- Totals: right and wrong out of 24 for each rule, and by scenario.
- The same scoring applied to the 18 earlier runs, marked as scored after the fact, including the six slow-host runs, in which the fault was the host and both rules switched the flag off.
- If the simple rule decides as well as Alibi, the README says so plainly.

## Rules for the runs themselves

- Runs made while building the scenarios are not counted and are not used to choose settings. The counted runs are the first three complete runs of each scenario made by the unattended script after the scenario code is committed; that commit's hash is written in `RESULTS.md`.
- A run is void only if the stack was not healthy when it started, the scripted fault did not happen (the service did not stop, the proxy did not fail connections, no coupon carts were sent), or the recording is incomplete. Void runs are listed with the reason and run again. A run is never voided for what either rule decided.
- If a scenario cannot be built as written (for example the fault proxy cannot fail a share of connections), this file is amended in its own commit before that scenario's first counted run, and the amendment is listed in `RESULTS.md`.
- No setting of either rule is changed after the first counted run. If a defect is found in the engine while analysing, results are reported both before and after the fix.
- If the runs are not finished by 28 November 2026, 20:00 IST, the README says the scenarios were planned and not finished, and ships the 18 runs as they are.
