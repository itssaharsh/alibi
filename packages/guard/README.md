# Alibi guard

The HTTP service in front of the engine in `packages/core`. It receives OpenTelemetry spans from a stock Collector, runs the rule, forwards exposures and metric events to Flagsmith Experimentation, switches the flag off when the rule says so, confirms the switch-off, watches for five minutes and writes the investigation record. All rule logic lives in `@alibi/core`; this package only does the input, output and timing.

Collector side (six lines):

```yaml
exporters:
  otlphttp/alibi:
    endpoint: http://alibi:4319
    encoding: json
```

Build from the repository root: `docker build -f packages/guard/Dockerfile -t alibi-guard .`

## Environment variables

Flagsmith settings come from these variables or from the bootstrap file (`ALIBI_FLAGSMITH_FILE`); a variable wins over the file. At start the service checks them and exits with a one-line reason naming the first one that is missing.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4319` | Port to listen on. |
| `ALIBI_DATA` | `./data` | Where `state.json`, `verdicts.jsonl` and `records/` are written. |
| `ALIBI_FLAGSMITH_FILE` | `/shared/flagsmith.json` | Bootstrap file. Fields read: `internalUrl` (or `url`), `environmentKey`, `masterKey`, `flag`, `stableVariation`, `experimentId`, `metrics` (metric name to id), `serverKey` (only to keep it out of logs). |
| `FLAGSMITH_API_URL` | file `internalUrl` | Flagsmith address. `http://host:8000`, `.../api` and `.../api/v1/` all work. |
| `FLAGSMITH_ENVIRONMENT_KEY` | file `environmentKey` | Environment key: sends events and evaluates identities. Required. |
| `FLAGSMITH_ADMIN_KEY` | file `masterKey` | Master API key for the Admin API (`Authorization: Api-Key`). |
| `FLAGSMITH_ADMIN_TOKEN` | none | A user token (`Authorization: Token`), used when there is no admin key. One of the two is required. |
| `FLAGSMITH_EXPERIMENT_ID` | file `experimentId` | The experiment to switch off and to read results from. Required. When unset it is read from the bootstrap file again at each call, because a reset can create a new experiment. |
| `FLAGSMITH_FEATURE_HEALTH_URL` | file `featureHealthUrl` | The Feature Health webhook address (a secret). When set, the flag is marked unhealthy in Flagsmith after a switch-off, with the count, the most common reason and the switch-off, and again with the label after the watch. Never marked healthy. Only its path is used, on top of `FLAGSMITH_API_URL`. |
| `ALIBI_SWITCH_OFF` | `rollout-zero` | How the flag is switched off: the experiment's rollout is set to 0%, so every identity gets the stable value and the experiment keeps running. |
| `ALIBI_CHECK_IDENTITIES` | `20` | How many identities are evaluated to confirm a switch-off. |
| `ALIBI_RULES` | none | JSON rule file: `flag`, `stableVariation`, `threshold`, `watchMs`, `tolerance`, `plainRule`, `events` (`exposure`, `completed`, `failure`, `latency`). |
| `ALIBI_FLAG`, `ALIBI_STABLE_VARIATION`, `ALIBI_THRESHOLD`, `ALIBI_WATCH_MS` | rule file, then bootstrap file, then `checkout_v2`, `stable`, `15`, `300000` | Override single rule values. |
| `ALIBI_MAX_BODY_BYTES` | `8388608` | Largest accepted body, also after unzipping. |
| `ALIBI_CONTROL_TOKEN` | none | When set, `POST /api/arm`, `/api/world` and `/api/finish` need `Authorization: Bearer <token>` (or `X-Alibi-Token`). |
| `ALIBI_RECORD` | none | Write a run file (JSON lines) to this path. |
| `ALIBI_RECORD_DIR` | none | `POST /api/arm` starts a new run file `<name>.jsonl` here. |
| `ALIBI_RUN_NAME`, `ALIBI_RUN_TITLE`, `ALIBI_RUN_PLANTED` | `live`, the name, `Not stated.` | Header of the run file. |

## HTTP

`POST /v1/traces` (OTLP JSON, gzip accepted), `GET /healthz`, `GET /api/state`, `GET /api/events` (server-sent events: engine events, `rates` once a second, `world`, `state` every 2 s), `GET /api/records`, `GET /api/records/:id` and `:id.md`, `GET /api/traces/:traceId`, `POST /api/world {text}`, `POST /api/arm {name,title,planted,force}`, `POST /api/finish {}` (end of a scenario: reads Flagsmith's results for a run that never switched off, then closes the recording). GET answers allow any origin.

## Flagsmith events

Exposures and the three metric events are forwarded for every request that carries an evaluation of the guarded flag; the stable version is sent as the variation `control`, the key Flagsmith compares everything with. Once the switch-off is confirmed (rollout 0%, nobody is in the experiment) nothing more is sent; `GET /api/state` shows `flagsmith.forwardingStoppedAtMs`. Flagsmith's results are read once, 10 seconds before the watch ends, and Flagsmith fills chance to win and the interval only with 50 identities and 5 conversions in each arm.

## Tests

`npm test` runs against a fake Flagsmith and a hand-moved clock, so a five minute watch takes seconds.
