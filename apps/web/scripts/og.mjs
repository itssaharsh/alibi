// Renders public/og.png (1200x630) from the built page and public/apple-touch-icon.png from the favicon.
// Needs `npm run preview` running. Run: node scripts/og.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const base = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await p.goto(`${base}/?record=1&state=outage`);
await p.waitForTimeout(2500);
await p.addStyleTag({ content: '.mini,.btn,.plain,.hero~*,footer{display:none!important}.board{max-height:560px}.wrap{padding-top:16px}' });
await p.screenshot({ path: 'public/og.png' });
const icon = await b.newPage({ viewport: { width: 180, height: 180 } });
const svg = readFileSync('public/favicon.svg', 'utf8');
await icon.setContent(`<body style="margin:0;background:#F9FAFD;display:grid;place-items:center;height:180px"><div style="width:132px;height:132px">${svg.replace('<svg ', '<svg width="132" height="132" ')}</div></body>`);
await icon.screenshot({ path: 'public/apple-touch-icon.png' });
await b.close();
