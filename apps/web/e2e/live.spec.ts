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
    await page.goto(`./?live=http://127.0.0.1:${port}`);
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
    await page.goto(`./?live=http://127.0.0.1:${port}`);
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

// A live board must never show anything from the recorded runs: not a request, a sentence, a number or a run name.
test('a live board shows nothing from the recorded runs', async ({ page, request }) => {
  const config = { flag: 'checkout_v2', stableVariation: 'stable', threshold: 15, watchMs: 300000, tolerance: { windowMs: 60000, minRequests: 20, errorRatePoints: 2, p95Factor: 1.25 }, plainRule: { windowMs: 30000, minRequests: 20, errorRate: 0.2 } };
  const rates = { requests: 10, failures: 0, errorRate: 0, p95Ms: 30 };
  const run = { name: 'live-run', title: 'Live traffic', planted: 'x', startedAtMs: 1_000_000, source: 'stand-in', recording: true };
  const state = { config, phase: 'armed', counted: 1, notCounted: { dependency: 0, server: 0, mixed: 0 }, totals: { flagOn: { ...rates, failures: 1 }, stable: rates }, switchOffConfirmed: false, lastSpanAtMs: 1_005_000 };
  const payload = { state, flagsmith: { switchOff: { requested: false, confirmed: false, detail: '' } }, timeline: [], records: [], run, receiver: {} };
  const traceId = 'a1b2c3d4'.padEnd(32, 'e');
  const verdict = {
    type: 'verdict', atMs: 1_004_000, counted: 1,
    verdict: { traceId, route: '/live-route', startMs: 1_003_990, endMs: 1_004_000, durationMs: 10, flagOn: true, failed: true, failureClass: 'flagged-path', counted: true,
      origins: [{ spanId: 's2', name: 'live.step', kind: 'internal', service: 'x', class: 'flagged-path', onFlaggedPath: true, detail: 'LiveError', durationMs: 5 }],
      reason: 'Failed in live.step, a span on the flagged path: LiveError. Counts toward the switch-off.' },
  };
  const spans = [
    { traceId, spanId: 's1', name: 'live.root', kind: 'server', service: 'x', startMs: 1_003_990, endMs: 1_004_000, durationMs: 10, attrs: {}, events: [], error: true },
    { traceId, spanId: 's2', parentSpanId: 's1', name: 'live.step', kind: 'internal', service: 'x', startMs: 1_003_992, endMs: 1_003_997, durationMs: 5, attrs: {}, events: [], error: true },
  ];
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/api/state') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...payload, recent: [verdict.verdict] }));
    } else if (req.url === `/api/traces/${traceId}`) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(spans));
    } else if (req.url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  // What the recorded runs would put on screen, read from the build's own summaries.
  const index = (await (await request.get('./runs/index.json')).json()) as { runs: { name: string; title: string; source: string }[] };
  const markers: string[] = [];
  for (const r of index.runs) {
    const s = (await (await request.get(`./runs/${r.name}.summary.json`)).json()) as { featured?: { id: string }; snapshot: { newTags: { id: string; reason: string }[]; flagsmith?: { detail: string; data: { variations: { exposures: number }[] } } } };
    markers.push(r.title, r.source);
    if (s.featured) markers.push(s.featured.id.slice(0, 8));
    for (const t of s.snapshot.newTags.slice(0, 3)) markers.push(t.id.slice(0, 8), t.reason);
    for (const v of s.snapshot.flagsmith?.data.variations ?? []) markers.push(`${v.exposures} exposures`);
  }
  const fetched: string[] = [];
  page.on('request', (r) => fetched.push(r.url()));
  try {
    await page.goto(`./?live=http://127.0.0.1:${port}`);
    // The live run's own failing request is open, from the guard's spans.
    await expect(page.locator('.mini')).toContainText('live.step', { timeout: 15_000 });
    await expect(page.locator('.mini')).toContainText('Failed in live.step, a span on the flagged path: LiveError.');
    await expect(page.locator('.mini')).toContainText(traceId.slice(0, 8));
    await page.waitForTimeout(1500);
    const text = await page.locator('body').innerText();
    for (const marker of markers) expect(text, `the live board shows "${marker}" from a recorded run`).not.toContain(marker);
    expect(text).not.toContain('Replay of a recorded run');
    await expect(page.getByRole('group', { name: 'Try these' })).toHaveCount(0);
    expect(fetched.filter((u) => u.includes('/runs/')), 'a recorded run was fetched by the live board').toEqual([]);
  } finally {
    server.close();
  }
});

test('a live board with no failure yet says so', async ({ page }) => {
  const config = { flag: 'checkout_v2', stableVariation: 'stable', threshold: 15, watchMs: 300000, tolerance: { windowMs: 60000, minRequests: 20, errorRatePoints: 2, p95Factor: 1.25 }, plainRule: { windowMs: 30000, minRequests: 20, errorRate: 0.2 } };
  const rates = { requests: 10, failures: 0, errorRate: 0, p95Ms: 30 };
  const run = { name: 'live-run', title: 'Live traffic', planted: 'x', startedAtMs: 1_000_000, source: 'stand-in', recording: true };
  const state = { config, phase: 'armed', counted: 0, notCounted: { dependency: 0, server: 0, mixed: 0 }, totals: { flagOn: rates, stable: rates }, switchOffConfirmed: false, lastSpanAtMs: 1_005_000 };
  const payload = { state, flagsmith: { switchOff: { requested: false, confirmed: false, detail: '' } }, timeline: [], records: [], run, receiver: {} };
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
    await page.goto(`./?live=http://127.0.0.1:${port}`);
    await expect(page.locator('.mini')).toContainText('No request has failed yet.', { timeout: 15_000 });
  } finally {
    server.close();
  }
});
