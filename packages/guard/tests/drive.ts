import type { RunLine } from '@alibi/core';
import { checkoutTrace, faults, START, STABLE, V2 } from './fixtures.js';
import type { Harness } from './helpers.js';

/** Hands the span batches of a recorded-style run to the service at their own times. */
export async function play(h: Harness, lines: readonly RunLine[], stopAtMs = Infinity): Promise<void> {
  const batches = lines
    .filter((line): line is Extract<RunLine, { kind: 'spans' }> => line.kind === 'spans')
    .sort((a, b) => a.atMs - b.atMs);
  for (const batch of batches) {
    if (batch.atMs > stopAtMs) break;
    await h.clock.advanceTo(batch.atMs);
    h.service.receive(batch.spans);
    await h.service.idle();
  }
}

/** Twenty requests with the flag on that fail in the feature's own code, and ten on the stable version that pass. */
export function feedCrossing(h: Harness, firstN = 1000): void {
  const at = h.clock.now();
  for (let i = 0; i < 20; i += 1) {
    h.service.receive(checkoutTrace({ n: firstN + i, startMs: at - 150, durationMs: 100, variation: V2, identity: `user-${i}`, faults: [faults.coupon] }));
  }
  for (let i = 0; i < 10; i += 1) {
    h.service.receive(checkoutTrace({ n: firstN + 100 + i, startMs: at - 150, durationMs: 90, variation: STABLE, identity: `calm-${i}` }));
  }
}

export { START };
