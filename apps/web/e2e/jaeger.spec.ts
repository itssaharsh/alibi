import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';

// Needs a build made with VITE_JAEGER_URL=http://127.0.0.1:16686 (the compose board has it); skipped otherwise.
test.skip(!process.env.JAEGER_BUILD, 'run against a build with VITE_JAEGER_URL set');

test('on a live board the open request offers Open in Jaeger', async ({ page }) => {
  const config = { flag: 'checkout_v2', stableVariation: 'stable', threshold: 15, watchMs: 300000, tolerance: { windowMs: 60000, minRequests: 20, errorRatePoints: 2, p95Factor: 1.25 }, plainRule: { windowMs: 30000, minRequests: 20, errorRate: 0.2 } };
  const rates = { requests: 10, failures: 0, errorRate: 0, p95Ms: 30 };
  const run = { name: 'live-run', title: 'Live traffic', planted: 'x', startedAtMs: 1_000_000, source: 'stand-in', recording: true };
  const state = { config, phase: 'armed', counted: 1, notCounted: { dependency: 0, server: 0, mixed: 0 }, totals: { flagOn: { ...rates, failures: 1 }, stable: rates }, switchOffConfirmed: false, lastSpanAtMs: 1_005_000 };
  const payload = { state, flagsmith: { switchOff: { requested: false, confirmed: false, detail: '' } }, timeline: [], records: [], run, receiver: {} };
  const traceId = 'a1b2c3d4'.padEnd(32, 'e');
  const verdict = { traceId, route: '/live-route', startMs: 1_003_990, endMs: 1_004_000, durationMs: 10, flagOn: true, failed: true, failureClass: 'flagged-path', counted: true, origins: [], reason: 'Failed in live.step.' };
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/api/state') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...payload, recent: [verdict] }));
    } else if (req.url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await page.goto(`./?live=http://127.0.0.1:${port}`);
    const link = page.getByRole('link', { name: 'Open in Jaeger' }).first();
    await expect(link).toHaveAttribute('href', `http://127.0.0.1:16686/trace/${traceId}`, { timeout: 15_000 });
  } finally {
    server.close();
  }
});

test('a recorded run never offers Jaeger', async ({ page }) => {
  await page.goto('./?run=outage');
  await expect(page.getByRole('link', { name: 'Open in Jaeger' })).toHaveCount(0);
});
