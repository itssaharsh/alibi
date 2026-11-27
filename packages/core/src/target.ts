import type { AttrValue, FlatSpan } from './types.js';

/** What a dependency span talks to. Span names alone mix up services: every HTTP client span is called `GET`. */
export interface DependencyTarget {
  /** Who it talks to, for example `rules:3000` or `postgresql toxiproxy:15432`. */
  target: string;
  /** The name to show people when the span name alone would not say it, for example `GET rules:3000`. */
  label?: string;
}

const SYSTEM_KEYS = ['db.system.name', 'db.system'];

function text(value: AttrValue | undefined): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function peerFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

function networkPeer(span: FlatSpan): string | undefined {
  const { attrs } = span;
  const address = text(attrs['server.address']);
  if (address) {
    const port = text(attrs['server.port']);
    return port ? `${address}:${port}` : address;
  }
  const fromUrl = peerFromUrl(text(attrs['url.full']) ?? text(attrs['http.url']));
  if (fromUrl) return fromUrl;
  const name = text(attrs['net.peer.name']);
  if (name) {
    const port = text(attrs['net.peer.port']);
    return port ? `${name}:${port}` : name;
  }
  return text(attrs['peer.service']);
}

/**
 * The target of a dependency span, read from the span's own fields: the peer for HTTP and other
 * network calls, the database system with its server or name for database calls. Undefined when the
 * span carries none of these, and the span name alone is then all there is.
 */
export function dependencyTarget(span: FlatSpan): DependencyTarget | undefined {
  const system = SYSTEM_KEYS.map((key) => text(span.attrs[key])).find((value) => value !== undefined);
  if (system) {
    const where = networkPeer(span) ?? text(span.attrs['db.namespace']);
    return { target: where ? `${system} ${where}` : system };
  }
  const peer = networkPeer(span);
  if (!peer) return undefined;
  const http = ['http.request.method', 'http.method', 'url.full', 'http.url'].some((key) => span.attrs[key] !== undefined);
  return http ? { target: peer, label: `${span.name} ${peer}` } : { target: peer };
}

/** One identity for a dependency span: its name and who it talks to. */
export function dependencyKey(name: string, target: string | undefined): string {
  return target === undefined ? name : `${name}\u0000${target}`;
}
