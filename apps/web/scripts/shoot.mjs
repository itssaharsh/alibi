// Screenshots of the built page for the critique loop: node scripts/shoot.mjs <outDir> [round]
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? 'shots';
const round = process.argv[3] ?? '1';
const base = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const b = await chromium.launch();
const jobs = [
  ['first', '/', 1440, 900, false], ['first', '/', 390, 844, false], ['firstfull', '/', 1440, 900, true], ['firstfull', '/', 390, 844, true],
  ['switch', '/?state=switching', 1440, 900, false], ['watch', '/?state=watching', 1440, 900, false],
  ['record', '/?state=labelled-feature', 1440, 900, true], ['record', '/?state=labelled-feature', 390, 844, true],
  ['slowhost', '/?state=labelled-not-feature', 1440, 900, true], ['playing', '/?state=playing', 1440, 900, false],
];
for (const [name, path, w, h, full] of jobs) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.goto(base + path);
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${out}/r${round}-${name}-${w}.png`, fullPage: full });
  await p.close();
}
await b.close();
