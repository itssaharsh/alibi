// Load and replay cost on a slow machine: node scripts/perf.mjs [cpuSlowdown=4]
import { chromium } from '@playwright/test';
const slow = Number(process.argv[2] ?? 4);
const base = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: slow });
await p.addInitScript(() => {
  window.__lcp = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
});
let bytes = 0;
p.on('response', async (r) => { try { if (r.url().includes('/runs/')) bytes += (await r.body()).length; } catch {} });
const t0 = Date.now();
await p.goto(`${base}/?run=coupon-bug`);
await p.locator('.stamp').waitFor();
const stampMs = Date.now() - t0;
const lcp = await p.evaluate(() => window.__lcp);
const beforeReplayBytes = bytes;
await p.getByRole('button', { name: /^Replay the coupon bug/ }).click();
await p.waitForFunction(() => window.__alibiTimings, null, { timeout: 60000 });
const timings = await p.evaluate(() => window.__alibiTimings);
const loadedMs = Date.now() - t0;
// frame pacing while playing at 8x and 30x
async function frames(speed) {
  await p.getByRole('radio', { name: `${speed}×` }).click();
  return p.evaluate(() => new Promise((res) => {
    const d = []; let last = performance.now(); const end = last + 6000;
    const tick = (n) => { d.push(n - last); last = n; if (n < end) requestAnimationFrame(tick); else res(d); };
    requestAnimationFrame(tick);
  })).then((d) => { d.shift(); d.sort((a, c) => a - c); return { frames: d.length, medianMs: +d[Math.floor(d.length / 2)].toFixed(1), p95Ms: +d[Math.floor(d.length * 0.95)].toFixed(1), over50ms: d.filter((x) => x > 50).length }; });
}
const f8 = await frames(8);
const f30 = await frames(30);
console.log(JSON.stringify({ cpuSlowdown: slow, firstScreenStampMs: stampMs, lcpMs: Math.round(lcp), bytesBeforeReplay: beforeReplayBytes, fullRunBytes: bytes - beforeReplayBytes, workerFetchMs: Math.round(timings.fetchMs), workerParseMs: Math.round(timings.parseMs), replayReadyMs: loadedMs, frames8x: f8, frames30x: f30 }, null, 1));
await b.close();
