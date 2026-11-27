import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { feedCrossing, play } from './drive.js';
import { buildRun, START } from './fixtures.js';
import { FakeFlagsmith, HEALTH_TOKEN, harness, type Harness } from './helpers.js';

let fake: FakeFlagsmith;
let h: Harness;

beforeEach(async () => {
  fake = new FakeFlagsmith();
  await fake.start();
});

afterEach(async () => {
  await h.service.stop();
  await fake.stop();
});

const withHealth = (): Harness =>
  harness(fake, START, { FLAGSMITH_FEATURE_HEALTH_URL: `http://flagsmith:8000/api/v1/feature-health/${HEALTH_TOKEN}` });

describe('Flagsmith Feature Health', () => {
  it('marks the flag unhealthy with the engine\'s own words at the switch-off, and again with the label', async () => {
    h = withHealth();
    await h.service.start();
    const lines = buildRun('feature-bug');
    await play(h, lines);
    await h.clock.advanceBy(5000);
    expect(fake.healthPosts).toHaveLength(2);
    const [first, second] = fake.healthPosts;
    expect(first).toMatchObject({ feature: 'checkout_v2', status: 'unhealthy' });
    expect(first?.reason.url_blocks).toEqual([]);
    expect(first?.reason.text_blocks).toEqual([
      { title: 'Alibi switched this flag off', text: 'checkout_v2 rollout set to 0% in Flagsmith; 20 of 20 identities checked get stable' },
      { title: 'Failures counted', text: '16 requests with the flag on failed inside the flagged path. The switch-off needs more than 15.' },
      { title: 'Most common reason', text: expect.stringContaining('Failed in checkout_v2.apply_coupon, a span on the flagged path') },
    ]);
    expect(second?.status).toBe('unhealthy');
    expect(second?.reason.text_blocks.at(-1)).toEqual({ title: 'After the five-minute watch', text: 'probably the feature (not proven). A person investigates.' });
    expect(fake.healthPosts.every((post) => post.status === 'unhealthy')).toBe(true);
    expect(h.service.state().flagsmith.featureHealth).toMatchObject({ posts: 2 });
  });

  it('writes each post to the run file', async () => {
    const dir = (await import('./helpers.js')).tempDir();
    const file = `${dir}/run.jsonl`;
    h = harness(fake, START, { FLAGSMITH_FEATURE_HEALTH_URL: `http://flagsmith:8000/api/v1/feature-health/${HEALTH_TOKEN}`, ALIBI_RECORD: file }, dir);
    await h.service.start();
    await play(h, buildRun('feature-bug'));
    await h.clock.advanceBy(5000);
    await h.service.stop();
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(file, 'utf8');
    const lines = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>).filter((line) => line.what === 'feature-health');
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.ok)).toBe(true);
    expect(lines[1]?.detail).toBe('marked unhealthy, with the label: probably the feature');
    expect(text).not.toContain(HEALTH_TOKEN);
  });

  it('never posts when the flag stays on', async () => {
    h = withHealth();
    await h.service.start();
    await play(h, buildRun('outage'));
    expect(fake.healthPosts).toHaveLength(0);
  });

  it('shows a failed post in the state, hides the secret, and blocks nothing', async () => {
    h = withHealth();
    await h.service.start();
    fake.healthStatus = 500;
    feedCrossing(h);
    await h.clock.advanceBy(3000);
    const view = h.service.state();
    expect(view.state.phase).toBe('watching');
    expect(view.flagsmith.featureHealth?.posts).toBe(0);
    expect(view.flagsmith.featureHealth?.lastProblem).toContain('answered 500');
    expect(JSON.stringify(view)).not.toContain(HEALTH_TOKEN);
    expect(h.logs.join('\n')).not.toContain(HEALTH_TOKEN);
  });

  it('is left out when Flagsmith gave no webhook', async () => {
    h = harness(fake, START);
    await h.service.start();
    feedCrossing(h);
    await h.clock.advanceBy(3000);
    expect(h.service.state().flagsmith.featureHealth).toBeUndefined();
    expect(fake.healthPosts).toHaveLength(0);
  });
});
