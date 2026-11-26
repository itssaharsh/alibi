import { describe, expect, it } from 'vitest';
import { TraceAssembler } from '../src/assemble.js';
import { checkoutTrace, START, V2 } from './fixtures.js';

const trace = (n = 1) => checkoutTrace({ n, startMs: START, variation: V2 });

describe('TraceAssembler', () => {
  it('waits for the root and then for quiet', () => {
    const a = new TraceAssembler({ settleMs: 2000, expireMs: 30000 });
    const spans = trace();
    a.add(spans, 0);
    expect(a.poll(1999).ready).toEqual([]);
    const { ready } = a.poll(2000);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.spans).toHaveLength(spans.length);
    expect(a.pending).toBe(0);
  });

  it('assembles batches that arrive out of order, children before the root', () => {
    const a = new TraceAssembler();
    const [root, ...children] = trace();
    a.add(children, 100);
    expect(a.poll(5000).ready).toEqual([]);
    a.add([root as NonNullable<typeof root>], 5100);
    expect(a.poll(6000).ready).toEqual([]);
    expect(a.poll(7100).ready[0]?.spans).toHaveLength(children.length + 1);
  });

  it('a late child span restarts the quiet time', () => {
    const a = new TraceAssembler({ settleMs: 2000 });
    const spans = trace();
    a.add(spans.slice(0, 3), 0);
    a.add(spans.slice(3), 1500);
    expect(a.poll(2500).ready).toEqual([]);
    expect(a.poll(3500).ready).toHaveLength(1);
  });

  it('drops a span that arrives after its trace was released', () => {
    const a = new TraceAssembler({ settleMs: 1000 });
    const spans = trace();
    a.add(spans, 0);
    a.poll(1000);
    a.add(spans.slice(0, 1), 1500);
    expect(a.pending).toBe(0);
    expect(a.droppedLate).toBe(1);
  });

  it('ignores a span sent twice', () => {
    const a = new TraceAssembler({ settleMs: 1000 });
    const spans = trace();
    a.add(spans, 0);
    a.add(spans, 10);
    expect(a.poll(2000).ready[0]?.spans).toHaveLength(spans.length);
  });

  it('expires a trace that never got a root', () => {
    const a = new TraceAssembler({ settleMs: 1000, expireMs: 30000 });
    a.add(trace().slice(1), 0);
    expect(a.poll(29999)).toEqual({ ready: [], expired: [] });
    const result = a.poll(30000);
    expect(result.ready).toEqual([]);
    expect(result.expired).toHaveLength(1);
    expect(a.pending).toBe(0);
  });

  it('releases a trace with a root that keeps growing once it is old enough', () => {
    const a = new TraceAssembler({ settleMs: 2000, expireMs: 10000 });
    const [root, ...children] = trace();
    a.add([root as NonNullable<typeof root>], 0);
    children.forEach((child, i) => a.add([child], (i + 1) * 1500));
    expect(a.poll(9000).ready).toEqual([]);
    expect(a.poll(10000).ready).toHaveLength(1);
  });

  it('keeps traces apart and returns them in a stable order', () => {
    const a = new TraceAssembler({ settleMs: 1000 });
    a.add(trace(2), 0);
    a.add(trace(1), 0);
    expect(a.poll(1000).ready.map((t) => t.traceId)).toEqual([trace(1)[0]?.traceId, trace(2)[0]?.traceId]);
  });
});
