import type {
  AttrValue,
  FailureClass,
  FlagEvaluation,
  FlatSpan,
  GuardConfig,
  OriginSpan,
  TraceVerdict,
} from './types.js';
import { formatMs } from './stats.js';
import { dependencyTarget } from './target.js';

/** The attribute the application puts on the span that wraps the feature's own code. */
export const FLAGGED_PATH_ATTRIBUTE = 'alibi.flagged_path';
const EVALUATION_EVENT = 'feature_flag.evaluation';
const MAX_MESSAGE = 140;

const SYSTEM_KEYS = ['db.system', 'db.system.name', 'rpc.system', 'messaging.system'];

/** Words that say the dependency could not be reached or did not answer in time. */
const UNAVAILABLE_TEXT =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|Connection terminated|connection refused|connection reset|could not connect|unable to connect|socket hang up|server closed the connection|the database system is (?:shutting down|starting up)|too many connections|remaining connection slots|timeout|timed out/i;

/** Words that say the dependency answered and refused what it was sent. */
const REJECTED_TEXT =
  /syntax error|violates (?:unique|foreign key|not-null|check) constraint|duplicate key value|invalid input syntax|(?:relation|column) ".*" does not exist/i;

type Outcome = 'unavailable' | 'rejected' | 'unknown';

interface OriginInfo {
  origin: OriginSpan;
  message: string;
  dependency?: { descriptor: string; outcome: Outcome };
}

function text(value: AttrValue | undefined): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function httpStatus(span: FlatSpan): number | undefined {
  const raw = span.attrs['http.response.status_code'] ?? span.attrs['http.status_code'];
  const status = typeof raw === 'string' ? Number(raw) : raw;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string): string {
  return value.length > MAX_MESSAGE ? `${value.slice(0, MAX_MESSAGE).trimEnd()}...` : value;
}

/** Ends a sentence once; a truncated message already ends in dots. */
function sentence(value: string): string {
  return value.endsWith('.') ? value : `${value}.`;
}

/**
 * The origin span's own words for what went wrong, never a guess. The pg instrumentation records
 * only a generic exception message with no type, so without an exception type the status message,
 * which carries the driver's real text, comes first.
 */
function originMessage(span: FlatSpan): string {
  const exception = [...span.events].reverse().find((event) => event.name === 'exception');
  const type = text(exception?.attrs['exception.type']);
  const message = text(exception?.attrs['exception.message']);
  const errorType = text(span.attrs['error.type']);
  const status = httpStatus(span);
  let found: string | undefined;
  if (message && type) {
    found = message.toLowerCase().includes(type.toLowerCase()) ? message : `${type}: ${message}`;
  } else {
    found =
      span.statusMessage ??
      message ??
      type ??
      // HTTP servers set error.type to the status code, which says less than the status itself.
      (errorType && !/^\d{3}$/.test(errorType) ? errorType : undefined) ??
      (status === undefined ? undefined : `HTTP status ${status}`);
  }
  return truncate(oneLine(found ?? 'no message recorded'));
}

/** When the span threw: its first exception event, else when it ended. */
function failedAtMs(span: FlatSpan): number {
  const times = span.events.filter((event) => event.name === 'exception').map((event) => event.timeMs);
  return times.length > 0 ? Math.min(...times) : span.endMs;
}

function isDependencyCall(span: FlatSpan): boolean {
  if (span.kind === 'client' || span.kind === 'producer' || span.kind === 'consumer') return true;
  return SYSTEM_KEYS.some((key) => span.attrs[key] !== undefined);
}

function dependencyDescriptor(span: FlatSpan): string {
  for (const key of SYSTEM_KEYS) {
    const value = text(span.attrs[key]);
    if (value) return `${key}=${value}`;
  }
  const host = text(span.attrs['server.address']) ?? text(span.attrs['net.peer.name']);
  return host ? `server.address=${host}` : `span.kind=${span.kind}`;
}

function dependencyOutcome(span: FlatSpan): Outcome {
  const exceptions = span.events.filter((event) => event.name === 'exception');
  const codes = [
    text(span.attrs['db.response.status_code']),
    text(span.attrs['error.type']),
    ...exceptions.map((event) => text(event.attrs['exception.type'])),
  ];
  for (const code of codes) {
    if (code === undefined) continue;
    // SQLSTATE: the first two characters are the class.
    if (/^[0-9A-Z]{5}$/.test(code)) {
      const sqlClass = code.slice(0, 2);
      if (sqlClass === '08' || sqlClass === '53' || sqlClass === '57') return 'unavailable';
      if (sqlClass === '22' || sqlClass === '23' || sqlClass === '42') return 'rejected';
    }
  }
  const numericType = codes.find((code) => code !== undefined && /^\d{3}$/.test(code));
  const status = httpStatus(span) ?? (numericType === undefined ? undefined : Number(numericType));
  if (status !== undefined && status >= 500) return 'unavailable';
  if (status !== undefined && status >= 400) return 'rejected';
  const words = [
    span.statusMessage,
    ...codes,
    ...exceptions.map((event) => text(event.attrs['exception.message'])),
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');
  if (UNAVAILABLE_TEXT.test(words)) return 'unavailable';
  if (REJECTED_TEXT.test(words)) return 'rejected';
  return 'unknown';
}

function readEvaluation(spans: readonly FlatSpan[], flag: string): FlagEvaluation | undefined {
  const ordered = [...spans].sort((a, b) => a.startMs - b.startMs || (a.spanId < b.spanId ? -1 : 1));
  const read = (attrs: Record<string, AttrValue>): FlagEvaluation | undefined => {
    if (text(attrs['feature_flag.key']) !== flag) return undefined;
    const variation = text(attrs['feature_flag.result.variant']) ?? text(attrs['feature_flag.variant']);
    if (variation === undefined) return undefined;
    return { flag, variation, identity: text(attrs['feature_flag.context.id']) ?? '' };
  };
  for (const span of ordered) {
    for (const event of span.events) {
      if (event.name !== EVALUATION_EVENT) continue;
      const found = read(event.attrs);
      if (found) return found;
    }
    const found = read(span.attrs);
    if (found) return found;
  }
  return undefined;
}

function findRoot(spans: readonly FlatSpan[], byId: ReadonlyMap<string, FlatSpan>): FlatSpan | undefined {
  const candidates = spans
    .filter((span) => span.kind === 'server' && (span.parentSpanId === undefined || !byId.has(span.parentSpanId)))
    .sort(
      (a, b) =>
        Number(a.parentSpanId !== undefined) - Number(b.parentSpanId !== undefined) ||
        a.startMs - b.startMs ||
        (a.spanId < b.spanId ? -1 : 1),
    );
  return candidates[0];
}

function clause(info: OriginInfo): string {
  const { origin, message, dependency } = info;
  if (dependency) {
    const call = `${origin.label ?? origin.name}, a dependency call (${dependency.descriptor})`;
    if (origin.class === 'flagged-path') return `${call} on the flagged path: ${message}`;
    if (origin.class === 'server') return `${call} outside the flagged path: ${message}`;
    return `${call}: ${message}`;
  }
  if (origin.class === 'flagged-path') return `${origin.name}, a span on the flagged path: ${message}`;
  return `${origin.name} outside the flagged path: ${message}`;
}

function consequence(info: OriginInfo, counted: boolean, evaluated: boolean): string {
  const { origin, dependency } = info;
  if (origin.class === 'flagged-path') {
    const rejected = dependency ? 'The dependency rejected the call, so the fault is in the calling code. ' : '';
    if (counted) return `${rejected}Counts toward the switch-off.`;
    return `${rejected}${
      evaluated
        ? 'The flag was off for this request, so this does not count.'
        : 'The request did not evaluate the flag, so this does not count.'
    }`;
  }
  if (origin.class === 'dependency') {
    if (dependency?.outcome === 'unavailable') {
      const base = 'The dependency was unavailable, so this does not count.';
      return origin.onFlaggedPath
        ? `${base} It was called from the flagged path, but an unavailable dependency is infrastructure.`
        : base;
    }
    return 'The dependency call failed and nothing in the span says the dependency rejected it, so this does not count.';
  }
  if (dependency) {
    return 'The dependency rejected the call, so the fault is in the calling code outside the flagged path. Does not count.';
  }
  return 'Does not count.';
}

function explain(
  infos: readonly OriginInfo[],
  klass: FailureClass,
  counted: boolean,
  evaluated: boolean,
): string {
  const first = infos[0] as OriginInfo;
  if (klass !== 'mixed') {
    const more = infos.length - 1;
    const extra = more > 0 ? ` (${more} more failing span${more > 1 ? 's' : ''} in the same category)` : '';
    return `Failed in ${sentence(`${clause(first)}${extra}`)} ${consequence(first, counted, evaluated)}`;
  }
  const second = infos.find((info) => info.origin.class !== first.origin.class) as OriginInfo;
  const more = infos.length - 2;
  const extra = more > 0 ? `, and in ${more} more` : '';
  return `Failed in ${clause(first)}, and in ${clause(second)}${extra}. The failures are in different places, so this does not count.`;
}

/**
 * Reads one finished request. Returns undefined when the trace has no root server span,
 * because without it the route and the outcome of the request are unknown.
 */
export function judgeTrace(spans: readonly FlatSpan[], config: GuardConfig): TraceVerdict | undefined {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const root = findRoot(spans, byId);
  if (!root) return undefined;

  const parentOf = (span: FlatSpan): FlatSpan | undefined =>
    span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId);

  const evaluation = readEvaluation(spans, config.flag);
  const flagOn = evaluation !== undefined && evaluation.variation !== config.stableVariation;

  const status = httpStatus(root);
  const failed = root.error || (status !== undefined && status >= 500);

  const onFlaggedPath = (span: FlatSpan): boolean => {
    const seen = new Set<string>();
    for (let current: FlatSpan | undefined = span; current && current !== root && !seen.has(current.spanId); current = parentOf(current)) {
      seen.add(current.spanId);
      if (text(current.attrs[FLAGGED_PATH_ATTRIBUTE]) === config.flag) return true;
    }
    return false;
  };

  const hasErrorBelow = new Set<string>();
  for (const span of spans) {
    if (!span.error) continue;
    const seen = new Set<string>([span.spanId]);
    for (let up = parentOf(span); up && !seen.has(up.spanId); up = parentOf(up)) {
      seen.add(up.spanId);
      hasErrorBelow.add(up.spanId);
    }
  }

  const points = spans.map((span) => ({
    name: span.name,
    durationMs: span.durationMs,
    error: span.error,
    ...(isDependencyCall(span) ? { dependency: true, ...dependencyTarget(span) } : {}),
  }));
  const base = {
    traceId: root.traceId,
    route: text(root.attrs['http.route']) ?? root.name,
    startMs: root.startMs,
    endMs: root.endMs,
    durationMs: root.durationMs,
    ...(evaluation ? { evaluation } : {}),
    flagOn,
    points,
  };

  if (!failed) {
    return { ...base, failed: false, origins: [], counted: false, reason: `Completed in ${formatMs(root.durationMs)}.` };
  }

  let originSpans = spans.filter((span) => span.error && !hasErrorBelow.has(span.spanId));
  if (originSpans.length === 0) originSpans = [root];
  // The first failure leads the explanation: a timeout fires before the work it interrupted gives up.
  originSpans.sort((a, b) => failedAtMs(a) - failedAtMs(b) || (a.spanId < b.spanId ? -1 : 1));

  const infos: OriginInfo[] = originSpans.map((span) => {
    const onPath = onFlaggedPath(span);
    const message = originMessage(span);
    let klass: OriginSpan['class'];
    let dependency: OriginInfo['dependency'];
    if (isDependencyCall(span)) {
      dependency = { descriptor: dependencyDescriptor(span), outcome: dependencyOutcome(span) };
      klass = dependency.outcome === 'rejected' ? (onPath ? 'flagged-path' : 'server') : 'dependency';
    } else {
      klass = onPath ? 'flagged-path' : 'server';
    }
    const origin: OriginSpan = {
      spanId: span.spanId,
      name: span.name,
      kind: span.kind,
      service: span.service,
      class: klass,
      onFlaggedPath: onPath,
      ...(dependency ? dependencyTarget(span) : undefined),
      detail: dependency ? `${dependency.descriptor} ${message}` : message,
      durationMs: span.durationMs,
    };
    return dependency ? { origin, message, dependency } : { origin, message };
  });

  const classes = new Set(infos.map((info) => info.origin.class));
  const failureClass: FailureClass = classes.size === 1 ? (infos[0] as OriginInfo).origin.class : 'mixed';
  const counted = flagOn && failureClass === 'flagged-path';

  return {
    ...base,
    failed: true,
    failureClass,
    origins: infos.map((info) => info.origin),
    counted,
    reason: explain(infos, failureClass, counted, evaluation !== undefined),
  };
}
