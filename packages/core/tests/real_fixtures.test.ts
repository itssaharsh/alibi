import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { flattenOtlp } from '../src/otlp.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real');
const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : [];

/** A captured file is one JSON body, or one body per line as the collector's file exporter writes it. */
function bodies(text: string): unknown[] {
  try {
    return [JSON.parse(text)];
  } catch {
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  }
}

describe('real captured OTLP batches', () => {
  it('has nothing to check until captures are added, and that is fine', () => {
    expect(files.length).toBeGreaterThanOrEqual(0);
  });

  it.each(files)('%s parses into spans with ids, times and a kind', (name) => {
    const spans = bodies(readFileSync(join(dir, name), 'utf8')).flatMap((body) => flattenOtlp(body));
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(span.startMs).toBeGreaterThan(0);
      expect(span.endMs).toBeGreaterThanOrEqual(span.startMs);
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
      expect(['internal', 'server', 'client', 'producer', 'consumer']).toContain(span.kind);
      expect(typeof span.service).toBe('string');
    }
  });
});
