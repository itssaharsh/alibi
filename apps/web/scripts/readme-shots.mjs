// The README's screenshots, from the built page (npm run preview must be running). node scripts/readme-shots.mjs <outDir>
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? 'docs/img';
const base = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const b = await chromium.launch();
async function page(w, h) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  return ctx.newPage();
}
async function open(p, path) {
  await p.goto(base + path);
  await p.waitForTimeout(3500);
}
let p = await page(1440, 900);
await open(p, '/?run=outage');
await p.screenshot({ path: `${out}/first-screen.png` });
await open(p, '/?run=coupon-bug&state=switching');
await p.screenshot({ path: `${out}/coupon-switch.png` });
await open(p, '/?run=coupon-bug');
await p.locator('#focus-record').screenshot({ path: `${out}/record.png` });
p = await page(1440, 1300);
await open(p, '/?run=slow-host');
await p.screenshot({ path: `${out}/slow-host.png` });
p = await page(390, 844);
await open(p, '/?run=outage');
await p.screenshot({ path: `${out}/phone.png` });
await b.close();
