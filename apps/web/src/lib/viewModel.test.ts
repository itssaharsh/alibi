import { describe, expect, it } from 'vitest';
import { createReplayer, replayRun } from '@alibi/core';
import { buildRun } from '../../../../packages/core/tests/fixtures';
import { metaOf, snapshotOf } from './snapshots';
import { alibiLine, simplerRules, simplerRulesShort } from './format';
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
    const two = simplerRules(board, true);
    expect(two.rules[0]!.text).toMatch(/^Plain error-rate rule: would have switched the flag off here, /);
    expect(two.rules[1]!.text).toMatch(/^Arm comparison \(flag on against stable\): would (not )?have switched the flag off/);
    expect(simplerRulesShort(board, true)).toMatch(/^(Both simpler rules|The plain error-rate rule) would have switched it off/);
    expect(alibiLine(board, true)).toContain(`Alibi counted 0 of ${snap.state.totals.flagOn.failures}, so the flag stays on.`);
    expect(snap.record).toBeUndefined();
  });

  it('coupon bug: the 16th counted tag switches off, then the label comes from the engine', () => {
    const { r, snap } = finished('feature-bug');
    const board = boardFrom(metaOf(r.header), snap);
    expect(board.tags.filter((t) => t.counted).length).toBeGreaterThanOrEqual(16);
    expect(board.moments.map((m) => m.key).filter((k) => k !== 'plain-rule' && k !== 'arm-rule')).toEqual(['threshold', 'switched-off', 'recovered', 'label']);
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

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRun } from '@alibi/core';

const realRun = fileURLToPath(new URL('../../../../runs/coupon-bug.jsonl', import.meta.url));

describe.skipIf(!existsSync(realRun))('against the recorded coupon-bug run', () => {
  const lines = parseRun(readFileSync(realRun, 'utf8'));
  const r = createReplayer(lines);
  const events = r.step(Infinity);
  const snap = snapshotOf(r, events, true, r.endsAtMs - r.header.startedAtMs);
  const counted = snap.newTags.filter((t) => t.counted);

  it('counts 16 failures on the flagged path and labels it "probably the feature"', () => {
    expect(snap.state.counted).toBe(16);
    expect(snap.state.label).toBe('probably the feature');
    expect(counted.length).toBeGreaterThanOrEqual(16);
    expect(counted[0]!.reason).toMatch(/^Failed in checkout_v2\.apply_coupon, a span on the flagged path: TypeError: Cannot read properties of undefined \(reading 'percent'\)\. Counts toward the switch-off\.$/);
  });

  it('keeps the root-to-failure path and the flagged spans, and folds middleware away', () => {
    const tag = counted[0]!;
    const spans = lines.flatMap((l) => (l.kind === 'spans' ? l.spans.filter((s) => s.traceId === tag.id) : []));
    const wf = waterfallOf(spans, tag.origins, FLAGGED_PATH_ATTRIBUTE);
    const shown = wf.rows.filter((row) => !row.quiet).map((row) => row.span.name);
    expect(shown).toEqual(expect.arrayContaining(['POST /checkout', 'request handler - /checkout', 'checkout', 'checkout_v2', 'checkout_v2.price', 'checkout_v2.apply_coupon']));
    expect(shown.some((n) => n.startsWith('middleware - '))).toBe(false);
    expect(wf.rows.length).toBeGreaterThan(shown.length);
  });

  it('carries the recorded switch-off answer and the world lines through to the record', () => {
    expect(snap.newMoments.find((m) => m.key === 'switched-off')?.detail).toBe('checkout_v2 rollout set to 0% in Flagsmith; 20 of 20 identities checked get stable');
    expect(snap.timeline.some((t) => t.text === 'Carts with the SAVE10 coupon began (about 1 in 5).')).toBe(true);
  });
});

import { recordedResults } from './snapshots';

describe('Flagsmith results are taken as recorded', () => {
  const data = { experimentId: 1, readAtMs: 5, variations: [{ variation: 'stable', exposures: 10, metrics: [{ name: 'checkout_completed', value: 1, chanceToWin: 0.97, interval: [0.9, 1] as [number, number] }] }] };
  it('keeps the detail and the numbers untouched, and ignores a failed reading', () => {
    const header = buildRun('outage')[0]!;
    const got = recordedResults([header, { kind: 'flagsmith', atMs: 9, what: 'results', ok: false, detail: 'no' }, { kind: 'flagsmith', atMs: 7, what: 'results', ok: true, detail: 'as of the switch-off', data }]);
    expect(got).toEqual({ atMs: 7, detail: 'as of the switch-off', data });
    expect(recordedResults([header])).toBeUndefined();
  });
});

const realOutage = fileURLToPath(new URL('../../../../runs/outage.jsonl', import.meta.url));
describe.skipIf(!existsSync(realOutage))('against the recorded outage run', () => {
  const lines = parseRun(readFileSync(realOutage, 'utf8'));
  const r = createReplayer(lines);
  const events = r.step(Infinity);
  const board = boardFrom(metaOf(r.header), snapshotOf(r, events, true, r.endsAtMs - r.header.startedAtMs));

  it('shows both simpler rules in the engine\'s words and says Alibi never acted', () => {
    const two = simplerRules(board, true);
    expect(two.rules.map((x) => x.at)).toEqual(['+01:16', '+01:22']);
    expect(two.rules[1]!.text).toBe('Arm comparison (flag on against stable): would have switched the flag off here, flag on 39.1% against stable 28.8% over the last 60 seconds.');
    expect(simplerRulesShort(board, true)).toBe('Both simpler rules would have switched it off: at +01:16 and +01:22.');
    expect(two.alibi).toMatch(/^Alibi counted 0 of 97, so the flag stays on\./);
    expect(two.sooner).toBeUndefined();
  });
});
