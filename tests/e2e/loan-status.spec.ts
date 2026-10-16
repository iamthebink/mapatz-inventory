import { expect, test } from './fixtures';

test('offers visible startup retry when returning to loans after workflow initialization fails', async ({
  page,
  seed,
}) => {
  await page.goto('/');
  await expect(page.getByRole('searchbox', { name: 'חיפוש שואל' })).toBeVisible();
  await page.getByRole('button', { name: 'מצב השאלות' }).click();
  await expect(
    page.getByRole('button', { name: `פתיחת כרטיס שואל — ${seed.borrower.fullName}` }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'ניהול' }).click();
  let fail = true;
  await page.route('**/api/borrowers/search?*', async (route) => {
    if (fail)
      await route.fulfill({ status: 503, json: { error: 'unavailable', message: 'טעינה נכשלה' } });
    else await route.continue();
  });
  await page.getByRole('link', { name: 'בר ההשאלות' }).click();
  const retry = page.getByRole('button', { name: 'ניסיון טעינה מחדש', exact: true });
  await expect(retry).toBeVisible();
  await expect(
    page.getByRole('button', { name: `פתיחת כרטיס שואל — ${seed.borrower.fullName}` }),
  ).toHaveCount(0);
  fail = false;
  await retry.click();
  await expect(
    page.getByRole('button', { name: `פתיחת כרטיס שואל — ${seed.borrower.fullName}` }),
  ).toBeVisible();
});

test('recovers a failed card load through safe close and retry from a loans row', async ({
  page,
  seed,
}) => {
  let loansReads = 0;
  await page.route('**/api/loans', async (route) => {
    loansReads += 1;
    await route.continue();
  });
  let fail = true;
  await page.route(`**/api/borrowers/${seed.borrower.id}/desk-snapshot`, async (route) => {
    if (fail)
      await route.fulfill({
        status: 503,
        json: { error: 'unavailable', message: 'טעינת כרטיס נכשלה' },
      });
    else await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('searchbox', { name: 'חיפוש שואל' })).toBeVisible();
  await page.getByRole('button', { name: 'מצב השאלות' }).click();
  const status = page.getByRole('region', { name: 'מצב השאלות' });
  const search = status.getByRole('textbox', { name: 'סינון הטבלה' });
  await search.fill(seed.borrower.fullName);
  const borrower = status.getByRole('button', {
    name: `פתיחת כרטיס שואל — ${seed.borrower.fullName}`,
  });
  await expect(borrower).toBeVisible();
  const initialReads = loansReads;
  await borrower.click();
  const card = page.getByRole('dialog', { name: `כרטיס שואל — ${seed.borrower.fullName}` });
  await expect(card.locator('.borrower-identity-meta')).toHaveText(seed.borrower.fullName);
  await card.getByRole('button', { name: 'סגירה בטוחה' }).click();
  await expect(borrower).toBeFocused();
  await expect(search).toHaveValue(seed.borrower.fullName);
  expect(loansReads).toBe(initialReads + 1);
  await borrower.click();
  const retry = card.getByRole('button', { name: 'ניסיון פתיחת הכרטיס מחדש' });
  await expect(retry).toBeVisible();
  fail = false;
  await retry.click();
  await expect(card.getByText(seed.borrower.playaName, { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'סגירה', exact: true }).last().click();
  await expect(borrower).toBeFocused();
  expect(loansReads).toBe(initialReads + 2);
});

for (const width of [1280, 320]) {
  test(`searches current loans and refreshes after a return at ${width}px`, async ({
    page,
    request,
    seed,
  }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/');
    await expect(page.getByRole('searchbox', { name: 'חיפוש שואל' })).toBeVisible();
    await page.getByRole('button', { name: 'מצב השאלות' }).click();
    const status = page.getByRole('region', { name: 'מצב השאלות' });
    await expect(status).toBeVisible();
    await expect(status.getByRole('columnheader')).toHaveText([
      'שואל',
      'פריט',
      'כמות',
      'תאריך השאלה',
    ]);
    const search = status.getByRole('textbox', { name: 'סינון הטבלה' });
    await search.fill(seed.borrower.fullName);
    const row = status.getByRole('row').filter({ hasText: seed.item.name });
    await expect(row).toBeVisible();
    await expect(row.getByRole('cell').nth(2)).toHaveText('2');
    const date = await row.getByRole('cell').nth(3).innerText();
    await search.fill(seed.item.name);
    await expect(row).toBeVisible();
    await search.fill(date);
    await expect(row).toBeVisible();
    await search.fill('אין התאמה');
    await expect(status.getByText('לא נמצאו השאלות להצגה')).toBeVisible();
    await status.getByRole('button', { name: 'ניקוי סינון' }).click();
    await expect(row).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );

    const locationsResponse = await request.get('/api/locations?all=1');
    expect(locationsResponse.ok()).toBeTruthy();
    const locations = (await locationsResponse.json()) as Array<{ id: number; isDefault: boolean }>;
    const returned = await request.post('/api/return', {
      data: {
        checkoutId: seed.checkoutId,
        locationId: locations.find((location) => location.isDefault)!.id,
        usable: 2,
        damaged: 0,
      },
    });
    expect(returned.ok()).toBeTruthy();
    await search.fill(seed.borrower.fullName);
    await status.getByRole('button', { name: 'רענון' }).click();
    await expect(search).toHaveValue(seed.borrower.fullName);
    await expect(row).toHaveCount(0);
    await expect(status.getByText('לא נמצאו השאלות להצגה')).toBeVisible();
    await page.getByRole('button', { name: 'השאלות והחזרות' }).click();
    await page.getByRole('button', { name: 'מצב השאלות' }).click();
    await search.fill(seed.borrower.fullName);
    await expect(row).toHaveCount(0);
  });
}

for (const width of [1280, 320]) {
  test(`opens the borrower card and updates quantities after partial and full returns at ${width}px`, async ({
    page,
    seed,
  }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/');
    await expect(page.getByRole('searchbox', { name: 'חיפוש שואל' })).toBeVisible();
    await page.getByRole('button', { name: 'מצב השאלות' }).click();
    const status = page.getByRole('region', { name: 'מצב השאלות' });
    const search = status.getByRole('textbox', { name: 'סינון הטבלה' });
    await search.fill(seed.borrower.fullName);
    const row = status.getByRole('row').filter({ hasText: seed.item.name });
    const borrower = row.getByRole('button', {
      name: `פתיחת כרטיס שואל — ${seed.borrower.fullName}`,
    });
    await expect(row.getByRole('cell').nth(2)).toHaveText('2');

    for (const remaining of [1, 0]) {
      await borrower.click();
      const card = page.getByRole('dialog', { name: `כרטיס שואל — ${seed.borrower.fullName}` });
      await expect(card.getByText(seed.borrower.playaName, { exact: true })).toBeVisible();
      const holding = card.getByRole('rowheader', { name: seed.item.name }).locator('..');
      await holding.getByRole('button', { name: 'החזרת ציוד' }).click();
      const quantity = page.getByRole('dialog', { name: 'החזרת ציוד' });
      await quantity.getByRole('spinbutton', { name: 'כמות', exact: true }).fill('1');
      await quantity.getByRole('button', { name: 'אישור', exact: true }).click();
      await card.getByRole('button', { name: 'אישור פעולות' }).click();
      const review = page.getByRole('dialog', { name: 'אישור פעולות' });
      await review.getByRole('button', { name: 'אישור ושמירה' }).click();
      await expect(card).toBeHidden();
      await expect(search).toHaveValue(seed.borrower.fullName);
      await expect(page.getByRole('button', { name: 'מצב השאלות', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      if (remaining) {
        await expect(row.getByRole('cell').nth(2)).toHaveText('1');
        await expect(borrower).toBeFocused();
      } else {
        await expect(row).toHaveCount(0);
        await expect(status.getByRole('heading', { name: 'מצב השאלות' })).toBeFocused();
      }
    }
  });
}
