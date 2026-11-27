// node scripts/shoot-url.mjs <out.png> <width> <height> <path> [full] [waitMs]
import { chromium } from '@playwright/test';
const [out, w, h, path, full, wait] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: Number(w), height: Number(h) } });
await p.goto((process.env.BASE_URL ?? 'http://127.0.0.1:4173') + path);
await p.waitForTimeout(Number(wait ?? 3000));
await p.screenshot({ path: out, fullPage: full === 'full' });
await b.close();
