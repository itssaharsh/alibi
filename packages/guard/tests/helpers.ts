import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttrValue, FlatSpan } from '@alibi/core';
import type { Cancel, Clock } from '../src/clock.js';
import { loadConfig, type ServiceConfig } from '../src/config.js';
import { createGuardServer } from '../src/http.js';
import { createLogger, makeRedactor, type Logger } from '../src/log.js';
import { AlibiService } from '../src/service.js';

export const ENV_KEY = 'ENVKEY-abc123456';
export const ADMIN_KEY = 'ADMINKEY-secret-xyz789';
export const CONTROL_TOKEN = 'CONTROL-token-qwe456';
export const SERVER_KEY = 'ser.SERVERKEY-777888';
export const SECRETS = [ENV_KEY, ADMIN_KEY, CONTROL_TOKEN, SERVER_KEY];

/** A clock the test moves by hand. Timers run in order as time passes, and the service gets a chance to settle after each. */
export class ManualClock implements Clock {
  private t: number;
  private seq = 0;
  private timers: { id: number; at: number; every?: number; run: () => void }[] = [];
  settle: () => Promise<void> = () => Promise.resolve();

  constructor(start: number) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  after(ms: number, run: () => void): Cancel {
    return this.add(ms, undefined, run);
  }

  every(ms: number, run: () => void): Cancel {
    return this.add(ms, ms, run);
  }

  private add(ms: number, every: number | undefined, run: () => void): Cancel {
    const timer = { id: this.seq++, at: this.t + ms, run, ...(every === undefined ? {} : { every }) };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((other) => other !== timer);
    };
  }

  async advanceTo(ms: number): Promise<void> {
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= ms).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.t = Math.max(this.t, due.at);
      if (due.every === undefined) this.timers = this.timers.filter((timer) => timer !== due);
      else due.at += due.every;
      due.run();
      await this.settle();
    }
    this.t = Math.max(this.t, ms);
    await this.settle();
  }

  advanceBy(ms: number): Promise<void> {
    return this.advanceTo(this.t + ms);
  }
}

interface Reply {
  status: number;
  body?: unknown;
}

/** A small stand-in for self-hosted Flagsmith, with the answers the probe saw. */
export class FakeFlagsmith {
  server: Server;
  url = '';
  /** True once the experiment's rollout has been set to 0%. */
  rolloutZero = false;
  /** Close every connection without answering. */
  down = false;
  /** Statuses to answer the next event posts with, one each, before accepting. */
  eventFailures: number[] = [];
  /** How many rollout updates to refuse with 503 before accepting. */
  patchFailures = 0;
  /** Keep serving the new version after the rollout update, as if the update did not take hold. */
  patchHasNoEffect = false;
  /** Answer the next refreshes with 429, one entry (seconds to wait) per refresh. */
  limits: number[] = [];
  /** Answer rollout updates with 403 and a message that repeats the admin key. */
  leakKey = false;
  readonly events: Record<string, unknown>[] = [];
  readonly eventBodies: unknown[] = [];
  readonly requests: string[] = [];
  readonly headers: IncomingMessage['headers'][] = [];
  refreshes = 0;
  patches = 0;
  /** Answer this many result reads with nothing yet, as Flagsmith does just after a refresh. */
  resultsMissing = 0;
  readonly rollouts: Record<string, unknown>[] = [];
  /** Variation shares in the results the fake returns. */
  exposed = { stable: 300, v2: 310 };

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (this.down) {
          req.socket.destroy();
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8');
        const reply = this.handle(req, text === '' ? undefined : (JSON.parse(text) as unknown));
        const body = reply.body === undefined ? '' : JSON.stringify(reply.body);
        res.writeHead(reply.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  count(prefix: string): number {
    return this.requests.filter((line) => line.startsWith(prefix)).length;
  }

  private handle(req: IncomingMessage, body: unknown): Reply {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    this.requests.push(`${method} ${path}`);
    this.headers.push(req.headers);
    const admin = req.headers.authorization === `Api-Key ${ADMIN_KEY}`;
    const sdk = req.headers['x-environment-key'] === ENV_KEY;
    const env = `/api/v1/environments/${ENV_KEY}`;

    if (path === '/version/') return { status: 200, body: { image_tag: '2.295.2', experimentation_enabled: true } };
    if (path === '/api/v1/events/' && method === 'POST') {
      if (!sdk) return { status: 403, body: { detail: 'Invalid or missing Environment key' } };
      const failure = this.eventFailures.shift();
      if (failure !== undefined) return { status: failure, body: { detail: 'try later' } };
      const list = ((body as { events?: Record<string, unknown>[] }).events ?? []) as Record<string, unknown>[];
      this.eventBodies.push(body);
      const rejected: { index: number; error: string }[] = [];
      list.forEach((event, index) => {
        if (typeof event.timestamp !== 'number' || event.timestamp < 1577836800000) {
          rejected.push({ index, error: 'timestamp: Timestamp must be after 2020-01-01.' });
        } else this.events.push(event);
      });
      return { status: rejected.length === list.length && list.length > 0 ? 400 : 202, body: { accepted: list.length - rejected.length, rejected } };
    }
    if (path === '/api/v1/identities/' && method === 'GET') {
      if (!sdk) return { status: 403, body: { detail: 'Invalid or missing Environment key' } };
      const id = url.searchParams.get('identifier') ?? '';
      const hash = [...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
      const value = !this.rolloutZero || this.patchHasNoEffect ? (hash % 2 === 0 ? 'v2' : 'stable') : 'stable';
      return { status: 200, body: { identifier: id, flags: [{ feature: { id: 3, name: 'checkout_v2' }, enabled: true, feature_state_value: value }] } };
    }
    if (!admin) return { status: 403, body: { detail: 'Authentication credentials were not provided.' } };
    if (path === `${env}/experiments/1/` && method === 'GET') {
      return {
        status: 200,
        body: {
          id: 1,
          status: 'running',
          experiment_rollout: {
            enabled: true,
            rollout_percentage: this.rolloutZero ? 0 : 100,
            feature_state_value: { type: 'string', value: 'stable' },
            multivariate_feature_state_values: [{ multivariate_feature_option: 1, percentage_allocation: 50 }],
            audience: { match: 'any', segments: [] },
          },
        },
      };
    }
    if (path === `${env}/experiments/1/rollout/` && method === 'PATCH') {
      if (this.leakKey) return { status: 403, body: { detail: `Invalid key ${ADMIN_KEY} for ${ENV_KEY}` } };
      if (this.patchFailures > 0) {
        this.patchFailures -= 1;
        return { status: 503, body: { detail: 'unavailable' } };
      }
      const sent = body as Record<string, unknown>;
      if (!sent.feature_state_value || !sent.multivariate_feature_state_values || sent.enabled !== true) return { status: 400, body: { detail: 'partial body' } };
      this.patches += 1;
      this.rolloutZero = sent.rollout_percentage === 0;
      this.rollouts.push(sent);
      return { status: 200, body: sent };
    }
    if (path === `${env}/experiments/1/results/refresh/` && method === 'POST') {
      const seconds = this.limits.shift();
      if (seconds !== undefined) {
        this.refreshes += 1;
        return { status: 429, body: { detail: `A refresh was requested recently. Try again later. Expected available in ${seconds} seconds.` } };
      }
      this.refreshes += 1;
      return { status: 202 };
    }
    if (path === `${env}/experiment-metrics/` && method === 'GET') {
      return { status: 200, body: [{ id: 11, name: 'checkout_completed' }, { id: 13, name: 'checkout_latency_ms' }] };
    }
    if (path === `${env}/experiments/1/results/` && method === 'GET') {
      if (this.resultsMissing > 0) {
        this.resultsMissing -= 1;
        return { status: 200, body: { results: null } };
      }
      return { status: 200, body: this.results() };
    }
    return { status: 404, body: { detail: 'not found' } };
  }

  private results(): unknown {
    const { stable, v2 } = this.exposed;
    return {
      results: {
        as_of: '2026-11-26T23:14:55.359228Z',
        last_error_at: null,
        refresh_requested_at: '2026-11-26T23:14:55.210720Z',
        payload: {
          metrics: [
            {
              metric_id: 11,
              variants: { control: { n: stable, sum: 200, sum_squares: 200 }, v2: { n: v2, sum: 250, sum_squares: 250 } },
              inference: { v2: { lift: 0.25, ci_low: 0.05, ci_high: 0.45, chance_to_win: 0.97 } },
            },
            {
              metric_id: 13,
              variants: { control: { n: stable, sum: 30000, sum_squares: 1 }, v2: { n: v2, sum: 31000, sum_squares: 1 } },
              inference: { v2: { lift: 0.04, ci_low: -0.1, ci_high: 0.18, chance_to_win: 0.3 } },
            },
          ],
          srm_p_value: null,
          exposures_timeseries: { points: [{ bucket: '2026-11-26T23:00:00+00:00', new_identities: { control: stable, v2 } }], granularity: 'hour' },
        },
        is_final: false,
      },
    };
  }
}

export interface Harness {
  config: ServiceConfig;
  service: AlibiService;
  clock: ManualClock;
  logs: string[];
  dir: string;
  log: Logger;
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'alibi-guard-'));
}

export function envFor(fake: FakeFlagsmith, dir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    FLAGSMITH_API_URL: `${fake.url}/api/v1/`,
    FLAGSMITH_ENVIRONMENT_KEY: ENV_KEY,
    FLAGSMITH_ADMIN_KEY: ADMIN_KEY,
    FLAGSMITH_EXPERIMENT_ID: '1',
    ALIBI_FLAGSMITH_FILE: join(dir, 'no-such-file.json'),
    ALIBI_DATA: join(dir, 'data'),
    ...extra,
  };
}

export function harness(fake: FakeFlagsmith, start: number, extra: Record<string, string> = {}, dir = tempDir()): Harness {
  const config = loadConfig(envFor(fake, dir, extra));
  const logs: string[] = [];
  const redact = makeRedactor(config.secrets);
  const log = createLogger(redact, (line) => logs.push(line));
  const clock = new ManualClock(start);
  const service = new AlibiService({ config, clock, log, redact });
  clock.settle = () => service.idle();
  return { config, service, clock, logs, dir, log };
}

export async function listen(h: Harness): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createGuardServer(h.service, h.config, h.log);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Every file under a directory, as text, for searching. */
export function filesUnder(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push({ path, text: readFileSync(path, 'utf8') });
  }
  return out;
}

function value(v: AttrValue): Record<string, unknown> {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
}

const attrs = (record: Record<string, AttrValue>) => Object.entries(record).map(([key, v]) => ({ key, value: value(v) }));
const nano = (ms: number): string => String(BigInt(Math.round(ms * 1000)) * 1000n);
const KIND = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 } as const;

/** What the collector's otlphttp exporter sends with `encoding: json`. */
export function toOtlp(spans: readonly FlatSpan[]): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: attrs({ 'service.name': 'shop' }) },
        scopeSpans: [
          {
            scope: { name: 'test' },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: KIND[span.kind],
              startTimeUnixNano: nano(span.startMs),
              endTimeUnixNano: nano(span.endMs),
              attributes: attrs(span.attrs),
              events: span.events.map((event) => ({ name: event.name, timeUnixNano: nano(event.timeMs), attributes: attrs(event.attrs) })),
              status: span.error ? { code: 2, ...(span.statusMessage ? { message: span.statusMessage } : {}) } : { code: 0 },
            })),
          },
        ],
      },
    ],
  };
}
