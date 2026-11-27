import type { AttrValue, FlatSpan } from '@alibi/core';

/** Attribute names the engine and the page read; everything else is left out of recordings. */
const KEEP_PREFIXES = ['http.', 'url.', 'db.', 'error.', 'exception.', 'feature_flag.', 'alibi.', 'server.', 'net.', 'rpc.', 'messaging.'];
const KEEP_EVENTS = new Set(['feature_flag.evaluation', 'exception']);
const MAX_TEXT = 256;

function keepAttribute(key: string): boolean {
  return key === 'service.name' || KEEP_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function shorten(value: AttrValue): AttrValue {
  return typeof value === 'string' && value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}...` : value;
}

/**
 * The span as a recording keeps it. It is decided span by span, never by how the trace turned out,
 * because a batch arrives before anyone knows whether its trace failed. No span is dropped.
 */
export function slimSpan(span: FlatSpan): FlatSpan {
  const attrs: Record<string, AttrValue> = {};
  for (const [key, value] of Object.entries(span.attrs)) {
    if (keepAttribute(key)) attrs[key] = shorten(value);
  }
  return { ...span, attrs, events: span.events.filter((event) => KEEP_EVENTS.has(event.name)) };
}
