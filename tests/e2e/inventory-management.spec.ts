import { expect, test } from './fixtures';

test('inventory search and filters share a desktop row and stack on narrow screens', async ({
  page,
}) => {
  await page.goto('/management');
  const search = page.getByRole('textbox', { name: 'סינון הטבלה' });
  const type = page.getByRole('combobox', { name: 'סוג' });
  await expect(search).toBeVisible();
  const desktopSearch = await search.boundingBox();
  const desktopType = await type.boundingBox();
  expect(desktopSearch).not.toBeNull();
  expect(desktopType).not.toBeNull();
  expect(Math.abs(desktopSearch!.y - desktopType!.y)).toBeLessThan(8);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileSearch = await search.boundingBox();
  const mobileType = await type.boundingBox();
  expect(mobileSearch).not.toBeNull();
  expect(mobileType).not.toBeNull();
  expect(mobileType!.y).toBeGreaterThan(mobileSearch!.y + mobileSearch!.height);
});

test('administrator creates, adjusts, zeros and archives an item', async ({ page, openLedger }) => {
  await page.goto('/management');
  await page.getByRole('button', { name: 'הפעל מצב מנהל' }).click();
  const authentication = page.getByRole('dialog', { name: 'הפעלת מצב מנהל' });
  await authentication.locator('input[name="password"]').fill('e2e-admin-password');
  await authentication.getByRole('button', { name: 'הפעל מצב מנהל' }).click();

  const name = 'פריט ניהול בדיקה';
  await page.getByRole('button', { name: 'הוספת פריט חדש' }).click();
  let dialog = page.getByRole('dialog', { name: 'הוספת פריט חדש' });
  await dialog.getByRole('textbox', { name: 'שם פריט' }).fill(name);
  await dialog.getByRole('textbox', { name: 'זמין' }).fill('5');
  await dialog.getByRole('button', { name: 'שמירה' }).click();
  await expect(dialog).toBeHidden();

  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name, exact: true }) });
  await expect(row).toContainText('5');
  await row.getByRole('button', { name }).click();
  dialog = page.getByRole('dialog', { name: 'עריכת פריט' });
  await dialog.getByRole('textbox', { name: 'זמין' }).fill('2');
  await expect(dialog).toContainText('התאמה: -3');
  await dialog.getByRole('button', { name: 'שמירה' }).click();
  await expect(dialog).toBeHidden();

  await row.getByRole('button', { name }).click();
  dialog = page.getByRole('dialog', { name: 'עריכת פריט' });
  await dialog.getByRole('textbox', { name: 'זמין' }).fill('0');
  await dialog.getByRole('button', { name: 'שמירה' }).click();
  await expect(dialog).toBeHidden();
  await row.getByRole('button', { name }).click();
  dialog = page.getByRole('dialog', { name: 'עריכת פריט' });
  await dialog.getByRole('button', { name: 'העברה לארכיון' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'כולל ארכיון' }).check();
  await expect(page.getByRole('button', { name: `${name} (בארכיון)` })).toBeVisible();

  const database = openLedger();
  const events = database
    .prepare(
      `SELECT e.kind,e.quantity FROM inventory_events e
       JOIN items i ON i.id=e.item_id WHERE i.name=? ORDER BY e.id`,
    )
    .all(name);
  expect(events).toMatchObject([
    { kind: 'stock_added', quantity: 5 },
    { kind: 'stock_removed', quantity: 3 },
    { kind: 'stock_removed', quantity: 2 },
  ]);
});

test('operator inspects stock and restores damaged units', async ({ page, seed, openLedger }) => {
  const returned = await page.request.post('/api/return', {
    data: { checkoutId: seed.checkoutId, usable: 0, damaged: 2 },
  });
  expect(returned.ok()).toBeTruthy();
  await page.goto('/management');
  await expect(page.getByRole('button', { name: 'הוספת פריט חדש' })).toBeDisabled();
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: seed.item.name, exact: true }) });
  await row.getByRole('button', { name: seed.item.name }).click();
  let dialog = page.getByRole('dialog', { name: 'עריכת פריט' });
  await expect(dialog.getByRole('textbox', { name: 'זמין' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'שמירה' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'ביטול' }).click();

  await row.getByRole('button', { name: 'טיפול בפגומים' }).click();
  dialog = page.getByRole('dialog', { name: 'טיפול בפגומים' });
  await expect(dialog).toContainText('פגום: 2');
  await expect(dialog.getByRole('option', { name: 'גריעה קבועה' })).toHaveAttribute('disabled', '');
  await dialog.getByRole('spinbutton', { name: 'כמות' }).fill('1');
  await dialog.getByRole('button', { name: 'שמירה' }).click();
  await expect(dialog).toBeHidden();

  const database = openLedger();
  expect(
    database
      .prepare("SELECT kind,quantity FROM inventory_events WHERE item_id=? AND kind='repaired'")
      .all(seed.item.id),
  ).toMatchObject([{ kind: 'repaired', quantity: 1 }]);
});
