import { expect, test } from './fixtures';

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
    await expect(status.getByRole('columnheader')).toHaveText(['פריט', 'שואל', 'תאריך השאלה']);
    const search = status.getByRole('textbox', { name: 'סינון הטבלה' });
    await search.fill(seed.borrower.fullName);
    const row = status.getByRole('row').filter({ hasText: seed.item.name });
    await expect(row).toBeVisible();
    const date = await row.getByRole('cell').nth(2).innerText();
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
