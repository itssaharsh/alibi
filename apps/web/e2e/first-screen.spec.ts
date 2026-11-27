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
  await expect(numbers).toContainText('24.9081');
  await expect(numbers).toContainText('424');
});
