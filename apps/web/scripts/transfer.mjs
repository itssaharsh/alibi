// What a visitor downloads before any click: node scripts/transfer.mjs [w] [h]. Needs a preview running (BASE_URL).
import { chromium } from '@playwright/test';
const base = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const [w, h] = [Number(process.argv[2] ?? 1440), Number(process.argv[3] ?? 900)];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: w, height: h } });
const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p);
await cdp.send('Network.enable');
const sizes = new Map(); const urls = new Map();
cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
cdp.on('Network.loadingFinished', (e) => sizes.set(e.requestId, e.encodedDataLength));
await p.goto(base + '/');
await p.waitForTimeout(5000);
let total = 0; const rows = [];
for (const [id, n] of sizes) { total += n; rows.push([n, urls.get(id)]); }
rows.sort((a, c) => c[0] - a[0]);
console.log(JSON.stringify({ viewport: `${w}x${h}`, totalKB: Math.round(total / 1024), requests: rows.length, mp4Requested: [...urls.values()].some((u) => u.endsWith('.mp4')), posterRequested: [...urls.values()].some((u) => u.endsWith('.jpg')), top: rows.slice(0, 6).map(([n, u]) => `${Math.round(n / 1024)} KB ${u.replace(base, '')}`) }, null, 1));
await b.close();
