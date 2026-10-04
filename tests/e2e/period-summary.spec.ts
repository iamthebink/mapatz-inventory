import { expect, test } from './fixtures';

test('waits for startup recovery before reading a direct summary and offers retry', async ({
  page,
}) => {
  let allowRecovery = false;
  let summaryReads = 0;
  await page.route('**/api/borrowers/search?**', async (route) => {
    if (!allowRecovery)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"temporary","message":"offline"}',
      });
    else await route.fallback();
  });
  await page.route('**/api/period-summary?**', async (route) => {
    summaryReads += 1;
    await route.fallback();
  });
  await page.goto('/summary');
  const retry = page.getByRole('button', { name: 'ניסיון טעינה מחדש' });
  await expect(retry).toBeVisible();
  expect(summaryReads).toBe(0);
  allowRecovery = true;
  await retry.click();
  await expect(page.getByRole('heading', { name: 'סיכום' })).toBeVisible();
  await expect.poll(() => summaryReads).toBeGreaterThan(0);
});

test('does not mount the borrower workflow in inventory management', async ({ page }) => {
  let searchReads = 0;
  await page.route('**/api/borrowers/search?**', async (route) => {
    searchReads += 1;
    await route.fallback();
  });
  await page.goto('/management');
  await expect(page.getByRole('tab', { name: /מלאי ומיקומים/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.borrower-workflow-entry')).toHaveCount(0);
  expect(searchReads).toBe(0);
});

test('keeps summary search and expansion through a guarded card return', async ({ page, seed }) => {
  await page.goto('/summary');
  await expect(page.getByRole('link', { name: 'סיכום' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'סיכום' })).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'חיפוש שואל' });
  await search.fill(seed.borrower.playaName);
  const row = page
    .locator('.period-summary-table tbody tr')
    .filter({ hasText: seed.borrower.fullName })
    .first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: `הצגת ציוד של ${seed.borrower.fullName}` }).click();
  await expect(page.getByText(seed.item.name, { exact: true })).toBeVisible();
  await row.getByRole('button', { name: `פתיחת כרטיס שואל — ${seed.borrower.fullName}` }).click();
  const card = page.getByRole('dialog', { name: /כרטיס שואל/ });
  await expect(card).toBeVisible();
  await expect(card.getByText(seed.borrower.playaName, { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'סגירה' }).last().click();
  await expect(card).toBeHidden();
  await expect(search).toHaveValue(seed.borrower.playaName);
  await expect(
    row.getByRole('button', { name: `הסתרת ציוד של ${seed.borrower.fullName}` }),
  ).toBeVisible();
  await expect(page.getByText(seed.item.name, { exact: true })).toBeVisible();
});

test('refreshes the originating summary after reviewed save and close', async ({ page, seed }) => {
  // Slow commits expose history-listener replacement during native popstate dispatch.
  const browser = await page.context().newCDPSession(page);
  await browser.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await page.goto('/summary');
  const search = page.getByRole('searchbox', { name: 'חיפוש שואל' });
  await search.fill(seed.borrower.playaName);
  const row = page
    .locator('.period-summary-table tbody tr')
    .filter({ hasText: seed.borrower.fullName })
    .first();
  await expect(row).toContainText('2');
  await row.getByRole('button', { name: `הצגת ציוד של ${seed.borrower.fullName}` }).click();
  await row.getByRole('button', { name: `פתיחת כרטיס שואל — ${seed.borrower.fullName}` }).click();
  const card = page.getByRole('dialog', { name: /כרטיס שואל/ });
  const holding = card.getByRole('rowheader', { name: seed.item.name }).locator('..');
  await holding.getByRole('button', { name: 'החזרת ציוד' }).click();
  const quantity = page.getByRole('dialog', { name: 'החזרת ציוד' });
  await quantity.getByRole('spinbutton', { name: 'כמות' }).fill('1');
  await quantity.getByRole('button', { name: 'אישור' }).click();
  await card.getByRole('button', { name: 'אישור פעולות' }).click();
  const review = page.getByRole('dialog', { name: 'אישור פעולות' });
  await review.getByRole('button', { name: 'אישור ושמירה' }).click();
  await expect(card).toBeHidden();
  await expect(search).toHaveValue(seed.borrower.playaName);
  await expect(
    row.getByRole('button', { name: `הסתרת ציוד של ${seed.borrower.fullName}` }),
  ).toBeVisible();
  await expect(row.locator('td').nth(4)).toHaveText('1');
  await expect(
    row.getByRole('button', { name: `פתיחת כרטיס שואל — ${seed.borrower.fullName}` }),
  ).toBeFocused();
});

test('keeps a staged card open when exit is canceled, then returns after confirmed discard', async ({
  page,
  seed,
}) => {
  await page.goto('/summary');
  const search = page.getByRole('searchbox', { name: 'חיפוש שואל' });
  await search.fill(seed.borrower.playaName);
  const row = page
    .locator('.period-summary-table tbody tr')
    .filter({ hasText: seed.borrower.fullName })
    .first();
  await row.getByRole('button', { name: `פתיחת כרטיס שואל — ${seed.borrower.fullName}` }).click();
  const card = page.getByRole('dialog', { name: /כרטיס שואל/ });
  const holding = card.getByRole('rowheader', { name: seed.item.name }).locator('..');
  await holding.getByRole('button', { name: 'החזרת ציוד' }).click();
  const quantity = page.getByRole('dialog', { name: 'החזרת ציוד' });
  await quantity.getByRole('spinbutton', { name: 'כמות' }).fill('1');
  await quantity.getByRole('button', { name: 'אישור' }).click();
  await card.getByRole('button', { name: 'סגירה' }).last().click();
  const discard = page.getByRole('alertdialog', { name: 'ביטול פעולות ממתינות?' });
  await discard.getByRole('button', { name: 'המשך עבודה' }).click();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'סגירה' }).last().click();
  await discard.getByRole('button', { name: 'מחיקת הפעולות וסגירה' }).click();
  await expect(card).toBeHidden();
  await expect(search).toHaveValue(seed.borrower.playaName);
  await expect(row.locator('td').nth(4)).toHaveText('2');
});

test('keeps a committed card open through failed snapshot refresh and returns after retry', async ({
  page,
  seed,
  openLedger,
}) => {
  await page.goto('/summary');
  const search = page.getByRole('searchbox', { name: 'חיפוש שואל' });
  await search.fill(seed.borrower.playaName);
  const row = page
    .locator('.period-summary-table tbody tr')
    .filter({ hasText: seed.borrower.fullName })
    .first();
  await row.getByRole('button', { name: `פתיחת כרטיס שואל — ${seed.borrower.fullName}` }).click();
  const card = page.getByRole('dialog', { name: /כרטיס שואל/ });
  await expect(card.getByText(seed.borrower.playaName, { exact: true })).toBeVisible();
  let failRefresh = true;
  await page.route(`**/api/borrowers/${seed.borrower.id}/desk-snapshot`, async (route) => {
    if (failRefresh) {
      failRefresh = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"temporary"}',
      });
    } else await route.fallback();
  });
  const holding = card.getByRole('rowheader', { name: seed.item.name }).locator('..');
  await holding.getByRole('button', { name: 'החזרת ציוד' }).click();
  const quantity = page.getByRole('dialog', { name: 'החזרת ציוד' });
  await quantity.getByRole('spinbutton', { name: 'כמות' }).fill('1');
  await quantity.getByRole('button', { name: 'אישור' }).click();
  await card.getByRole('button', { name: 'אישור פעולות' }).click();
  await page
    .getByRole('dialog', { name: 'אישור פעולות' })
    .getByRole('button', { name: 'אישור ושמירה' })
    .click();
  const retry = card.getByRole('button', { name: 'אימות נתוני האמת מחדש' });
  await expect(retry).toBeVisible();
  await expect(card).toBeVisible();
  await expect(row.locator('td').nth(4)).toHaveText('2');
  await retry.click();
  await expect(card).toBeHidden();
  await expect(search).toHaveValue(seed.borrower.playaName);
  await expect(row.locator('td').nth(4)).toHaveText('1');
  const returns = openLedger()
    .prepare("SELECT quantity FROM inventory_events WHERE kind='returned_usable' AND borrower_id=?")
    .all(seed.borrower.id);
  expect(returns).toEqual([{ quantity: 1 }]);
});

test('returning today from a historical-period card leaves that period unchanged', async ({
  page,
  request,
  seed,
}) => {
  const response = await request.post(
    `/__e2e__/period-summary/history/${seed.borrower.id}/${seed.item.id}`,
  );
  expect(response.ok()).toBeTruthy();
  const { date } = (await response.json()) as { date: string };
  await page.goto('/summary');
  await page.locator('.period-summary-advanced summary').click();
  await page.getByLabel('מתאריך').fill(date);
  await page.getByLabel('עד תאריך').fill(date);
  const search = page.getByRole('searchbox', { name: 'חיפוש שואל' });
  await search.fill(seed.borrower.playaName);
  const row = page
    .locator('.period-summary-table tbody tr')
    .filter({ hasText: seed.borrower.fullName })
    .first();
  await expect(row.locator('td').nth(4)).toHaveText('2');
  let historicalReads = 0;
  page.on('response', (read) => {
    const url = new URL(read.url());
    if (
      url.pathname === '/api/period-summary' &&
      url.searchParams.get('start') === date &&
      url.searchParams.get('end') === date
    )
      historicalReads += 1;
  });
  await row.getByRole('button', { name: `פתיחת כרטיס שואל — ${seed.borrower.fullName}` }).click();
  const card = page.getByRole('dialog', { name: /כרטיס שואל/ });
  const holding = card.getByRole('rowheader', { name: seed.item.name }).locator('..');
  await holding.getByRole('button', { name: 'החזרת ציוד' }).click();
  const quantity = page.getByRole('dialog', { name: 'החזרת ציוד' });
  await quantity.getByRole('spinbutton', { name: 'כמות' }).fill('1');
  await quantity.getByRole('button', { name: 'אישור' }).click();
  await card.getByRole('button', { name: 'אישור פעולות' }).click();
  await page
    .getByRole('dialog', { name: 'אישור פעולות' })
    .getByRole('button', { name: 'אישור ושמירה' })
    .click();
  await expect(card).toBeHidden();
  await expect.poll(() => historicalReads).toBeGreaterThan(0);
  await expect(page.getByLabel('מתאריך')).toHaveValue(date);
  await expect(page.getByLabel('עד תאריך')).toHaveValue(date);
  await expect(search).toHaveValue(seed.borrower.playaName);
  await expect(row.locator('td').nth(4)).toHaveText('2');
});

test('switches between all ledger history and today while keeping borrower search', async ({
  page,
  request,
  seed,
}) => {
  const response = await request.post(
    `/__e2e__/period-summary/history/${seed.borrower.id}/${seed.item.id}`,
  );
  expect(response.ok()).toBeTruthy();
  await page.goto('/summary');
  const search = page.getByRole('searchbox', { name: 'חיפוש שואל' });
  await search.fill(seed.borrower.playaName);
  const row = page
    .locator('.period-summary-table tbody tr')
    .filter({ hasText: seed.borrower.fullName })
    .first();
  await expect(page.getByLabel('מתאריך')).toBeHidden();
  await expect(row.locator('td').nth(4)).toHaveText('2');
  await page.getByRole('button', { name: 'הכל', exact: true }).click();
  await expect(row.locator('td').nth(4)).toHaveText('4');
  await expect(search).toHaveValue(seed.borrower.playaName);
  await expect(page.locator('.period-summary-selection')).toContainText('הכל עד');
  await expect(page.locator('.period-summary')).not.toContainText('0001-01-01');
  await page.getByRole('button', { name: 'היום', exact: true }).click();
  await expect(row.locator('td').nth(4)).toHaveText('2');
  await expect(search).toHaveValue(seed.borrower.playaName);
  const disclosure = page.locator('.period-summary-advanced summary');
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('מתאריך')).toBeVisible();
  await expect(page.getByLabel('עד תאריך')).toBeVisible();
});
