import { defaultConfig } from '../src/guard.js';
import type { AttrValue, FailureClass, FlatSpan, GuardConfig, RunLine, TraceVerdict } from '../src/types.js';

export const FLAG = 'checkout_v2';
export const STABLE = 'stable';
export const V2 = 'v2';
export const START = 1_700_000_000_000;

export const config = (): GuardConfig => defaultConfig(FLAG, STABLE);

const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');

export type FaultAt = 'coupon' | 'shop-query' | 'price-query' | 'tax' | 'tax-call' | 'rules' | 'price';

export interface Fault {
  at: FaultAt;
  type: string;
  message: string;
}

export const faults = {
  coupon: { at: 'coupon', type: 'TypeError', message: "Cannot read properties of undefined (reading 'percent')" } as Fault,
  dbRefused: (at: 'shop-query' | 'price-query'): Fault => ({ at, type: 'ECONNREFUSED', message: 'connect ECONNREFUSED 172.18.0.5:5432' }),
  sqlSyntax: { at: 'price-query', type: '42601', message: 'syntax error at or near "FROM"' } as Fault,
  tax: { at: 'tax', type: 'Error', message: 'Tax table is not loaded' } as Fault,
  /** The shared tax service, called by both versions. */
  taxDown: { at: 'tax-call', type: 'ECONNREFUSED', message: 'connect ECONNREFUSED 172.18.0.7:3000' } as Fault,
  /** The rules service, called only by the new checkout. */
  rulesDown: { at: 'rules', type: 'ECONNREFUSED', message: 'connect ECONNREFUSED 172.18.0.8:3000' } as Fault,
  budget: { at: 'price', type: 'TimeoutError', message: 'price budget of 800 ms exceeded (timeout)' } as Fault,
};

export interface CheckoutOptions {
  n: number;
  startMs: number;
  variation: string;
  identity?: string;
  durationMs?: number;
  faults?: Fault[];
  /** Where the evaluation is written. Default is a span event. */
  evaluation?: 'event' | 'attributes' | 'none';
}

/**
 * A POST /checkout request the way OpenTelemetry JS emits it for Express and pg:
 * root server span, request handler, a shop query, and for the feature a flagged-path
 * span with its own coupon step and price query.
 */
export function checkoutTrace(o: CheckoutOptions): FlatSpan[] {
  const dur = o.durationMs ?? 90;
  const traceId = hex(o.n, 32);
  const id = (k: number) => hex(o.n * 16 + k, 16);
  const feature = o.variation !== STABLE;

  const make = (
    k: number,
    parent: number | undefined,
    name: string,
    kind: FlatSpan['kind'],
    offset: number,
    length: number,
    attrs: Record<string, AttrValue> = {},
  ): FlatSpan => ({
    traceId,
    spanId: id(k),
    ...(parent === undefined ? {} : { parentSpanId: id(parent) }),
    name,
    kind,
    service: 'shop',
    startMs: o.startMs + offset,
    endMs: o.startMs + offset + length,
    durationMs: length,
    attrs,
    events: [],
    error: false,
  });
  const pg = (statement: string): Record<string, AttrValue> => ({
    'db.system.name': 'postgresql',
    'db.namespace': 'shop',
    'db.query.text': statement,
    'server.address': 'shop-db',
    'server.port': 5432,
  });

  const root = make(1, undefined, 'POST /checkout', 'server', 0, dur, {
    'http.route': '/checkout',
    'http.request.method': 'POST',
    'http.response.status_code': 200,
  });
  const handler = make(2, 1, 'request handler - /checkout', 'internal', 1, dur - 2, { 'express.type': 'request_handler', 'http.route': '/checkout' });
  const tax = make(3, 2, 'tax.lookup', 'internal', 2, 2);
  const shopQuery = make(4, 2, 'pg.query:SELECT shop', 'client', 4, 6, pg('SELECT * FROM shops WHERE id = $1'));
  const http = (host: string): Record<string, AttrValue> => ({
    'http.request.method': 'GET',
    'server.address': host,
    'server.port': 3000,
    'url.full': `http://${host}:3000/${host}`,
  });
  const taxCall = make(8, 2, 'GET', 'client', 3, 3, http('tax'));
  const spans: Record<FaultAt, FlatSpan | undefined> = {
    tax,
    'tax-call': taxCall,
    rules: undefined,
    'shop-query': shopQuery,
    price: undefined,
    coupon: undefined,
    'price-query': undefined,
  };
  const all = [root, handler, tax, taxCall, shopQuery];
  const parents = new Map<string, string | undefined>([
    [handler.spanId, root.spanId],
    [tax.spanId, handler.spanId],
    [taxCall.spanId, handler.spanId],
    [shopQuery.spanId, handler.spanId],
  ]);

  if (feature) {
    const price = make(5, 2, 'checkout_v2.price', 'internal', 12, Math.max(dur / 2, 10), { 'alibi.flagged_path': FLAG });
    const coupon = make(6, 5, 'checkout_v2.apply_coupon', 'internal', 13, 3);
    const priceQuery = make(7, 5, 'pg.query:SELECT price', 'client', 17, 5, pg('SELECT price FROM prices WHERE sku = $1'));
    const rules = make(9, 5, 'GET', 'client', 18, 4, http('rules'));
    spans.rules = rules;
    all.push(rules);
    parents.set(rules.spanId, price.spanId);
    spans.price = price;
    spans.coupon = coupon;
    spans['price-query'] = priceQuery;
    all.push(price, coupon, priceQuery);
    parents.set(price.spanId, handler.spanId);
    parents.set(coupon.spanId, price.spanId);
    parents.set(priceQuery.spanId, price.spanId);
  }

  const byId = new Map(all.map((s) => [s.spanId, s]));
  for (const fault of o.faults ?? []) {
    const target = spans[fault.at];
    if (!target) throw new Error(`the ${o.variation} variation has no ${fault.at} span`);
    target.error = true;
    target.statusMessage = fault.message;
    target.events.push({
      name: 'exception',
      timeMs: target.startMs + 1,
      attrs: { 'exception.type': fault.type, 'exception.message': fault.message },
    });
    for (let up = parents.get(target.spanId); up; up = parents.get(up)) {
      const ancestor = byId.get(up) as FlatSpan;
      ancestor.error = true;
      if (ancestor !== root) ancestor.statusMessage = fault.message;
    }
  }
  if ((o.faults ?? []).length > 0) {
    root.attrs['http.response.status_code'] = 500;
    root.attrs['error.type'] = '500';
  }

  const mode = o.evaluation ?? 'event';
  const evaluation = {
    'feature_flag.key': FLAG,
    'feature_flag.result.variant': o.variation,
    'feature_flag.context.id': o.identity ?? `user-${o.n}`,
  };
  if (mode === 'event') handler.events.push({ name: 'feature_flag.evaluation', timeMs: handler.startMs, attrs: evaluation });
  if (mode === 'attributes') Object.assign(handler.attrs, evaluation);
  return all;
}

export interface VerdictOptions {
  endMs: number;
  variation?: string;
  failed?: boolean;
  failureClass?: FailureClass;
  durationMs?: number;
  route?: string;
  noEvaluation?: boolean;
}

/** A verdict built directly, for rule tests that do not need span trees. */
export function makeVerdict(o: VerdictOptions): TraceVerdict {
  const variation = o.variation ?? V2;
  const failed = o.failed ?? false;
  const flagOn = !o.noEvaluation && variation !== STABLE;
  const durationMs = o.durationMs ?? 90;
  const failureClass = failed ? (o.failureClass ?? 'flagged-path') : undefined;
  return {
    traceId: hex(Math.round(o.endMs) % 0xffffffff, 8).padStart(32, '0'),
    route: o.route ?? '/checkout',
    startMs: o.endMs - durationMs,
    endMs: o.endMs,
    durationMs,
    ...(o.noEvaluation ? {} : { evaluation: { flag: FLAG, variation, identity: 'user' } }),
    flagOn,
    failed,
    ...(failureClass ? { failureClass } : {}),
    origins: [],
    counted: failed && flagOn && failureClass === 'flagged-path',
    reason: failed ? 'Failed.' : 'Completed.',
  };
}

export type RunName = 'outage' | 'feature-bug' | 'degraded-host' | 'slow-host';

/**
 * A synthetic run: four requests a second, half with the flag on, from a shop with an answer key.
 * Planted trouble starts 60 seconds in. When the sixteenth counted failure ends, the recorded
 * Flagsmith answer arrives four seconds later and everyone is on the stable version after that.
 */
export function buildRun(name: RunName): RunLine[] {
  const totalSeconds = name === 'outage' ? 240 : 480;
  const trouble = name === 'slow-host' ? 45 : 60;
  const lines: RunLine[] = [];
  let switchOffMs: number | undefined;
  let flagOnSeen = 0;
  let counted = 0;

  for (let n = 0; n < totalSeconds * 4; n += 1) {
    const startMs = START + n * 250;
    const second = n / 4;
    const baseVariation = n % 2 === 0 ? V2 : STABLE;
    const variation = switchOffMs !== undefined && startMs >= switchOffMs ? STABLE : baseVariation;
    const calm = 80 + (n % 7) * 5;
    let durationMs = calm;
    const planted: Fault[] = [];

    if (name === 'outage' && second >= trouble && second < trouble + 90) {
      planted.push(faults.dbRefused('shop-query'));
      durationMs = 20;
    }
    if (name === 'feature-bug' && second >= trouble && variation === V2) {
      if (flagOnSeen % 3 === 0) planted.push(faults.coupon);
      flagOnSeen += 1;
    }
    if ((name === 'degraded-host' || name === 'slow-host') && second >= trouble) {
      durationMs = 400 + (n % 7) * 5;
      if (variation === V2) {
        if (flagOnSeen % 2 === 0) planted.push(faults.budget);
        flagOnSeen += 1;
      } else if (name === 'degraded-host' ? n % 7 === 0 : n % 60 === 1) {
        planted.push(faults.tax);
      }
    }

    const spans = checkoutTrace({ n, startMs, variation, durationMs, faults: planted });
    if (variation === V2 && planted.some((f) => f.at === 'coupon' || f.at === 'price')) {
      counted += 1;
      if (counted === 16 && switchOffMs === undefined) switchOffMs = startMs + durationMs + 4000;
    }
    lines.push({ kind: 'spans', atMs: startMs + durationMs + 20, spans });
  }

  if (name !== 'outage') {
    lines.push({
      kind: 'flagsmith',
      atMs: switchOffMs as number,
      what: 'switch-off',
      ok: true,
      detail: `feature ${FLAG} disabled for everyone`,
    });
  }
  lines.push({ kind: 'world', atMs: START + trouble * 1000, text: WORLD[name] });
  const header: RunLine = {
    kind: 'alibi-run',
    version: 1,
    name,
    title: TITLES[name],
    planted: PLANTED[name],
    config: config(),
    startedAtMs: START,
    source: 'synthetic, generated by the tests',
  };
  return [header, ...lines];
}

const TITLES: Record<RunName, string> = {
  outage: 'The database outage',
  'feature-bug': 'The coupon bug',
  'degraded-host': 'The degraded host',
  'slow-host': 'The slow host',
};
const PLANTED: Record<RunName, string> = {
  outage: 'The shop database refuses connections for 90 seconds.',
  'feature-bug': 'Carts with a coupon crash inside the new checkout.',
  'degraded-host': 'The host slows down and the new checkout runs out of its price budget.',
  'slow-host': 'The host slows down for everyone after 45 seconds; the new checkout runs out of its price budget first.',
};
const WORLD: Record<RunName, string> = {
  outage: 'The shop database was stopped.',
  'feature-bug': 'The coupon bug started.',
  'degraded-host': 'The host started to slow down.',
  'slow-host': 'The host started to slow down.',
};
