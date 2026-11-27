# Use Alibi with your own Flagsmith and service

This starts only Alibi and its live board. Everything else is yours: your Flagsmith, your service, your OpenTelemetry Collector. (`deploy/docker-compose.yml` is the full example that brings all of it up for you.)

## What must already exist

1. **A flag with keyed variations**, for example `checkout_v2` with the value `stable` and a variation whose key and value are both `v2`. Your service reads the flag's string value. Part of your traffic must keep getting the stable value, because recovery after a switch-off is measured against the requests that got the stable version.
2. **Either an experiment on that flag, or no experiment.** Alibi picks the way to switch off from `FLAGSMITH_EXPERIMENT_ID`:

   | | With an experiment (set `FLAGSMITH_EXPERIMENT_ID`) | Without one (leave it empty) |
   |---|---|---|
   | The switch-off | Sets the experiment's rollout to 0%. (On Flagsmith 2.295.2, disabling a flag that is in a running experiment does not change what anyone receives, so the rollout is the switch.) | Disables the flag in the environment. The service's helper then returns its fallback, the stable value |
   | Confirmation | 20 identities are evaluated; every one must get `stable` | the same |
   | Experiment events | Exposures and the three metric events are sent from your spans | None are sent |
   | Flagsmith's own numbers | Read before the watch ends and put in the record | None; the state says why |
   | Feature Health | Posted when configured | the same |

   `ALIBI_SWITCH_OFF=rollout-zero` or `disable-feature` overrides the choice. Disabling needs the flag's name (`ALIBI_FLAG`) or its id (`FLAGSMITH_FEATURE_ID`). It does not work on an environment that uses Flagsmith's feature versioning (v2); the board then says so and the switch-off stays unconfirmed.
3. **With an experiment only: three metrics on it, if you want Flagsmith's numbers in the record**: `checkout_completed` (occurrence, up), `flag_path_failure` (occurrence, down) and `checkout_latency_ms` (mean, down). Alibi sends these events from your spans. Without them Alibi still works; the record just has no Flagsmith numbers.
4. **With an experiment on self-hosted Flagsmith, a warehouse connection** of type "Flagsmith database" in the environment (Experimentation needs it to store events), and `EXPERIMENTATION_ENABLED=true` on the Flagsmith server.
5. **A master API key**, and the environment's client-side key.

Optional: a Feature Health webhook (Project Settings, Feature Health, create a Webhook provider). Put its address in `FLAGSMITH_FEATURE_HEALTH_URL` and Alibi marks the flag unhealthy, with the reason, after a switch-off. It never marks it healthy.

## Start Alibi without cloning anything

The images are published, so a folder with two files is enough. You need Docker with Compose:

```bash
mkdir alibi && cd alibi
curl -fsSLO https://raw.githubusercontent.com/itssaharsh/alibi/main/deploy/attach/docker-compose.images.yml
curl -fsSL https://raw.githubusercontent.com/itssaharsh/alibi/main/deploy/attach/.env.example -o .env
# fill in four values in .env: FLAGSMITH_API_URL, FLAGSMITH_ENVIRONMENT_KEY, FLAGSMITH_ADMIN_KEY, ALIBI_FLAG
docker compose -f docker-compose.images.yml up -d --wait
```

This pulls `ghcr.io/itssaharsh/alibi-guard` and `ghcr.io/itssaharsh/alibi-board` (`linux/amd64`). Set `FLAGSMITH_EXPERIMENT_ID` too if the flag is in an experiment (see below). Then point your collector at port 4319.

## Start Alibi from a clone


```bash
cd deploy/attach
cp .env.example .env      # fill in the values at the top
docker compose up -d --build --wait
```

Alibi is on port 4319 and the board on http://127.0.0.1:4173 (`ALIBI_BOARD_PORT` changes the board's port). Alibi reaches your Flagsmith at `FLAGSMITH_API_URL`, so that address must work from inside the container: a public address, or the Flagsmith container's name when both are on one Docker network.

### Try it against the example stack

To see this setup work without a Flagsmith of your own, use the example stack's Flagsmith as "an existing Flagsmith". Start the example (`docker compose -f deploy/docker-compose.yml up -d --build --wait` from the repository root), then stop its own Alibi and board, and start this one on the example's network:

```bash
docker compose -f deploy/docker-compose.yml stop alibi board
cd deploy/attach
# .env: FLAGSMITH_API_URL=http://flagsmith:8000, the environment key and master key from
# deploy/data/shared/flagsmith.json (environmentKey, masterKey), FLAGSMITH_EXPERIMENT_ID (experimentId; leave it
# empty if you started the example with ALIBI_EXAMPLE_MODE=plain), ALIBI_FLAG=checkout_v2, ALIBI_STABLE_VARIATION=stable
docker compose -f docker-compose.yml -f example-stack.yml up -d --build --wait
node ../../load/run.mjs coupon-bug
```

`example-stack.yml` joins the example's network and gives this Alibi the name `alibi` there, which is where the example's collector already sends its spans. About two and a half minutes into the run the board shows the switch-off and the confirmation. Use `node load/run.mjs reset` before a second run.

## Point your collector at it

```yaml
exporters:
  otlphttp/alibi:
    endpoint: http://alibi:4319
    encoding: json
service:
  pipelines:
    traces:
      exporters: [otlphttp/alibi]   # add it to the exporters you already have
```

Use the host name that reaches Alibi from your collector (`localhost:4319` if the collector runs on the same machine).

## Two helpers for a Node service

`packages/otel-helpers` is a small package with `evaluateFlag` and `runFlagged`; its README shows the whole integration (read the flag and stamp the span; run the new code inside a marked span). You can also copy its single file into your service. Other languages need the same two things: a `feature_flag.evaluation` span event with `feature_flag.key`, `feature_flag.result.variant` and `feature_flag.context.id`, and an `alibi.flagged_path=<flag>` attribute on the span around the new code.

## When something is missing

- Alibi will not start without `FLAGSMITH_API_URL`, `FLAGSMITH_ENVIRONMENT_KEY`, `FLAGSMITH_ADMIN_KEY` and `ALIBI_FLAG`; Compose stops first and names the one that is missing. The stable value is `stable` unless you set `ALIBI_STABLE_VARIATION`. With `ALIBI_SWITCH_OFF=rollout-zero` it also needs `FLAGSMITH_EXPERIMENT_ID`. A value that is not usable is named in one line, for example `PORT must be a whole number above 0`.
- If Flagsmith cannot be reached or refuses the rollout change, the board says **switch-off not confirmed** with Flagsmith's answer and Alibi tries again. It never reports a switch-off that an evaluation of 20 identities did not confirm.
- If the metrics or the experiment results are missing, or there is no experiment, the record is written without Flagsmith's numbers.
- `GET http://127.0.0.1:4319/api/state` shows what Alibi sees: spans received, events sent to Flagsmith and how many it accepted, and the switch-off state.
