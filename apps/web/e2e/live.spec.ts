import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';

// A stand-in guard that speaks the API the page expects, to prove the live adapter draws it.
test('the live board draws a guard stream', async ({ page }) => {
  const config = { flag: 'checkout_v2', stableVariation: 'stable', threshold: 15, watchMs: 300000, tolerance: { windowMs: 60000, minRequests: 20, errorRatePoints: 2, p95Factor: 1.25 }, plainRule: { windowMs: 30000, minRequests: 20, errorRate: 0.2 } };
  const rates = { requests: 0, failures: 0, errorRate: 0, p95Ms: 0 };
  const run = { name: 'coupon-bug', title: 'The coupon bug', planted: 'x', startedAtMs: 1_000_000, source: 'stand-in', recording: false };
  const state = { config, phase: 'armed', counted: 0, notCounted: { dependency: 2, server: 0, mixed: 0 }, totals: { flagOn: { ...rates, failures: 2 }, stable: rates }, switchOffConfirmed: false, lastSpanAtMs: 1_005_000 };
  const payload = { state, flagsmith: { forwarded: {}, switchOff: { requested: false, confirmed: false, detail: '' } }, timeline: [], records: [], run, receiver: {} };
  const verdict = (n: number) => ({ type: 'verdict', atMs: 1_000_000 + n * 1000, counted: 0, verdict: { traceId: `t${n}`.padEnd(32, '0'), route: '/checkout', startMs: 0, endMs: 1_000_000 + n * 1000, durationMs: 20, flagOn: true, failed: true, failureClass: 'dependency', origins: [], counted: false, reason: 'Failed in pg.query:SELECT shop, a dependency call.' } });
  const named = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/api/state') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...payload, recent: [] }));
    } else if (req.url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      res.write(named('state', payload) + named('verdict', verdict(6)) + named('verdict', verdict(7)));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await page.goto(`/?live=http://127.0.0.1:${port}`);
    await expect(page.locator('.count.dep')).toHaveText('4', { timeout: 15_000 });
    await expect(page.locator('.nav-cap')).toContainText('Live');
    await expect(page.locator('.pile .tag')).toHaveCount(2);
  } finally {
    server.close();
  }
});

test('the live board shows the switch-off, the countdown and the label', async ({ page }) => {
  const config = { flag: 'checkout_v2', stableVariation: 'stable', threshold: 15, watchMs: 300000, tolerance: { windowMs: 60000, minRequests: 20, errorRatePoints: 2, p95Factor: 1.25 }, plainRule: { windowMs: 30000, minRequests: 20, errorRate: 0.2 } };
  const rates = { requests: 10, failures: 0, errorRate: 0, p95Ms: 30 };
  const run = { name: 'coupon-bug', title: 'The coupon bug', planted: 'x', startedAtMs: 1_000_000, source: 'stand-in', recording: true };
  const state = { config, phase: 'watching', counted: 16, notCounted: { dependency: 0, server: 0, mixed: 0 }, totals: { flagOn: { ...rates, failures: 18 }, stable: rates }, stableBaseline: rates, switchOffConfirmed: true, switchedOffAtMs: 1_090_000, watchEndsAtMs: 1_390_000, lastSpanAtMs: 1_100_000 };
  const payload = { state, flagsmith: { switchOff: { requested: true, confirmed: true, detail: 'checkout_v2 rollout set to 0% in Flagsmith; 20 of 20 identities checked get stable' } }, timeline: [], records: [], run, receiver: {} };
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/api/state') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...payload, recent: [] }));
    } else if (req.url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await page.goto(`/?live=http://127.0.0.1:${port}`);
    await expect(page.getByRole('timer')).toContainText(/\d:\d\d left/, { timeout: 15_000 });
    await expect(page.locator('.flag')).toContainText('off for everyone in Flagsmith');
    const first = await page.getByRole('timer').innerText();
    await page.waitForTimeout(2500);
    expect(await page.getByRole('timer').innerText()).not.toBe(first);
    await expect(page.getByText('checkout_v2 rollout set to 0% in Flagsmith; 20 of 20 identities checked get stable')).toBeVisible();
  } finally {
    server.close();
  }
});
