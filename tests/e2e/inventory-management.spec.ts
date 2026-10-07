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
  await dialog.getByRole('combobox', { name: /^מיקום/ }).selectOption('1');
  await dialog.getByRole('textbox', { name: 'זמין' }).fill('5');
  await dialog.getByRole('button', { name: 'שמירה' }).click();
  await expect(dialog).toBeHidden();

  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name, exact: true }) });
  await expect(row).toContainText('5');
  await row.getByRole('button', { name }).click();
  dialog = page.getByRole('dialog', { name: 'עריכת פריט' });
  await dialog.getByRole('combobox', { name: /^מיקום/ }).selectOption('1');
  await dialog.getByRole('textbox', { name: 'זמין' }).fill('2');
  await expect(dialog).toContainText('התאמה: -3');
  await dialog.getByRole('button', { name: 'שמירה' }).click();
  await expect(dialog).toBeHidden();

  await row.getByRole('button', { name }).click();
  dialog = page.getByRole('dialog', { name: 'עריכת פריט' });
  await dialog.getByRole('combobox', { name: /^מיקום/ }).selectOption('1');
  await dialog.getByRole('textbox', { name: 'זמין' }).fill('0');
  await dialog.getByRole('button', { name: 'שמירה' }).click();
  await expect(dialog).toBeHidden();
  await row.getByRole('button', { name }).click();
  dialog = page.getByRole('dialog', { name: 'עריכת פריט' });
  await dialog.getByText('פעולות נוספות').click();
  await dialog.getByRole('button', { name: 'העברה לארכיון' }).click();
  await page
    .getByRole('alertdialog', { name: 'לארכב את פריט ניהול בדיקה?' })
    .getByRole('button', {
      name: 'ארכוב ואיפוס מלאי זמין',
    })
    .click();
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
    data: { checkoutId: seed.checkoutId, usable: 0, damaged: 2, locationId: 1 },
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
  await dialog.getByLabel('מיקום הפגומים').selectOption('1');
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

test('transfer respects dirty decisions and stale refresh before moving the selected condition between distinct locations', async ({
  page,
  seed,
  openLedger,
}) => {
  await page.request.post('/api/session/role', {
    data: { role: 'admin', password: 'e2e-admin-password' },
  });
  const damaged = await page.request.post('/api/return', {
    data: { checkoutId: seed.checkoutId, usable: 0, damaged: 2, locationId: 1 },
  });
  expect(damaged.ok()).toBeTruthy();
  const created = await page.request.post('/api/locations', {
    data: { code: `transfer-${seed.item.id}`, name: `Transfer destination ${seed.item.id}` },
  });
  expect(created.ok()).toBeTruthy();
  const destination = (await created.json()) as { id: number; name: string; code: string };
  await page.goto('/management');
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: seed.item.name, exact: true }) });
  await row.getByRole('button', { name: seed.item.name, exact: true }).click();
  let details = page.getByRole('dialog', { name: 'עריכת פריט' });
  await details.getByLabel('שם פריט').fill(seed.item.name + ' draft');
  await details.getByRole('button', { name: 'העברת מלאי בין מיקומים' }).click();
  await page.getByRole('button', { name: 'להמשיך לערוך' }).click();
  await expect(details.getByLabel('שם פריט')).toHaveValue(seed.item.name + ' draft');
  await details.getByRole('button', { name: 'העברת מלאי בין מיקומים' }).click();
  await page.getByRole('button', { name: 'ביטול השינויים' }).click();
  const fill = async () => {
    const dialog = page.getByRole('dialog', { name: 'העברת מלאי' });
    await dialog.getByLabel('מיקום מקור').selectOption('1');
    await dialog.getByLabel('מיקום יעד').selectOption(String(destination.id));
    await dialog.getByLabel('מצב').selectOption('damaged');
    await dialog.getByLabel('כמות').fill('1');
    await dialog.getByLabel('הערה', { exact: true }).fill('selected damage');
    return dialog;
  };
  let dialog = await fill();
  await dialog.getByRole('button', { name: 'ביטול', exact: true }).click();
  await page.getByRole('button', { name: 'להמשיך לערוך' }).click();
  await expect(dialog.getByLabel('מצב')).toHaveValue('damaged');
  const requests: Array<{
    sourceLocationId: number;
    destinationLocationId: number;
    condition: string;
    stockRevision: number;
  }> = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/inventory/transfer') && request.method() === 'POST')
      requests.push(request.postDataJSON());
  });
  const added = await page.request.post('/api/stock/add', {
    data: { itemId: seed.item.id, locationId: 1, quantity: 1, note: 'concurrent count' },
  });
  expect(added.ok()).toBeTruthy();
  await dialog.getByRole('button', { name: 'העברה', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('המלאי השתנה', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: seed.item.name, exact: true }).click();
  details = page.getByRole('dialog', { name: 'עריכת פריט' });
  await details.getByRole('button', { name: 'העברת מלאי בין מיקומים' }).click();
  dialog = await fill();
  await dialog.getByRole('button', { name: 'העברה', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    sourceLocationId: 1,
    destinationLocationId: destination.id,
    condition: 'damaged',
  });
  expect(requests[1]!.stockRevision).toBeGreaterThan(requests[0]!.stockRevision);
  const db = openLedger();
  expect(
    db
      .prepare(
        'SELECT location_id locationId,available,damaged FROM item_location_balances WHERE item_id=? ORDER BY location_id',
      )
      .all(seed.item.id),
  ).toEqual([
    { locationId: 1, available: 5, damaged: 1 },
    { locationId: destination.id, available: 0, damaged: 1 },
  ]);
  expect(
    db
      .prepare(
        "SELECT kind,quantity,location_name,location_code FROM inventory_events WHERE item_id=? AND kind IN ('damaged_transferred_out','damaged_transferred_in') ORDER BY id",
      )
      .all(seed.item.id),
  ).toEqual([
    {
      kind: 'damaged_transferred_out',
      quantity: 1,
      location_name: 'מפלצת',
      location_code: 'monster',
    },
    {
      kind: 'damaged_transferred_in',
      quantity: 1,
      location_name: destination.name,
      location_code: destination.code,
    },
  ]);
});
