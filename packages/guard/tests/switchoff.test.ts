import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { feedCrossing } from './drive.js';
import { checkoutTrace, faults, START, V2 } from './fixtures.js';
import { FakeFlagsmith, harness, listen, toOtlp, type Harness } from './helpers.js';

let fake: FakeFlagsmith;
let h: Harness;

beforeEach(async () => {
  fake = new FakeFlagsmith();
  await fake.start();
  h = harness(fake, START);
  await h.service.start();
});

afterEach(async () => {
  await h.service.stop();
  await fake.stop();
});

describe('the switch-off', () => {
  it('sets the rollout to 0% once and confirms with 20 identities', async () => {
    feedCrossing(h);
    await h.clock.advanceBy(3000);
    const view = h.service.state();
    expect(fake.patches).toBe(1);
    expect(fake.rolloutZero).toBe(true);
    expect(fake.rollouts[0]).toEqual({ enabled: true, rollout_percentage: 0, feature_state_value: { type: 'string', value: 'stable' }, multivariate_feature_state_values: [{ multivariate_feature_option: 1, percentage_allocation: 50 }] });
    expect(fake.count('GET /api/v1/identities/')).toBe(20);
    expect(view.state.phase).toBe('watching');
    expect(view.flagsmith.switchOff).toEqual({
      requested: true,
      confirmed: true,
      detail: 'checkout_v2 rollout set to 0% in Flagsmith; 20 of 20 identities checked get stable',
    });
    expect(view.timeline.map((e) => e.text)).toContain('Flagsmith check passed: 20 of 20 identities checked get stable');
  });

  it('requests it exactly once when batches arrive concurrently, before and after the crossing', async () => {
    const api = await listen(h);
    try {
      const batch = (n: number) =>
        fetch(`${api.url}/v1/traces`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(toOtlp(checkoutTrace({ n, startMs: START - 100, durationMs: 100, variation: V2, identity: `u${n}`, faults: [faults.coupon] }))),
        });
      await Promise.all(Array.from({ length: 40 }, (_, i) => batch(i + 1)));
      const during = h.clock.advanceBy(3000);
      await Promise.all(Array.from({ length: 40 }, (_, i) => batch(i + 100)));
      await during;
      await h.clock.advanceBy(10000);
    } finally {
      await api.close();
    }
    expect(fake.requests.filter((line) => line.startsWith('PATCH'))).toHaveLength(1);
    expect(fake.patches).toBe(1);
    expect(h.service.state().state.phase).toBe('watching');
  });

  it('says "switch-off not confirmed" while Flagsmith is down, then confirms when it is back', async () => {
    fake.down = true;
    feedCrossing(h);
    await h.clock.advanceBy(3000);
    let view = h.service.state();
    expect(view.state.phase).toBe('switching-off');
    expect(view.state.switchOffConfirmed).toBe(false);
    expect(view.flagsmith.switchOff.confirmed).toBe(false);
    expect(view.flagsmith.switchOff.detail.startsWith('switch-off not confirmed: Flagsmith did not answer')).toBe(true);
    await h.clock.advanceBy(20000);
    expect(h.service.state().state.phase).toBe('switching-off');
    expect(h.service.state().timeline.filter((e) => e.text.startsWith('Switch-off not confirmed')).length).toBeGreaterThan(2);

    fake.down = false;
    await h.clock.advanceBy(20000);
    view = h.service.state();
    expect(view.state.phase).toBe('watching');
    expect(view.flagsmith.switchOff.confirmed).toBe(true);
    expect(fake.patches).toBe(1);
  });

  it('retries a 5xx on the update and still changes the flag once', async () => {
    fake.patchFailures = 2;
    feedCrossing(h);
    await h.clock.advanceBy(3000 + 1000 + 2000 + 1000);
    await h.clock.advanceBy(5000);
    expect(h.service.state().state.phase).toBe('watching');
    expect(fake.count('PATCH')).toBe(3);
    expect(fake.patches).toBe(1);
  });

  it('does not report a switch-off the check does not support', async () => {
    fake.patchHasNoEffect = true;
    feedCrossing(h);
    await h.clock.advanceBy(3000);
    let view = h.service.state();
    expect(view.state.phase).toBe('switching-off');
    expect(view.flagsmith.switchOff.detail).toMatch(/^switch-off not confirmed: \d+ of 20 identities checked still get the new version$/);
    await h.clock.advanceBy(10000);
    expect(h.service.state().state.phase).toBe('switching-off');
    fake.patchHasNoEffect = false;
    await h.clock.advanceBy(20000);
    view = h.service.state();
    expect(view.state.phase).toBe('watching');
    expect(view.flagsmith.switchOff.detail).toContain('20 of 20 identities checked get stable');
  });

  it('does not switch off for failures that are not in the flagged path', async () => {
    const at = h.clock.now();
    for (let n = 1; n <= 40; n += 1) {
      h.service.receive(checkoutTrace({ n, startMs: at - 100, durationMs: 40, variation: V2, identity: `u${n}`, faults: [faults.dbRefused('shop-query')] }));
    }
    await h.clock.advanceBy(10000);
    const view = h.service.state();
    expect(view.state.phase).toBe('armed');
    expect(view.state.notCounted.dependency).toBe(40);
    expect(fake.patches).toBe(0);
    expect(fake.count('PATCH')).toBe(0);
  });
});
