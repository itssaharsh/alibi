# Use Alibi with your own Flagsmith and service

This starts only Alibi and its live board. Everything else is yours: your Flagsmith, your service, your OpenTelemetry Collector. (`deploy/docker-compose.yml` is the full example that brings all of it up for you.)

## What must already exist

1. **A multivariate flag with keyed variations**, for example `checkout_v2` with the value `stable` and a variation whose key and value are both `v2`. The flag's own value is what your service reads. The variation that is the previous stable version is the experiment's control.
2. **An experiment on that flag**, running. Alibi switches the flag off by setting the experiment's rollout to 0%, because on Flagsmith 2.295.2 disabling a flag that is in a running experiment does not change what anyone receives. Its id is the number in the experiment's address.
3. **Three metrics on the experiment, if you want Flagsmith's own numbers in the record**: `checkout_completed` (occurrence, up), `flag_path_failure` (occurrence, down) and `checkout_latency_ms` (mean, down). Alibi sends these events from your spans. Without them Alibi still works; the record just has no Flagsmith numbers.
4. **For self-hosted Flagsmith, a warehouse connection** of type "Flagsmith database" in the environment (Experimentation needs it to store events), and `EXPERIMENTATION_ENABLED=true` on the Flagsmith server.
5. **A master API key**, and the environment's client-side key.

Optional: a Feature Health webhook (Project Settings, Feature Health, create a Webhook provider). Put its address in `FLAGSMITH_FEATURE_HEALTH_URL` and Alibi marks the flag unhealthy, with the reason, after a switch-off. It never marks it healthy.

## Start Alibi

```bash
cd deploy/attach
cp .env.example .env      # fill in the six values at the top
docker compose up -d --build --wait
```

Alibi is on port 4319 and the board on http://127.0.0.1:4173. If your Flagsmith runs in another Compose project, make it reachable from the `alibi` container (join that project's network in a `docker-compose.override.yml`, or use an address the container can reach).

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

- Alibi will not start without `FLAGSMITH_API_URL`, `FLAGSMITH_ENVIRONMENT_KEY`, `FLAGSMITH_ADMIN_KEY`, `FLAGSMITH_EXPERIMENT_ID`; Compose stops first and names the one that is missing. A value that is not usable is named in one line, for example `PORT must be a whole number above 0`.
- If Flagsmith cannot be reached or refuses the rollout change, the board says **switch-off not confirmed** with Flagsmith's answer and Alibi tries again. It never reports a switch-off that an evaluation of 20 identities did not confirm.
- If the metrics or the experiment results are missing, the record is written without Flagsmith's numbers.
- `GET http://127.0.0.1:4319/api/state` shows what Alibi sees: spans received, events sent to Flagsmith and how many it accepted, and the switch-off state.
