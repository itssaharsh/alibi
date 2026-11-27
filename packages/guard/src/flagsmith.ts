import { readFile } from 'node:fs/promises';
import type { FlagsmithExperimentSummary } from '@alibi/core';
import type { Tracker } from './clock.js';
import type { FlagsmithSettings, SwitchOffStrategy } from './config.js';

/** An answer from Flagsmith that was not a success. `retryable` is true for network errors, 5xx and 429. */
export class FlagsmithError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'FlagsmithError';
  }
}

/** One event for `POST /api/v1/events/`. The timestamp is epoch milliseconds. */
export interface FlagsmithEvent {
  event: string;
  identifier: string;
  timestamp: number;
  value?: string | number;
  feature_name?: string;
  metadata?: Record<string, unknown>;
}

export interface PostResult {
  accepted: number;
  rejected: number;
  /** The first reason Flagsmith gave for rejecting an event. */
  firstError?: string;
}

export interface IdentityCheck {
  checked: number;
  /** How many of them are served the stable value (or the flag switched off). */
  stable: number;
  notStable: string[];
}

export type RefreshOutcome = { limited: false } | { limited: true; retryAfterMs: number };

interface Reply {
  status: number;
  body: unknown;
  text: string;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const REQUEST_TIMEOUT_MS = 10000;

function networkReason(error: unknown): string {
  const cause = error instanceof Error ? (error as { cause?: { code?: string } }).cause : undefined;
  const code = cause?.code;
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the host name was not found';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'connection closed';
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'no answer in time';
  return code ?? (error instanceof Error ? error.message : 'unknown error');
}

/** Everything the guard asks of Flagsmith, so tests and the service share one place. */
export class FlagsmithApi {
  private metricNames: Map<number, string> | undefined;
  private latestExperimentId: number;

  constructor(
    readonly settings: FlagsmithSettings,
    /** The guarded flag and the variation key that is the stable version. */
    private readonly guarded: { flag: string; stable: string },
    private readonly redact: (text: string) => string,
    private readonly tracker: Tracker,
  ) {
    this.latestExperimentId = settings.experimentId;
    const given = Object.entries(settings.metrics);
    if (given.length > 0) this.metricNames = new Map(given.map(([name, id]) => [id, name]));
  }

  private env(path: string): string {
    return `/api/v1/environments/${encodeURIComponent(this.settings.environmentKey)}/${path}`;
  }

  private async request(
    method: string,
    path: string,
    options: { admin?: boolean; sdk?: boolean; body?: unknown } = {},
  ): Promise<Reply> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.admin) headers.Authorization = this.settings.adminAuth;
    if (options.sdk) headers['X-Environment-Key'] = this.settings.environmentKey;
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    let response: Response;
    let text: string;
    try {
      const done = (async () => {
        const res = await fetch(`${this.settings.apiRoot}${path}`, init);
        return { res, text: await res.text() };
      })();
      ({ res: response, text } = await this.tracker.track(done));
    } catch (error) {
      throw new FlagsmithError(this.redact(`Flagsmith did not answer: ${networkReason(error)}`), true);
    }
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body, text };
  }

  /** What Flagsmith said, in a few words and without the request address. */
  private failure(what: string, reply: Reply): FlagsmithError {
    const detail = isRecord(reply.body) && typeof reply.body.detail === 'string' ? `: ${reply.body.detail}` : '';
    return new FlagsmithError(this.redact(`${what} answered ${reply.status}${detail}`), reply.status >= 500 || reply.status === 429);
  }

  /**
   * Marks the guarded flag unhealthy in Flagsmith's Feature Health (beta), with a reason. The address holds a secret
   * token, so it is never part of an error message. Throws on any answer but 200.
   */
  async postFeatureHealth(reason: { textBlocks: { title: string; text: string }[] }): Promise<void> {
    const path = this.settings.featureHealthPath;
    if (!path) throw new FlagsmithError('Feature Health is not set up', false);
    const reply = await this.request('POST', path, {
      body: { feature: this.guarded.flag, status: 'unhealthy', reason: { text_blocks: reason.textBlocks, url_blocks: [] } },
    });
    if (reply.status !== 200) throw this.failure('Flagsmith Feature Health', reply);
  }

  /** The Flagsmith version, or undefined when it cannot be reached. */
  async version(): Promise<string | undefined> {
    try {
      const reply = await this.request('GET', '/version/');
      if (reply.status === 200 && isRecord(reply.body) && typeof reply.body.image_tag === 'string') return reply.body.image_tag;
    } catch {
      return undefined;
    }
    return undefined;
  }

  /** Sends events. Throws a retryable error on a network failure or 5xx; any other answer is counted. */
  async postEvents(events: readonly FlagsmithEvent[]): Promise<PostResult> {
    const reply = await this.request('POST', '/api/v1/events/', { sdk: true, body: { events } });
    if (reply.status >= 500) throw this.failure('Flagsmith events', reply);
    if (isRecord(reply.body) && (reply.status === 202 || reply.status === 400)) {
      const rejected = Array.isArray(reply.body.rejected) ? reply.body.rejected : [];
      const first = rejected.find(isRecord);
      const result: PostResult = { accepted: num(reply.body.accepted) ?? 0, rejected: rejected.length };
      if (first && typeof first.error === 'string') result.firstError = this.redact(first.error);
      return result;
    }
    const error = this.failure('Flagsmith events', reply);
    return { accepted: 0, rejected: events.length, firstError: error.message };
  }

  /** Every identity in `identifiers`, as the shop would evaluate it. */
  async checkIdentities(identifiers: readonly string[]): Promise<IdentityCheck> {
    const { flag, stable } = this.guarded;
    const check: IdentityCheck = { checked: identifiers.length, stable: 0, notStable: [] };
    const queue = [...identifiers];
    const worker = async (): Promise<void> => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const reply = await this.request('GET', `/api/v1/identities/?identifier=${encodeURIComponent(id)}`, { sdk: true });
        if (reply.status !== 200) throw this.failure('Flagsmith identity check', reply);
        const flags = isRecord(reply.body) && Array.isArray(reply.body.flags) ? reply.body.flags : [];
        const state = flags.find((item) => isRecord(item) && isRecord(item.feature) && item.feature.name === flag);
        const served = isRecord(state) ? state : undefined;
        const isStable = served !== undefined && (served.enabled === false || served.feature_state_value === stable);
        if (isStable) check.stable += 1;
        else check.notStable.push(id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, identifiers.length) }, worker));
    return check;
  }

  /**
   * The experiment to act on. The bootstrap file is read again each time, because a reset can create a new
   * experiment; an experiment id set in the environment is never overridden.
   */
  async experimentId(): Promise<number> {
    const { experimentId, experimentPinned, bootstrapFile } = this.settings;
    if (experimentPinned) return experimentId;
    try {
      const fresh = (JSON.parse(await readFile(bootstrapFile, 'utf8')) as Json).experimentId;
      if (typeof fresh === 'number') this.latestExperimentId = fresh;
    } catch {
      // the file is unreadable for a moment: keep the last id that was known
    }
    return this.latestExperimentId;
  }

  /**
   * Sets the experiment's rollout to 0%, so every identity is served the stable value while the experiment keeps
   * running. Flagsmith wants the whole rollout in the update, so the current one is read first and sent back with
   * only the percentage changed.
   */
  async setRolloutToZero(): Promise<void> {
    const path = this.env(`experiments/${await this.experimentId()}/`);
    const current = await this.request('GET', path, { admin: true });
    if (current.status !== 200) throw this.failure('Flagsmith experiment', current);
    const rollout = isRecord(current.body) && isRecord(current.body.experiment_rollout) ? current.body.experiment_rollout : undefined;
    if (!rollout || !isRecord(rollout.feature_state_value) || !Array.isArray(rollout.multivariate_feature_state_values)) {
      throw new FlagsmithError('Flagsmith did not return the experiment rollout', false);
    }
    const reply = await this.request('PATCH', `${path}rollout/`, {
      admin: true,
      body: {
        enabled: true,
        rollout_percentage: 0,
        feature_state_value: rollout.feature_state_value,
        multivariate_feature_state_values: rollout.multivariate_feature_state_values,
      },
    });
    if (reply.status !== 200) throw this.failure('Flagsmith rollout update', reply);
  }

  /** Asks Flagsmith to recompute the experiment's numbers. It allows one refresh per 300 seconds. */
  async refreshResults(): Promise<RefreshOutcome> {
    const experiment = await this.experimentId();
    const reply = await this.request('POST', this.env(`experiments/${experiment}/results/refresh/`), { admin: true });
    if (reply.status === 429) {
      const seconds = /(\d+)\s*seconds/.exec(isRecord(reply.body) && typeof reply.body.detail === 'string' ? reply.body.detail : '');
      return { limited: true, retryAfterMs: (seconds ? Number(seconds[1]) : 300) * 1000 };
    }
    if (reply.status !== 202 && reply.status !== 200) throw this.failure('Flagsmith results refresh', reply);
    return { limited: false };
  }

  /** Reads the experiment's results. `fresh` is false while Flagsmith has not yet finished the refresh. */
  async readResults(readAtMs: number): Promise<{ summary: FlagsmithExperimentSummary; fresh: boolean }> {
    const experiment = await this.experimentId();
    const reply = await this.request('GET', this.env(`experiments/${experiment}/results/`), { admin: true });
    if (reply.status !== 200) throw this.failure('Flagsmith results', reply);
    const results = isRecord(reply.body) && isRecord(reply.body.results) ? reply.body.results : undefined;
    const payload = results && isRecord(results.payload) ? results.payload : undefined;
    // Right after a refresh Flagsmith may not have written anything yet: that is "not fresh", not an error.
    if (!results || !payload) return { summary: { experimentId: experiment, readAtMs, variations: [] }, fresh: false };
    const asOf = typeof results.as_of === 'string' ? Date.parse(results.as_of) : NaN;
    const requested = typeof results.refresh_requested_at === 'string' ? Date.parse(results.refresh_requested_at) : NaN;
    const fresh = Number.isNaN(asOf) || Number.isNaN(requested) ? true : asOf >= requested;
    const names = await this.metricNameMap();
    return { summary: summariseResults(payload, experiment, readAtMs, this.guarded.stable, names), fresh };
  }

  private async metricNameMap(): Promise<Map<number, string>> {
    if (this.metricNames) return this.metricNames;
    const names = new Map<number, string>();
    const reply = await this.request('GET', this.env('experiment-metrics/'), { admin: true });
    const list = Array.isArray(reply.body) ? reply.body : isRecord(reply.body) && Array.isArray(reply.body.results) ? reply.body.results : [];
    for (const item of list) {
      if (isRecord(item) && typeof item.id === 'number' && typeof item.name === 'string') names.set(item.id, item.name);
    }
    this.metricNames = names;
    return names;
  }
}

/**
 * Maps Flagsmith's real results payload (not the OpenAPI schema) to the summary the record holds.
 * A metric's value is its sum divided by the identities exposed: for an occurrence metric that is the
 * share of identities that did it, for a mean metric it is the mean per identity.
 */
export function summariseResults(
  payload: Json,
  experimentId: number,
  readAtMs: number,
  stable: string,
  metricNames: ReadonlyMap<number, string>,
): FlagsmithExperimentSummary {
  /** The stable version is sent to Flagsmith as `control`; the summary names it as the guard does. */
  const named = (key: string): string => (key === 'control' ? stable : key);
  const exposures = new Map<string, number>();
  const series = isRecord(payload.exposures_timeseries) && Array.isArray(payload.exposures_timeseries.points) ? payload.exposures_timeseries.points : [];
  for (const point of series) {
    if (!isRecord(point) || !isRecord(point.new_identities)) continue;
    for (const [variation, count] of Object.entries(point.new_identities)) {
      exposures.set(named(variation), (exposures.get(named(variation)) ?? 0) + (num(count) ?? 0));
    }
  }
  const metrics = Array.isArray(payload.metrics) ? payload.metrics.filter(isRecord) : [];
  const byVariation = new Map<string, FlagsmithExperimentSummary['variations'][number]>();
  const entry = (variation: string) => {
    let found = byVariation.get(variation);
    if (!found) {
      found = { variation, exposures: exposures.get(variation) ?? 0, metrics: [] };
      byVariation.set(variation, found);
    }
    return found;
  };
  for (const variation of exposures.keys()) entry(variation);
  for (const metric of metrics) {
    const id = num(metric.metric_id);
    const name = id === undefined ? 'metric' : (metricNames.get(id) ?? `metric ${id}`);
    const variants = isRecord(metric.variants) ? metric.variants : {};
    const inference = isRecord(metric.inference) ? metric.inference : {};
    for (const [key, stats] of Object.entries(variants)) {
      const variation = named(key);
      if (!isRecord(stats)) continue;
      const n = num(stats.n) ?? 0;
      const sum = num(stats.sum) ?? 0;
      const row = entry(variation);
      if (!exposures.has(variation)) row.exposures = Math.max(row.exposures, n);
      const out: FlagsmithExperimentSummary['variations'][number]['metrics'][number] = {
        name,
        value: n === 0 ? 0 : Math.round((sum / n) * 10000) / 10000,
      };
      const infer = inference[key];
      if (isRecord(infer)) {
        const lift = num(infer.lift);
        const chance = num(infer.chance_to_win);
        const low = num(infer.ci_low);
        const high = num(infer.ci_high);
        if (lift !== undefined) out.lift = lift;
        if (chance !== undefined) out.chanceToWin = chance;
        if (low !== undefined && high !== undefined) out.interval = [low, high];
      }
      row.metrics.push(out);
    }
  }
  const variations = [...byVariation.values()].sort((a, b) => Number(b.variation === stable) - Number(a.variation === stable) || a.variation.localeCompare(b.variation));
  return { experimentId, readAtMs, variations };
}

const strategies: Record<SwitchOffStrategy, (api: FlagsmithApi) => Promise<string>> = {
  /** Setting the experiment's rollout to 0% is what makes every identity evaluate to the stable value. */
  async 'rollout-zero'(api) {
    await api.setRolloutToZero();
    return 'rollout set to 0%';
  },
};

/** Switches the guarded flag off, by the way `ALIBI_SWITCH_OFF` names. Returns what was done, in a few words. */
export function switchFlagOff(api: FlagsmithApi): Promise<string> {
  return strategies[api.settings.switchOff](api);
}
