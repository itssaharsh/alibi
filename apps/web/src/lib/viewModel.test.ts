import { describe, expect, it } from 'vitest';
import { createReplayer, replayRun } from '@alibi/core';
import { buildRun } from '../../../../packages/core/tests/fixtures';
import { metaOf, snapshotOf } from './snapshots';
import { alibiLine, plainRuleLine } from './format';
import { applySnapshot, boardFrom, outcomeOf, waterfallOf } from './viewModel';
import { FLAGGED_PATH_ATTRIBUTE } from '@alibi/core';

function finished(name: 'outage' | 'feature-bug' | 'degraded-host') {
  const lines = buildRun(name);
  const r = createReplayer(lines);
  const events = r.step(Infinity);
  return { lines, r, snap: snapshotOf(r, events, true, r.endsAtMs - r.header.startedAtMs) };
}

describe('the view model reads the engine and adds nothing', () => {
  it('outage: nothing counts, only dependency tags, the flag stays on, the plain rule trips', () => {
    const { r, snap } = finished('outage');
    const board = boardFrom(metaOf(r.header), snap);
    expect(snap.state.counted).toBe(0);
    expect(board.tags.length).toBeGreaterThan(0);
    expect(board.tags.every((t) => !t.counted && t.cls === 'dependency')).toBe(true);
    expect(outcomeOf(board)).toMatchObject({ kind: 'on', counted: 0 });
    expect(board.moments.map((m) => m.key)).toEqual(['plain-rule']);
    expect(plainRuleLine(board, true)).toMatch(/^A plain error-rate rule would have switched checkout_v2 off at \+\d\d:\d\d\.$/);
    expect(alibiLine(board)).toContain(`Alibi counted 0 of ${snap.state.totals.flagOn.failures}, so the flag is on.`);
    expect(snap.record).toBeUndefined();
  });

  it('coupon bug: the 16th counted tag switches off, then the label comes from the engine', () => {
    const { r, snap } = finished('feature-bug');
    const board = boardFrom(metaOf(r.header), snap);
    expect(board.tags.filter((t) => t.counted).length).toBeGreaterThanOrEqual(16);
    expect(board.moments.map((m) => m.key).filter((k) => k !== 'plain-rule')).toEqual(['threshold', 'switched-off', 'recovered', 'label']);
    const o = outcomeOf(board);
    expect(o).toMatchObject({ kind: 'labelled', label: 'probably the feature' });
    expect(snap.record?.nextStep).toBe('A person investigates. Alibi does not declare the cause.');
    expect(snap.record?.traces).toEqual([]);
  });

  it('slow host: probably not the feature', () => {
    const { r, snap } = finished('degraded-host');
    expect(outcomeOf(boardFrom(metaOf(r.header), snap))).toMatchObject({ kind: 'labelled', label: 'probably not the feature' });
  });

  it('stepping in pieces ends in the same board as one full replay', () => {
    const lines = buildRun('feature-bug');
    const r = createReplayer(lines);
    const base = r.header.startedAtMs;
    let board = boardFrom(metaOf(r.header), snapshotOf(r, r.step(base), true, 0));
    for (let t = 20_000; t < r.endsAtMs - base + 20_000; t += 20_000) {
      const at = Math.min(t, r.endsAtMs - base);
      board = applySnapshot(board, snapshotOf(r, r.step(base + at), false, at));
    }
    const whole = finished('feature-bug');
    expect(board.tags.length).toBe(whole.snap.newTags.length);
    // Request totals can differ by a few requests depending on where the steps fall (the engine settles traces on its own ticks); the decision does not.
    const full = replayRun(lines).state;
    expect({ counted: board.state.counted, phase: board.state.phase, label: board.state.label }).toEqual({ counted: full.counted, phase: full.phase, label: full.label });
    expect(board.moments.map((m) => m.key)).toEqual(whole.snap.newMoments.map((m) => m.key));
  });

  it('a reset snapshot replaces what was drawn', () => {
    const { r, snap } = finished('feature-bug');
    const board = boardFrom(metaOf(r.header), snap);
    const reset = applySnapshot(board, { ...snap, reset: true, newTags: [], newMoments: [], nowMs: 0 });
    expect(reset.tags).toEqual([]);
    expect(reset.moments).toEqual([]);
  });

  it('orders a request as a tree and marks the engine origin span', () => {
    const lines = buildRun('outage');
    const { snap } = finished('outage');
    const tag = snap.newTags[0]!;
    const spans = lines.flatMap((l) => (l.kind === 'spans' ? l.spans.filter((s) => s.traceId === tag.id) : []));
    const wf = waterfallOf(spans, tag.origins, FLAGGED_PATH_ATTRIBUTE);
    expect(wf.rows[0]!.depth).toBe(0);
    expect(wf.rows.filter((r) => r.origin)).toHaveLength(tag.origins.length);
    expect(wf.rows.find((r) => r.origin)?.span.name).toBe('pg.query:SELECT shop');
  });
});
