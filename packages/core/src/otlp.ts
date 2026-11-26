import type { AttrValue, FlatSpan, SpanKind } from './types.js';

/** Thrown when a body is not an OTLP/HTTP JSON trace export; the message says what was wrong. */
export class OtlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtlpError';
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const KINDS: Record<string, SpanKind> = {
  '1': 'internal',
  '2': 'server',
  '3': 'client',
  '4': 'producer',
  '5': 'consumer',
  SPAN_KIND_INTERNAL: 'internal',
  SPAN_KIND_SERVER: 'server',
  SPAN_KIND_CLIENT: 'client',
  SPAN_KIND_PRODUCER: 'producer',
  SPAN_KIND_CONSUMER: 'consumer',
};

function readAnyValue(value: Json): AttrValue | undefined {
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.boolValue === 'boolean') return value.boolValue;
  if (typeof value.doubleValue === 'number') return value.doubleValue;
  const int = value.intValue;
  if (typeof int === 'number') return int;
  // 64-bit integers travel as strings in OTLP JSON.
  if (typeof int === 'string' && /^-?\d+$/.test(int)) return Number(int);
  return undefined;
}

function readAttributes(list: unknown): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!isRecord(item) || typeof item.key !== 'string' || !isRecord(item.value)) continue;
    const value = readAnyValue(item.value);
    if (value !== undefined) out[item.key] = value;
  }
  return out;
}

function nanoToMs(value: unknown, what: string): number {
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(BigInt(value) / 1000n) / 1000;
  if (typeof value === 'number' && Number.isFinite(value)) return value / 1e6;
  throw new OtlpError(`${what} is not a nanosecond timestamp`);
}

function readSpan(raw: Json, service: string): FlatSpan {
  if (typeof raw.traceId !== 'string' || typeof raw.spanId !== 'string') {
    throw new OtlpError('a span has no traceId or spanId');
  }
  const name = typeof raw.name === 'string' ? raw.name : '';
  const startMs = nanoToMs(raw.startTimeUnixNano, `startTimeUnixNano of span ${raw.spanId}`);
  const endMs = nanoToMs(raw.endTimeUnixNano, `endTimeUnixNano of span ${raw.spanId}`);
  const status = isRecord(raw.status) ? raw.status : {};
  const events = Array.isArray(raw.events) ? raw.events : [];
  const span: FlatSpan = {
    traceId: raw.traceId,
    spanId: raw.spanId,
    name,
    kind: KINDS[String(raw.kind)] ?? 'internal',
    service,
    startMs,
    endMs,
    durationMs: Math.round((endMs - startMs) * 1000) / 1000,
    attrs: readAttributes(raw.attributes),
    events: events.filter(isRecord).map((event) => ({
      name: typeof event.name === 'string' ? event.name : '',
      timeMs: event.timeUnixNano === undefined ? startMs : nanoToMs(event.timeUnixNano, 'an event time'),
      attrs: readAttributes(event.attributes),
    })),
    error: status.code === 2 || status.code === 'STATUS_CODE_ERROR',
  };
  if (typeof raw.parentSpanId === 'string' && raw.parentSpanId !== '') span.parentSpanId = raw.parentSpanId;
  if (typeof status.message === 'string' && status.message !== '') span.statusMessage = status.message;
  return span;
}

/** Flattens an OTLP/HTTP JSON ExportTraceServiceRequest into one list of spans. */
export function flattenOtlp(body: unknown): FlatSpan[] {
  if (!isRecord(body)) throw new OtlpError('the body is not a JSON object');
  if (body.resourceSpans === undefined) return [];
  if (!Array.isArray(body.resourceSpans)) throw new OtlpError('resourceSpans is not a list');
  const spans: FlatSpan[] = [];
  for (const resourceSpans of body.resourceSpans) {
    if (!isRecord(resourceSpans)) throw new OtlpError('a resourceSpans entry is not an object');
    const resource = isRecord(resourceSpans.resource) ? resourceSpans.resource : {};
    const service = readAttributes(resource.attributes)['service.name'];
    const scopes = Array.isArray(resourceSpans.scopeSpans) ? resourceSpans.scopeSpans : [];
    for (const scope of scopes) {
      if (!isRecord(scope) || !Array.isArray(scope.spans)) continue;
      for (const raw of scope.spans) {
        if (!isRecord(raw)) throw new OtlpError('a span is not an object');
        spans.push(readSpan(raw, typeof service === 'string' ? service : 'unknown'));
      }
    }
  }
  return spans;
}
