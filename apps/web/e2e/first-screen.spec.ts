import { expect, test } from '@playwright/test';

test('the outage result is on the first screen with no click, and replay reaches the end', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Was it the flag, or was the database down?');
  const stamp = page.locator('.stamp');
  await expect(stamp).toHaveText(/Flag stays on/i);
  await expect(page.locator('.verdict .big')).toContainText(/^0\s*of\s*\d+/);
  const replay = page.getByRole('button', { name: /^Replay the database outage/ });
  await expect(replay).toBeVisible();
  await page.getByRole('radio', { name: '30×' }).click();
  await replay.click();
  await expect(page.getByRole('button', { name: /Pause replay/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Replay again' })).toBeVisible({ timeout: 60_000 });
  await expect(stamp).toHaveText(/Flag stays on/i);
  await expect(page.locator('.count').first()).toContainText('0');
});

test('the recorded coupon bug switches off at the 16th and ends labelled', async ({ page }) => {
  await page.goto('./?run=coupon-bug&speed=30');
  await page.getByRole('button', { name: /^Replay the coupon bug/ }).click();
  await expect(page.locator('.stamp')).toHaveText(/Switched off|Switching off/, { timeout: 60_000 });
  await expect(page.locator('.stamp')).toHaveText(/probably the feature/, { timeout: 60_000 });
  await expect(page.getByText('Not proven. A person investigates.').first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Investigation record' })).toBeVisible();
});

test('the page makes no claim stronger than the label', async ({ page }) => {
  for (const url of ['./', './?state=labelled-feature', './?state=labelled-not-feature']) {
    await page.goto(url);
    await page.waitForTimeout(1500);
    const text = (await page.locator('body').innerText()).toLowerCase();
    for (const banned of ['caused by', 'root cause', 'proved', 'the cause was']) expect(text, `${url} contains "${banned}"`).not.toContain(banned);
  }
});

test("the author's rule is shown in his words", async ({ page }) => {
  await page.goto('./');
  const rule = page.getByRole('region', { name: "The author's rule" });
  await expect(rule).toContainText("Only failures in the feature's own code path count.");
  await expect(rule).toContainText('Switch the flag off when more than 15 requests with the flag on have failed on the flagged path.');
  await expect(rule).toContainText("the system never declares the cause on its own.");
});

test('nothing hard-coded: the runs come from runs/index.json', async ({ page, request }) => {
  const index = await (await request.get('./runs/index.json')).json();
  await page.goto('./');
  for (const run of index.runs) await expect(page.getByRole('group', { name: 'Try these' })).toContainText(run.title);
  const probe = await (await request.get('./probe.json')).json();
  expect(probe.decision).toBeTruthy();
});

test('the recorded run shows its real sentences and the folded waterfall', async ({ page }) => {
  await page.goto('./?run=coupon-bug&state=labelled-feature');
  await page.waitForTimeout(2500);
  await expect(page.getByText('Carts with the SAVE10 coupon began (about 1 in 5).').first()).toBeVisible();
  await expect(page.getByText('checkout_v2 rollout set to 0% in Flagsmith; 20 of 20 identities checked get stable').first()).toBeVisible();
  const more = page.getByRole('button', { name: /^Show all \d+ spans/ }).first();
  await expect(more).toBeVisible();
  await expect(page.getByText('middleware - ')).toHaveCount(0);
  await more.click();
  await expect(page.getByText('middleware - query').first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Investigation record' })).toContainText("Flagsmith's numbers");
  const numbers = page.getByRole('region', { name: 'Investigation record' });
  await expect(numbers).toContainText('checkout latency ms');
  await expect(numbers).toContainText('27.16');
  await expect(numbers).toContainText('126');
});

test('two simpler rules are shown beside Alibi, in the engine\'s words, on every run', async ({ page }) => {
  await page.goto('./?run=outage');
  const card = page.getByRole('group', { name: 'Two simpler rules, same requests' }).first();
  await expect(card).toContainText('Plain error-rate rule: would have switched the flag off here', { useInnerText: true });
  await expect(card).toContainText('Arm comparison (flag on against stable): would have switched the flag off here, flag on 39.1% against stable 28.8% over the last 60 seconds.', { useInnerText: true });
  await expect(card).toContainText('Alibi counted 0 of 97, so the flag stays on. 97 failed in a dependency.', { useInnerText: true });
  await expect(page.getByText('Both simpler rules would have switched it off: at +01:16 and +01:22.')).toBeVisible();
  await expect(card).not.toContainText('acted sooner');

  await page.goto('./?run=coupon-bug');
  await expect(page.getByRole('group', { name: 'Two simpler rules, same requests' }).first()).toContainText('Both simpler rules acted sooner than Alibi.');

  await page.goto('./?run=slow-host');
  await expect(page.locator('.why-line')).toContainText("The flag went off because the feature's own code failed. Afterwards it did not return to the stable level", { useInnerText: true });
  await expect(page.locator('.why-line')).toContainText('so it was probably not the feature.');
});

test('a newcomer is helped: no "0 of 0", glosses on the lanes, plain explanations on hover', async ({ page }) => {
  await page.goto('./?run=outage&state=armed');
  await expect(page.locator('.verdict')).toContainText('No failures yet');
  expect(await page.locator('body').innerText()).not.toMatch(/\b0 of 0\b/);
  await expect(page.locator('.lane p', { hasText: "the new checkout's own code" })).toBeVisible();
  await expect(page.locator('.lane p', { hasText: 'database, other services, the server' })).toBeVisible();
  await expect(page.getByText('counts; the flag goes off above 15')).toBeVisible();
  await page.locator('.lane h3 .gloss', { hasText: 'flagged code' }).hover();
  await expect(page.getByRole('tooltip').filter({ hasText: "The new checkout's own code, the part that runs only when the flag is on." })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Words used here' })).toContainText('Chance to win');
});

test('with no demo video file, neither the link nor the player renders', async ({ page }) => {
  await page.route('**/video.json', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await page.goto('./');
  await expect(page.locator('.stamp')).toBeVisible();
  await expect(page.getByRole('link', { name: /Watch the demo/ })).toHaveCount(0);
  await expect(page.locator('#demo')).toHaveCount(0);
  // a server that answers every missing path with the page itself must not conjure a video either
  await page.unroute('**/video.json');
  await page.route('**/video.json', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>x</title>' }));
  await page.reload();
  await expect(page.locator('.stamp')).toBeVisible();
  await expect(page.getByRole('link', { name: /Watch the demo/ })).toHaveCount(0);
  await expect(page.locator('#demo')).toHaveCount(0);
});

test('with a demo video, the link and a lazy player appear and nothing is downloaded before play', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (r) => requested.push(r.url()));
  await page.route('**/video.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ file: 'alibi-demo.mp4', poster: 'alibi-demo-poster.jpg', captions: 'alibi-demo.vtt', seconds: 152 }) }));
  await page.goto('./');
  const link = page.getByRole('link', { name: 'Watch the demo (2:32)' });
  await expect(link).toBeVisible();
  await expect(page.locator('#demo')).toContainText('The demo');
  // The player is drawn only when its section nears the screen, so go there first.
  await link.click();
  const video = page.locator('#demo video');
  await expect(video).toBeInViewport();
  await expect(video).toHaveAttribute('preload', 'none');
  await expect(video).toHaveAttribute('poster', /alibi-demo-poster\.jpg$/);
  await expect(video.locator('track')).toHaveAttribute('kind', 'captions');
  expect(requested.filter((u) => u.endsWith('alibi-demo.mp4')), 'the video was fetched before play').toEqual([]);
});

test('without a known duration the link has no time, and record mode shows no video', async ({ page }) => {
  await page.route('**/video.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ file: 'alibi-demo.mp4' }) }));
  await page.goto('./');
  await expect(page.getByRole('link', { name: 'Watch the demo', exact: true })).toBeVisible();
  await page.goto('./?record=1');
  await expect(page.locator('.stamp')).toBeVisible();
  await expect(page.locator('#demo')).toHaveCount(0);
});

test('the arm comparison margin is stated once in plain words, from the run settings', async ({ page }) => {
  await page.goto('./?run=outage');
  const card = page.getByRole('group', { name: 'Two simpler rules, same requests' }).first();
  await expect(card).toContainText('The arm comparison acts at a 10-point margin', { useInnerText: true });
});

type Summary = { snapshot: { newTags: { id: string; counted: boolean; atMs: number; cls: string }[]; newStableTags?: { id: string }[] } };

test('"Why this verdict" is on the first screen, without scrolling, with the engine\'s numbers', async ({ page }) => {
  await page.goto('./?run=outage');
  const why = page.getByRole('region', { name: 'Why this verdict' });
  await expect(why).toBeInViewport({ ratio: 1 });
  await expect(why.getByRole('link')).toHaveCount(4);
  await expect(why).toContainText("None in the feature's own code", { useInnerText: true });
  await expect(why).toContainText('97 failed in a dependency: pg.connect, Connection terminated unexpectedly', { useInnerText: true });
  await expect(why).toContainText('The stable version failed at pg.connect too: 82 of its requests', { useInnerText: true });
  await expect(why).toContainText('The flag was not switched off, so there was nothing to check', { useInnerText: true });
  await expect(page.locator('.stamp')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.mini')).toBeInViewport({ ratio: 0.5 });
});

test('each line of "Why this verdict" lands on its evidence with the right request open', async ({ page, request }) => {
  const s = (await (await request.get('./runs/coupon-bug.summary.json')).json()) as Summary;
  const firstCounted = s.snapshot.newTags.filter((t) => t.counted).sort((a, b) => a.atMs - b.atMs)[0]!;
  await page.goto('./?run=coupon-bug');
  const why = page.getByRole('region', { name: 'Why this verdict' });
  await why.getByRole('link').nth(0).click();
  await expect(page.getByRole('tab', { name: /^Counted/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.sticky')).toContainText(firstCounted.id.slice(0, 8));
  await expect(page.getByRole('heading', { name: 'Failing requests' })).toBeInViewport();
  await why.getByRole('link').nth(2).click();
  await expect(page.getByRole('region', { name: 'Compared with the stable version' })).toBeInViewport();
  await why.getByRole('link').nth(3).click();
  await expect(page.getByRole('region', { name: 'The watch after the switch-off' })).toBeInViewport();
  await expect(why).toContainText('Back at the stable level at +03:30: probably the feature', { useInnerText: true });

  await page.goto('./?run=outage');
  await page.getByRole('region', { name: 'Why this verdict' }).getByRole('link').nth(1).click();
  await expect(page.getByRole('tab', { name: /^Not counted/ })).toHaveAttribute('aria-selected', 'true');
  const out = (await (await request.get('./runs/outage.summary.json')).json()) as Summary;
  const firstExcluded = out.snapshot.newTags.filter((t) => !t.counted).sort((a, b) => a.atMs - b.atMs)[0]!;
  await expect(page.locator('.sticky')).toContainText(firstExcluded.id.slice(0, 8));
});

test('a deep link opens that request and brings its trace into view', async ({ page, request }) => {
  const s = (await (await request.get('./runs/coupon-bug.summary.json')).json()) as Summary;
  const counted = s.snapshot.newTags.filter((t) => t.counted).sort((a, b) => a.atMs - b.atMs);
  const target = counted[4]!;
  await page.goto(`./?run=coupon-bug&trace=${target.id}`);
  await expect(page.locator('.sticky')).toContainText(target.id.slice(0, 8));
  await expect(page.locator('a.f-row.sel')).toContainText(target.id.slice(0, 8));
  await expect(page.getByRole('heading', { name: 'Trace', exact: true })).toBeInViewport({ timeout: 10_000 });
  await expect(page.locator('.sticky .reason')).toContainText('Failed in checkout_v2.apply_coupon');
  // a stable request that failed opens too, on the stable list
  const stable = s.snapshot.newStableTags?.[0];
  if (stable) {
    await page.goto(`./?run=coupon-bug&trace=${stable.id}`);
    await expect(page.getByRole('tab', { name: /^Stable version, same period/ })).toHaveAttribute('aria-selected', 'true');
  }
  await page.getByRole('button', { name: 'Copy link' }).first().isVisible();
});

test('the failing requests are split into counted, not counted and the stable version', async ({ page }) => {
  await page.goto('./?run=outage');
  await expect(page.getByRole('tab', { name: /^Counted \(0\)/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Not counted \(97\)/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('a.f-row').first()).toContainText('dependency');
  await page.getByRole('tab', { name: /^Stable version, same period/ }).click();
  await expect(page.locator('a.f-row .chip').first()).toHaveText('stable');
});

test('Flagsmith stills show under the record only when the files exist', async ({ page }) => {
  await page.route('**/figures.json', (route) => route.fulfill({ status: 404, body: 'no' }));
  await page.goto('./?run=coupon-bug');
  await expect(page.getByRole('region', { name: 'Investigation record' })).toBeVisible();
  await expect(page.locator('.figures')).toHaveCount(0);
  await page.unroute('**/figures.json');
  await page.route('**/figures.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ rollout: 'flagsmith-rollout.png', results: 'flagsmith-results.png' }) }));
  await page.reload();
  await expect(page.getByText("Flagsmith's own experiment page after the switch-off: Current rollout 0%")).toBeAttached();
  await expect(page.getByText("Flagsmith's results table for the same experiment")).toBeAttached();
  await expect(page.locator('.figures img').first()).toHaveAttribute('loading', 'lazy');
});

test('five runs fit the "Try these" row without sideways scroll on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/runs/index.json', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as { runs: { name: string; title: string; planted: string; source: string; size: number }[]; default: string };
    const extra = ['The rare bug', 'The cold cache'].map((title, i) => ({ ...json.runs[0]!, name: `extra-${i}`, title }));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...json, runs: [...json.runs, ...extra] }) });
  });
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'The cold cache' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('the scoreboard shows the numbers the summary file produces, below the first screen', async ({ page, request }) => {
  const score = (await (await request.get('./scoreboard.json')).json()) as { headline: string; rows: { what: string; decision: string }[]; lines: string[] };
  await page.goto('./');
  const board = page.getByRole('region', { name: 'How the simpler rules did on the planned runs' });
  await expect(board).toBeAttached();
  await expect(board.getByRole('heading')).toHaveText(score.headline);
  await expect(board.locator('tbody tr')).toHaveCount(score.rows.length);
  for (const line of score.lines) await expect(board).toContainText(line);
  // not on the first screen: the page answers the question first
  await expect(board).not.toBeInViewport();
});

test('a run added later (service-outage, rare-bug) opens from the picker and its notice or label is shown', async ({ page, request }) => {
  const index = (await (await request.get('./runs/index.json')).json()) as { runs: { name: string; title: string }[] };
  const names = index.runs.map((r) => r.name);
  test.skip(!names.includes('service-outage') && !names.includes('rare-bug'), 'these recorded runs are not in runs/ yet');
  expect(names.slice(0, 3)).toEqual(['outage', 'coupon-bug', 'slow-host']);
  if (names.includes('service-outage')) {
    await page.goto('./?run=service-outage');
    await expect(page.getByRole('region', { name: 'Why this verdict' })).toContainText('Notice:');
    await expect(page.locator('.lane-notice')).toBeVisible();
    await expect(page.getByRole('button', { name: /The notice/ }).first()).toBeVisible();
  }
  if (names.includes('rare-bug')) {
    await page.goto('./?run=rare-bug');
    await expect(page.locator('.stamp')).toContainText(/probably/);
    await expect(page.getByRole('button', { name: /The label/ }).first()).toBeVisible();
  }
});

test('a long run plays faster by default, and loading shows progress without fetching anything at first', async ({ page, request }) => {
  const index = (await (await request.get('./runs/index.json')).json()) as { runs: { name: string }[] };
  test.skip(!index.runs.some((r) => r.name === 'rare-bug'), 'the rare-bug run is not in runs/');
  const fetched: string[] = [];
  page.on('request', (r) => fetched.push(r.url()));
  await page.goto('./');
  await expect(page.locator('.stamp')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(fetched.filter((u) => u.endsWith('rare-bug.jsonl')), 'the first screen must not fetch the long run').toEqual([]);
  await page.getByRole('button', { name: 'The rare bug' }).click();
  await expect(page.getByRole('radio', { name: '30×' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: /^Replay the rare bug/ }).click();
  await expect(page.getByRole('button', { name: /Pause replay|Loading the run/ }).first()).toBeVisible();
});

test('"Plug it in" copies the real start command and fits without sideways scroll', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('./');
    const plug = page.getByRole('region', { name: 'How to plug it in' });
    await expect(plug).toContainText('docker compose -f deploy/docker-compose.yml up -d --build --wait');
    const overflow = await plug.evaluate((el) => [...el.querySelectorAll('pre')].map((p) => p.scrollWidth - p.clientWidth));
    expect(Math.max(...overflow)).toBeLessThanOrEqual(1);
  }
  await page.getByRole('button', { name: 'Copy command' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('docker compose -f deploy/docker-compose.yml up -d --build --wait');
});
