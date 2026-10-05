import { expect, test } from './fixtures';

test('borrower mixed save shows sources and destination while keeping one holding identity', async ({
  page,
  seed,
  openLedger,
}) => {
  await page.request.post('/api/session/role', {
    data: { role: 'admin', password: 'e2e-admin-password' },
  });
  const created = await page.request.post('/api/locations', {
    data: { code: `cross-${seed.item.id}`, name: `Container B ${seed.item.id}` },
  });
  expect(created.ok()).toBeTruthy();
  const destination = (await created.json()) as { id: number; name: string };
  await page.request.post('/api/session/role', { data: { role: 'operator' } });
  await page.goto('/frontdesk');
  await page.getByRole('searchbox', { name: 'חיפוש שואל' }).fill(seed.borrower.playaName);
  await page
    .locator('.borrower-directory-row')
    .filter({ has: page.getByText(seed.borrower.playaName, { exact: true }) })
    .getByRole('button', { name: /פתיחת כרטיס שואל/ })
    .click();
  const holdings = page.getByRole('heading', { name: /ציוד אצל השואל/ }).locator('..');
  const holding = holdings
    .getByRole('rowheader', { name: seed.item.name, exact: true })
    .locator('..');
  await holding.getByRole('button', { name: 'החזרת ציוד' }).press('Enter');
  const returned = page.getByRole('dialog', { name: 'החזרת ציוד' });
  await returned.getByLabel('מיקום קבלה').selectOption(String(destination.id));
  await returned.getByRole('spinbutton', { name: 'כמות' }).fill('1');
  await returned.getByRole('button', { name: 'אישור' }).click();
  const search = page.getByRole('combobox', { name: 'חיפוש פריט' });
  await search.fill(seed.item.name);
  await search.press('ArrowDown');
  await search.press('Enter');
  const borrowed = page.getByRole('dialog', { name: 'הוספת השאלה' });
  await borrowed.getByLabel('מיקום מקור').selectOption('1');
  await borrowed.getByRole('spinbutton', { name: 'כמות' }).fill('1');
  await borrowed.getByRole('button', { name: 'אישור' }).click();
  await expect(page.locator('.staged-section')).toContainText(destination.name);
  await expect(page.locator('.staged-section')).toContainText('מפלצת');
  await expect(holdings.getByRole('rowheader', { name: seed.item.name, exact: true })).toHaveCount(
    1,
  );
  await page.getByRole('button', { name: 'אישור פעולות', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'אישור פעולות' });
  await expect(review).toContainText(destination.name);
  await expect(review).toContainText('מפלצת');
  await review.getByRole('button', { name: 'אישור ושמירה' }).click();
  await expect(page.getByRole('dialog', { name: /כרטיס שואל/ })).toBeHidden();
  const db = openLedger();
  expect(
    db
      .prepare(
        'SELECT location_id locationId,available,damaged FROM item_location_balances WHERE item_id=? ORDER BY location_id',
      )
      .all(seed.item.id),
  ).toEqual([
    { locationId: 1, available: 3, damaged: 0 },
    { locationId: destination.id, available: 1, damaged: 0 },
  ]);
  expect(
    db
      .prepare(
        'SELECT SUM(outstanding) outstanding FROM loan_state WHERE item_id=? AND borrower_id=?',
      )
      .get(seed.item.id, seed.borrower.id),
  ).toEqual({ outstanding: 2 });
});
