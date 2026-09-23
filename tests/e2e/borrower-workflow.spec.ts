import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

test('opens the borrower desk directly through the frontdesk alias', async ({ page }) => {
  await page.goto('/frontdesk');

  await expect(page).toHaveURL(/\/frontdesk$/);
  await expect(page.getByRole('heading', { name: 'דלפק השאלות' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'דלפק השאלות' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

async function openSeededCard(page: Page, username: string) {
  await page.goto('/inventory');
  await page.getByRole('link', { name: 'דלפק השאלות' }).click();
  const search = page.getByRole('searchbox', { name: 'חיפוש שואל' });
  await expect(search).toBeFocused();
  await search.fill(username);
  const row = page
    .locator('.borrower-directory-row')
    .filter({ has: page.getByText(username, { exact: true }) });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /פתיחת כרטיס שואל/ }).press('Enter');
  const card = page.getByRole('dialog', { name: /כרטיס שואל/ });
  await expect(card).toBeVisible();
  await expect(card.locator('.borrower-identity-meta')).toBeFocused();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  return search;
}

async function expectQuantityDialogItem(dialog: Locator, itemName: string) {
  await expect(dialog).toHaveAccessibleDescription(`פריט: ${itemName}`);
  const callout = dialog.locator('.quantity-dialog-item');
  const name = callout.locator('.quantity-dialog-item-name');
  await expect(callout).toBeVisible();
  await expect(name).toHaveText(itemName);
}

async function expectEmphasizedQuantityDialogItem(dialog: Locator, itemName: string) {
  await expectQuantityDialogItem(dialog, itemName);
  const callout = dialog.locator('.quantity-dialog-item');
  const name = callout.locator('.quantity-dialog-item-name');
  await expect(name).toHaveCSS('font-size', '24px');
  await expect(name).toHaveCSS('font-weight', '700');
  const presentation = await callout.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderWidth: Number.parseFloat(style.borderTopWidth),
      padding: Number.parseFloat(style.paddingTop),
    };
  });
  expect(presentation.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(presentation.borderWidth).toBeGreaterThanOrEqual(1);
  expect(presentation.padding).toBeGreaterThanOrEqual(12);
}

async function stageBorrow(page: Page, itemName: string, quantity = '1') {
  const itemSearch = page.getByRole('combobox', { name: 'חיפוש פריט' });
  await itemSearch.fill(itemName);
  await expect(page.getByRole('option', { name: new RegExp(itemName) })).toBeVisible();
  await itemSearch.press('ArrowDown');
  await itemSearch.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'הוספת השאלה' });
  await expectQuantityDialogItem(dialog, itemName);
  await expect(page.locator('#dialog-stack-root > *')).toHaveCount(2);
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await dialog.getByRole('spinbutton', { name: 'כמות' }).fill(quantity);
  await dialog.getByRole('button', { name: 'אישור' }).click();
  await expect(page.locator('#dialog-stack-root > *')).toHaveCount(1);
}

async function stageReturn(page: Page, itemName: string, usable = '1', damaged = '0') {
  const holdings = page.getByRole('heading', { name: /ציוד אצל השואל/ }).locator('..');
  const itemRow = holdings.getByRole('rowheader', { name: itemName, exact: true }).locator('..');
  // Keyboard activation avoids the open item-search list overlapping this row after a borrow.
  for (const [quantity, isDamaged] of [
    [usable, false],
    [damaged, true],
  ] as const) {
    if (Number(quantity) <= 0) continue;
    await itemRow.getByRole('button', { name: 'החזרת ציוד' }).press('Enter');
    const dialog = page.getByRole('dialog', { name: 'החזרת ציוד' });
    await expectQuantityDialogItem(dialog, itemName);
    const checkbox = dialog.getByRole('checkbox', { name: 'הציוד הוחזר פגום' });
    await expect(checkbox).not.toBeChecked();
    if (isDamaged) await checkbox.check();
    await dialog.getByRole('spinbutton', { name: 'כמות' }).fill(quantity);
    await dialog.getByRole('button', { name: 'אישור' }).click();
    await expect(dialog).toBeHidden();
  }
}

async function confirmSave(page: Page) {
  await page.getByRole('button', { name: 'אישור פעולות' }).click();
  const review = page.getByRole('dialog', { name: 'אישור פעולות' });
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'אישור ושמירה' }).click();
}

function rows<T extends Record<string, unknown>>(
  database: DatabaseSync,
  sql: string,
  ...args: SQLInputValue[]
) {
  return database.prepare(sql).all(...args) as T[];
}

test('browses, filters, and opens the responsive borrower directory without dialog navigation', async ({
  page,
  seed,
}) => {
  await page.goto('/inventory');
  await page.getByRole('link', { name: 'דלפק השאלות' }).click();
  const search = page.getByRole('searchbox', { name: 'חיפוש שואל' });
  const create = page.getByRole('button', { name: 'יצירת שואל חדש' });
  const header = page.locator('.borrower-workflow-header');
  await expect(search).toBeFocused();
  await expect(
    page
      .locator('.borrower-directory-row')
      .filter({ has: page.getByText(seed.borrower.username, { exact: true }) }),
  ).toBeVisible();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'יצירת שואל חדש' })).toBeVisible();
  await expect(page.locator('.borrower-search-row').getByRole('button')).toHaveCount(0);

  await search.fill(seed.archivedBorrower.username);
  const archivedNotice = page.getByRole('complementary', { name: 'התאמות בארכיון' });
  await expect(archivedNotice).toContainText(seed.archivedBorrower.name);
  await expect(archivedNotice.getByRole('button')).toHaveCount(0);

  await search.fill(seed.borrower.username);
  const activeRow = page
    .locator('.borrower-directory-row')
    .filter({ has: page.getByText(seed.borrower.username, { exact: true }) });
  await expect(activeRow).toBeVisible();
  await page.setViewportSize({ width: 320, height: 720 });
  const [headingBox, createBox] = await Promise.all([
    page.getByRole('heading', { name: 'דלפק השאלות' }).boundingBox(),
    create.boundingBox(),
  ]);
  expect(createBox!.y).toBeGreaterThan(headingBox!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await activeRow.getByRole('button', { name: /פתיחת כרטיס שואל/ }).press('Space');
  const card = page.getByRole('dialog', { name: /כרטיס שואל/ });
  await expect(card).toBeVisible();
  const workspaceBox = await card.locator('.borrower-workspace').boundingBox();
  const itemSearchBox = await card.locator('.borrower-item-search').boundingBox();
  expect(itemSearchBox!.width / workspaceBox!.width).toBeGreaterThan(0.66);
  expect(itemSearchBox!.width / workspaceBox!.width).toBeLessThan(0.67);
  expect(
    Math.abs(
      itemSearchBox!.x + itemSearchBox!.width / 2 - (workspaceBox!.x + workspaceBox!.width / 2),
    ),
  ).toBeLessThan(2);
  await expect(card.getByText('מעבר למסך אחר')).toHaveCount(0);
  await card.getByRole('button', { name: 'סגירה', exact: true }).last().click();
  await expect(card).toBeHidden();
  await create.click();
  const createDialog = page.getByRole('dialog', { name: 'יצירת שואל חדש' });
  await expect(createDialog.getByText('מעבר למסך אחר')).toHaveCount(0);
});

test('keeps an emphasized maximum-length item identity legible at minimum width', async ({
  page,
  request,
  seed,
}) => {
  const longItemName =
    `${seed.item.code} פריט VeryLongUnbrokenEquipmentIdentifierABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789`.slice(
      0,
      100,
    );
  await request.post('/api/session/role', {
    data: { role: 'admin', password: 'e2e-admin-password' },
  });
  const created = await request.post('/api/items', {
    data: { name: longItemName, kind: 'non_consumable' },
  });
  expect(created.ok()).toBe(true);
  const createdItem = (await created.json()) as { id: number };
  const stocked = await request.post('/api/stock/add', {
    data: { itemId: createdItem.id, quantity: 1, note: '' },
  });
  expect(stocked.ok()).toBe(true);

  await page.setViewportSize({ width: 320, height: 720 });
  await openSeededCard(page, seed.borrower.username);
  const itemSearch = page.getByRole('combobox', { name: 'חיפוש פריט' });
  await itemSearch.fill(longItemName);
  await itemSearch.press('ArrowDown');
  await itemSearch.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'הוספת השאלה' });
  await expectEmphasizedQuantityDialogItem(dialog, longItemName);
  await expect(dialog.getByRole('button', { name: 'אישור' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'ביטול' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const [dialogBox, calloutBox] = await Promise.all([
    dialog.boundingBox(),
    dialog.locator('.quantity-dialog-item').boundingBox(),
  ]);
  expect(calloutBox!.width / dialogBox!.width).toBeGreaterThan(0.8);
});

test('commits a mixed reviewed save exactly once with deterministic ledger order', async ({
  page,
  seed,
  openLedger,
}) => {
  const borrowerSearch = await openSeededCard(page, seed.borrower.username);
  await stageBorrow(page, seed.item.name);
  await stageReturn(page, seed.item.name, '1', '1');

  const staged = page.getByRole('heading', { name: 'פעולות ממתינות' }).locator('..');
  await expect(staged.getByText('השאלה')).toBeVisible();
  await expect(staged.getByText(/החזרת ציוד · 1/)).toBeVisible();
  await expect(staged.getByText(/החזרת ציוד · פגום · 1/)).toBeVisible();
  await confirmSave(page);
  await expect(page.getByRole('dialog', { name: /כרטיס שואל/ })).toBeHidden();
  await expect(borrowerSearch).toBeFocused();
  await expect(borrowerSearch).toHaveValue('');
  await expect(page.locator('.toast')).toHaveCount(1);
  await expect(page.locator('.toast[role="status"]')).toContainText('השמירה הושלמה');

  const database = openLedger();
  const events = rows<{ kind: string; quantity: number; related_event_id: number | null }>(
    database,
    'SELECT kind,quantity,related_event_id FROM inventory_events WHERE borrower_id=? ORDER BY id',
    seed.borrower.id,
  );
  expect(events.map(({ kind }) => kind)).toEqual([
    'checked_out',
    'returned_usable',
    'returned_damaged',
    'checked_out',
  ]);
  expect(events.slice(1, 3).every((event) => event.related_event_id === seed.checkoutId)).toBe(
    true,
  );
  expect(
    rows<{ count: number }>(
      database,
      "SELECT COUNT(*) count FROM idempotency_receipts WHERE command_kind='borrower_operation' AND subject_id=?",
      seed.borrower.id,
    )[0]?.count,
  ).toBe(1);
});

test('stages loss and dependent found return from the borrower card with keyboard review', async ({
  page,
  seed,
  openLedger,
}) => {
  await openSeededCard(page, seed.borrower.username);
  const more = page.getByRole('button', { name: 'אפשרויות נוספות' });
  await expect(more).not.toContainText('…');
  await expect(page.getByRole('menuitem', { name: 'סמן כאבוד' })).toHaveCount(0);
  await more.press('ArrowDown');
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveCount(1);
  const markLost = menu.getByRole('menuitem', { name: 'סמן כאבוד' });
  await expect(markLost).toBeFocused();
  await markLost.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.press('Enter');
  await markLost.press('Enter');
  const lossDialog = page.getByRole('dialog', { name: 'סמן כאבוד' });
  await expectQuantityDialogItem(lossDialog, seed.item.name);
  await expect(lossDialog.getByRole('spinbutton', { name: 'כמות' })).toBeFocused();
  await expect(lossDialog.getByRole('spinbutton', { name: 'כמות' })).toHaveValue('1');
  await expect(lossDialog.getByRole('checkbox', { name: 'הציוד הוחזר פגום' })).toHaveCount(0);
  await expect(page.locator('.borrower-inline-editor')).toHaveCount(0);
  await expect(page.getByText('אין פעולות ממתינות')).toBeVisible();
  await lossDialog.getByRole('spinbutton', { name: 'כמות' }).fill('2');
  await lossDialog.getByRole('button', { name: 'אישור' }).click();
  const lostSummary = page.locator('.lost-equipment-section summary');
  await expect(lostSummary).toContainText('(2)');
  await expect(lostSummary).toHaveAccessibleName('ציוד אבוד של השואל, 2 יחידות');
  await expect(page.locator('.lost-equipment-section')).not.toHaveAttribute('open');
  const markerWidth = await lostSummary.evaluate((summary) =>
    parseFloat(getComputedStyle(summary, '::before').borderInlineStartWidth),
  );
  expect(markerWidth).toBeGreaterThan(0);
  const markerDirection = () =>
    lostSummary.evaluate((summary) => {
      const transform = getComputedStyle(summary, '::before').transform;
      return transform === 'none' ? 0 : Math.round(new DOMMatrixReadOnly(transform).b);
    });
  expect(await markerDirection()).toBe(0);

  await lostSummary.click();
  await expect.poll(markerDirection).toBe(-1);
  const lostTable = page.locator('.lost-equipment-section').getByRole('table');
  await expect(lostTable.getByRole('columnheader', { name: 'אבוד' })).toBeVisible();
  const lostRow = lostTable.getByRole('rowheader', { name: seed.item.name }).locator('..');
  await expect(lostRow.getByRole('cell').first()).toHaveText('2');
  await expect(lostRow.getByRole('rowheader')).toHaveCSS('vertical-align', 'middle');
  await expect(lostRow.getByRole('cell').first()).toHaveCSS('vertical-align', 'middle');
  await page.getByRole('button', { name: 'נמצא והוחזר' }).click();
  const foundDialog = page.getByRole('dialog', { name: 'נמצא והוחזר' });
  await expectQuantityDialogItem(foundDialog, seed.item.name);
  await expect(foundDialog.getByRole('checkbox', { name: 'הציוד הוחזר פגום' })).not.toBeChecked();
  await foundDialog.getByRole('spinbutton', { name: 'כמות' }).fill('2');
  await foundDialog.getByRole('button', { name: 'אישור' }).click();

  const pending = page.locator('.staged-section');
  const lossRow = pending.locator('.borrower-pending-row').filter({ hasText: 'סמן כאבוד' });
  await lossRow.getByRole('button', { name: 'ביטול פעולה' }).click();
  await expect(page.locator('.toast')).toContainText('יש לבטל תחילה');
  await expect(lossRow).toBeVisible();

  await page.getByRole('button', { name: 'אישור פעולות' }).press('Enter');
  const review = page.getByRole('dialog', { name: 'אישור פעולות' });
  await expect(review.getByText(/סמן כאבוד · 2/)).toBeVisible();
  await expect(review.getByText(/נמצא והוחזר · 2/)).toBeVisible();
  await review.getByRole('button', { name: 'אישור ושמירה' }).press('Enter');
  await expect(page.getByRole('dialog', { name: /כרטיס שואל/ })).toBeHidden();

  const database = openLedger();
  expect(
    rows<{ kind: string; quantity: number }>(
      database,
      "SELECT kind,quantity FROM inventory_events WHERE borrower_id=? AND item_id=? AND kind IN ('marked_lost','found_returned') ORDER BY id DESC LIMIT 2",
      seed.borrower.id,
      seed.item.id,
    ).reverse(),
  ).toEqual([
    { kind: 'marked_lost', quantity: 2 },
    { kind: 'found_returned', quantity: 2 },
  ]);
});

test('uses resettable damaged condition for held and lost returns at 320px', async ({
  page,
  seed,
  openLedger,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await openSeededCard(page, seed.borrower.username);
  const heldTable = page.locator('.holdings-section').getByRole('table');
  await expect(heldTable).toHaveAccessibleName('ציוד אצל השואל');
  const quantityHasRightBreathingRoom = (table: Locator) =>
    table
      .locator('tbody td:nth-child(2)')
      .first()
      .evaluate((cell) => {
        const style = getComputedStyle(cell);
        return parseFloat(style.paddingInlineStart) > parseFloat(style.paddingInlineEnd);
      });
  expect(await quantityHasRightBreathingRoom(heldTable)).toBe(true);
  expect(
    await heldTable
      .locator('th, td')
      .evaluateAll((cells) => cells.every((cell) => cell.scrollWidth <= cell.clientWidth)),
  ).toBe(true);
  const more = page.getByRole('button', { name: 'אפשרויות נוספות' });
  await more.press('ArrowDown');
  const menuItem = page.getByRole('menuitem', { name: 'סמן כאבוד' });
  await expect(menuItem).toBeFocused();
  const menuBox = await page.getByRole('menu').boundingBox();
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(320);
  await page.getByRole('heading', { name: 'פעולות ממתינות' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByText('אין פעולות ממתינות')).toBeVisible();

  const returnButton = page.getByRole('button', { name: 'החזרת ציוד' });
  await returnButton.click();
  const heldDialog = page.getByRole('dialog', { name: 'החזרת ציוד' });
  await expectEmphasizedQuantityDialogItem(heldDialog, seed.item.name);
  await expect(page.locator('#dialog-stack-root > *')).toHaveCount(2);
  await expect(heldDialog.getByRole('spinbutton', { name: 'כמות' })).toBeFocused();
  const heldCheckbox = heldDialog.getByRole('checkbox', { name: 'הציוד הוחזר פגום' });
  await expect(heldCheckbox).not.toBeChecked();
  await heldDialog.getByRole('spinbutton', { name: 'כמות' }).fill('0');
  await heldDialog.getByRole('button', { name: 'אישור' }).click();
  await expect(heldDialog.getByRole('alert')).toBeVisible();
  await expect(page.getByText('אין פעולות ממתינות')).toBeVisible();
  await heldDialog.getByRole('spinbutton', { name: 'כמות' }).fill('1');
  await heldCheckbox.check();
  await heldDialog.getByRole('button', { name: 'אישור' }).click();
  await expect(heldDialog).toBeHidden();
  await expect(page.getByText(/החזרת ציוד · פגום · 1/)).toBeVisible();
  await returnButton.click();
  await expect(heldCheckbox).not.toBeChecked();
  await heldDialog.getByRole('button', { name: 'ביטול' }).click();
  await expect(returnButton).toBeFocused();

  await more.press('ArrowDown');
  await menuItem.press('Enter');
  const lossDialog = page.getByRole('dialog', { name: 'סמן כאבוד' });
  await expect(lossDialog.getByRole('checkbox', { name: 'הציוד הוחזר פגום' })).toHaveCount(0);
  await lossDialog.getByRole('button', { name: 'אישור' }).click();
  await expect(page.locator('.lost-equipment-section summary')).toContainText('(1)');
  await page.locator('.lost-equipment-section summary').press('Enter');
  const lostTable = page.locator('.lost-equipment-section').getByRole('table');
  await expect(lostTable).toHaveAccessibleName(/ציוד אבוד של השואל/);
  expect(await quantityHasRightBreathingRoom(lostTable)).toBe(true);
  expect(
    await lostTable
      .locator('th, td')
      .evaluateAll((cells) => cells.every((cell) => cell.scrollWidth <= cell.clientWidth)),
  ).toBe(true);
  const found = page.getByRole('button', { name: 'נמצא והוחזר' });
  await found.press('Enter');
  const foundDialog = page.getByRole('dialog', { name: 'נמצא והוחזר' });
  await expectQuantityDialogItem(foundDialog, seed.item.name);
  const foundCheckbox = foundDialog.getByRole('checkbox', { name: 'הציוד הוחזר פגום' });
  await expect(foundCheckbox).not.toBeChecked();
  await foundCheckbox.check();
  await foundDialog.getByRole('button', { name: 'ביטול' }).click();
  await expect(found).toBeFocused();
  await found.press('Enter');
  await expect(foundCheckbox).not.toBeChecked();
  await foundCheckbox.check();
  await foundDialog.getByRole('button', { name: 'אישור' }).click();
  await expect(page.getByText(/נמצא והוחזר · פגום · 1/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByRole('button', { name: 'אישור פעולות' }).press('Enter');
  const review = page.getByRole('dialog', { name: 'אישור פעולות' });
  await expect(review.getByText(/החזרת ציוד · פגום · 1/)).toBeVisible();
  await expect(review.getByText(/נמצא והוחזר · פגום · 1/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await review.getByRole('button', { name: 'אישור ושמירה' }).press('Enter');

  const database = openLedger();
  expect(
    rows<{ kind: string; quantity: number }>(
      database,
      'SELECT kind,quantity FROM inventory_events WHERE related_event_id=? ORDER BY id',
      seed.checkoutId,
    ),
  ).toEqual([
    { kind: 'returned_damaged', quantity: 1 },
    { kind: 'marked_lost', quantity: 1 },
    { kind: 'found_returned_damaged', quantity: 1 },
  ]);
  expect(
    rows<{ available: number; damaged: number }>(
      database,
      `SELECT SUM(CASE kind WHEN 'stock_added' THEN quantity WHEN 'returned_usable' THEN quantity
        WHEN 'found_returned' THEN quantity WHEN 'checked_out' THEN -quantity ELSE 0 END) available,
        SUM(CASE kind WHEN 'returned_damaged' THEN quantity WHEN 'found_returned_damaged' THEN quantity
        WHEN 'repaired' THEN -quantity WHEN 'written_off' THEN -quantity ELSE 0 END) damaged
       FROM inventory_events WHERE item_id=?`,
      seed.item.id,
    )[0],
  ).toEqual({ available: 4, damaged: 2 });
});

test('reopens the card for another operation after a reviewed save', async ({
  page,
  seed,
  openLedger,
}) => {
  await openSeededCard(page, seed.borrower.username);
  await stageBorrow(page, seed.item.name);
  await confirmSave(page);
  await expect(page.getByRole('dialog', { name: /כרטיס שואל/ })).toBeHidden();
  await openSeededCard(page, seed.borrower.username);
  await stageReturn(page, seed.item.name);
  await confirmSave(page);
  await expect(page.getByRole('dialog', { name: /כרטיס שואל/ })).toBeHidden();

  const database = openLedger();
  expect(
    rows<{ count: number }>(
      database,
      "SELECT COUNT(*) count FROM idempotency_receipts WHERE command_kind='borrower_operation' AND subject_id=?",
      seed.borrower.id,
    )[0]?.count,
  ).toBe(2);
});

test('keeps search blocked after a stale committed-save snapshot until truth refresh succeeds', async ({
  page,
  seed,
  openLedger,
}) => {
  const snapshotEndpoint = `**/api/borrowers/${seed.borrower.id}/desk-snapshot`;
  const operationEndpoint = `**/api/borrowers/${seed.borrower.id}/operations`;
  let snapshotRequests = 0;
  let operationPosts = 0;
  await page.route(snapshotEndpoint, async (route) => {
    snapshotRequests += 1;
    if (snapshotRequests === 2) {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), asOfEventId: 0 } });
    } else await route.continue();
  });
  await page.route(operationEndpoint, async (route) => {
    if (route.request().method() === 'POST') operationPosts += 1;
    await route.continue();
  });

  await openSeededCard(page, seed.borrower.username);
  await stageBorrow(page, seed.item.name);
  await confirmSave(page);

  const retry = page.getByRole('button', { name: 'אימות נתוני האמת לפני המשך' });
  await expect(page.getByRole('dialog', { name: /כרטיס שואל/ })).toBeHidden();
  await expect(retry).toBeFocused();
  await expect(page.getByRole('searchbox', { name: 'חיפוש שואל' })).toBeDisabled();
  expect(operationPosts).toBe(1);

  await retry.click();
  await expect(page.getByRole('searchbox', { name: 'חיפוש שואל' })).toBeFocused();
  await expect(page.getByRole('searchbox', { name: 'חיפוש שואל' })).toHaveValue('');
  expect(operationPosts).toBe(1);
  expect(snapshotRequests).toBe(3);
  await page.getByRole('button', { name: 'סגירת הודעה' }).click();
  await expect(page.locator('.toast')).toBeHidden();

  const database = openLedger();
  expect(
    rows<{ count: number }>(
      database,
      "SELECT COUNT(*) count FROM idempotency_receipts WHERE command_kind='borrower_operation' AND subject_id=?",
      seed.borrower.id,
    )[0]?.count,
  ).toBe(1);
});

test('keeps a confirmed close in recovery until a newer ledger epoch is loaded', async ({
  page,
  seed,
}) => {
  let snapshots = 0;
  await page.route(`**/api/borrowers/${seed.borrower.id}/desk-snapshot`, async (route) => {
    snapshots += 1;
    const response = await route.fetch();
    const snapshot = await response.json();
    await route.fulfill({
      response,
      json:
        snapshots === 2 || snapshots === 4
          ? { ...snapshot, ledgerEpoch: snapshot.ledgerEpoch + 1 }
          : snapshot,
    });
  });

  await openSeededCard(page, seed.borrower.username);
  await stageBorrow(page, seed.item.name);
  await confirmSave(page);

  const retry = page.getByRole('button', { name: 'טעינת אמת עדכנית' });
  await expect(page.getByRole('dialog', { name: /כרטיס שואל/ })).toBeHidden();
  await expect(retry).toBeFocused();
  await expect(page.getByRole('searchbox', { name: 'חיפוש שואל' })).toBeDisabled();
  await retry.click();
  await expect(retry).toBeFocused();
  await expect(page.getByRole('searchbox', { name: 'חיפוש שואל' })).toBeDisabled();
  await retry.click();
  await expect(page.getByRole('searchbox', { name: 'חיפוש שואל' })).toBeFocused();
  await expect(page.getByRole('searchbox', { name: 'חיפוש שואל' })).toBeEnabled();
  expect(snapshots).toBe(4);
});

test('resolves an ambiguous committed response after reload without duplicating the command', async ({
  page,
  seed,
  openLedger,
}) => {
  await openSeededCard(page, seed.borrower.username);
  await stageBorrow(page, seed.item.name);
  await page.route(`**/api/borrowers/${seed.borrower.id}/operations`, async (route) => {
    await route.fetch();
    await route.abort('connectionfailed');
  });
  await confirmSave(page);
  await expect(page.getByRole('button', { name: 'בדיקת תוצאת השמירה' })).toBeVisible();
  const envelope = await page.evaluate(() =>
    Object.entries(localStorage).find(([key]) => key.startsWith('mapatz:frozen-attempt:v1:')),
  );
  expect(envelope).toBeTruthy();

  await page.unrouteAll({ behavior: 'wait' });
  await page.reload();
  await page.getByRole('link', { name: 'דלפק השאלות' }).click();
  await expect(page.getByRole('searchbox', { name: 'חיפוש שואל' })).toBeEnabled();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('mapatz:frozen-attempt:v1:')),
    ),
  ).toEqual([]);

  const database = openLedger();
  expect(
    rows<{ count: number }>(
      database,
      "SELECT COUNT(*) count FROM inventory_events WHERE borrower_id=? AND kind='checked_out'",
      seed.borrower.id,
    )[0]?.count,
  ).toBe(2);
  expect(
    rows<{ count: number }>(
      database,
      'SELECT COUNT(*) count FROM idempotency_receipts WHERE subject_id=?',
      seed.borrower.id,
    )[0]?.count,
  ).toBe(1);
});

test('restores focus to the return trigger after dismissing its quantity modal', async ({
  page,
  seed,
}) => {
  await openSeededCard(page, seed.borrower.username);
  const returnButton = page.getByRole('button', { name: 'החזרת ציוד' });
  await returnButton.click();
  const dialog = page.getByRole('dialog', { name: 'החזרת ציוד' });
  await expect(dialog.getByRole('spinbutton', { name: 'כמות' })).toBeFocused();
  await dialog.getByRole('checkbox', { name: 'הציוד הוחזר פגום' }).check();
  await dialog.getByRole('button', { name: 'ביטול' }).click();
  await expect(dialog).toBeHidden();
  await expect(returnButton).toBeFocused();
  await expect(page.getByText('אין פעולות ממתינות')).toBeVisible();
  await returnButton.click();
  await expect(dialog.getByRole('checkbox', { name: 'הציוד הוחזר פגום' })).not.toBeChecked();
});

test('renders a fresh conflict, keeps staging, and requires a new deliberate save key', async ({
  page,
  request,
  seed,
  openLedger,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openSeededCard(page, seed.borrower.username);
  await stageBorrow(page, seed.stockItem.name, '3');
  await stageReturn(page, seed.item.name, '2');
  await stageBorrow(page, seed.archiveItem.name);
  let frozenRequest: { key: string; body: unknown } | undefined;
  page.on('request', (outgoing) => {
    if (
      outgoing.method() === 'POST' &&
      outgoing.url().endsWith(`/api/borrowers/${seed.borrower.id}/operations`)
    ) {
      frozenRequest = {
        key: outgoing.headers()['idempotency-key']!,
        body: outgoing.postDataJSON(),
      };
    }
  });
  const database = openLedger();
  expect(
    (
      await request.post(
        `/__e2e__/conflicts/operation/${seed.stockItem.id}/${seed.checkoutId}/${seed.archiveItem.id}`,
      )
    ).ok(),
  ).toBeTruthy();
  const eventsAfterMutation = rows<{ count: number }>(
    database,
    'SELECT COUNT(*) count FROM inventory_events',
  )[0]!.count;
  await confirmSave(page);

  const conflicts = page.locator('.staged-section .field-error span');
  await expect(conflicts).toHaveText([
    'אין די מלאי זמין',
    'יתרת ההחזרה השתנתה',
    'הפריט הועבר לארכיון',
  ]);
  await expect(
    page.getByText('אין די מלאי זמין').locator('xpath=ancestor::*[@data-compatible="false"]'),
  ).toBeFocused();
  await expect(page.getByText(/החזרת ציוד ·/)).toBeVisible();
  await expect(
    page.locator('.staged-section .borrower-pending-row').filter({ hasText: 'השאלה' }),
  ).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'ביטול פעולה' })).toHaveCount(3);
  await expect(page.locator('.toast')).toHaveCount(1);
  await expect(page.locator('.toast')).toHaveCSS('animation-name', 'none');
  expect(
    rows<{ count: number }>(database, 'SELECT COUNT(*) count FROM inventory_events')[0]!.count,
  ).toBe(eventsAfterMutation);

  const rejected = rows<{ key: string }>(
    database,
    "SELECT key FROM idempotency_receipts WHERE subject_id=? AND outcome='rejected'",
    seed.borrower.id,
  );
  expect(rejected).toHaveLength(1);
  expect(frozenRequest?.key).toBe(rejected[0]!.key);
  expect(frozenRequest?.body).toMatchObject({
    items: [
      { itemId: seed.stockItem.id, borrow: [{ quantity: 3, note: '' }] },
      { itemId: seed.item.id, return: [{ usable: 2, damaged: 0, note: '' }] },
      { itemId: seed.archiveItem.id, borrow: [{ quantity: 1, note: '' }] },
    ],
  });
  expect(
    (
      await request.post(
        `/__e2e__/conflicts/resolve/${seed.borrower.id}/${seed.item.id}/${seed.stockItem.id}/${seed.archiveItem.id}`,
      )
    ).ok(),
  ).toBeTruthy();
  const beforeReplay = rows<{ count: number }>(
    database,
    'SELECT COUNT(*) count FROM inventory_events',
  )[0]!.count;
  const replay = await request.post(`/api/borrowers/${seed.borrower.id}/operations`, {
    headers: { 'Idempotency-Key': rejected[0]!.key },
    data: frozenRequest!.body,
  });
  expect(replay.status()).toBe(409);
  expect(await replay.json()).toMatchObject({
    error: 'borrower_operation_attempt_rejected',
    replayed: true,
    idempotencyKey: rejected[0]!.key,
    currentValidation: { status: 'now_valid', conflicts: [] },
  });
  expect(
    rows<{ count: number }>(database, 'SELECT COUNT(*) count FROM inventory_events')[0]!.count,
  ).toBe(beforeReplay);
  const rootActions = page.locator('[data-dialog-level="root"] .dialog-shell-actions');
  await rootActions.getByRole('button', { name: 'סגירה', exact: true }).click();
  await page.getByRole('button', { name: 'מחיקת הפעולות וסגירה' }).click();
  // Closing consumes the history sentinel asynchronously; finish that traversal
  // before starting a new document navigation.
  await page.waitForFunction(() => !history.state?.mapatzBorrowerWorkflow);
  await openSeededCard(page, seed.borrower.username);
  await stageBorrow(page, seed.stockItem.name);
  await confirmSave(page);
  await expect(page.getByRole('dialog', { name: /כרטיס שואל/ })).toBeHidden();
  const receipts = rows<{ key: string; outcome: string }>(
    database,
    'SELECT key,outcome FROM idempotency_receipts WHERE subject_id=?',
    seed.borrower.id,
  );
  expect(receipts).toHaveLength(2);
  expect(receipts.find(({ outcome }) => outcome === 'committed')?.key).not.toBe(rejected[0]?.key);
});

test('reconciles a stale combined held balance before a deliberate retry', async ({
  page,
  request,
  seed,
  openLedger,
}) => {
  await openSeededCard(page, seed.borrower.username);
  await stageReturn(page, seed.item.name);
  const more = page.getByRole('button', { name: 'אפשרויות נוספות' });
  await more.press('ArrowDown');
  await page.getByRole('menuitem', { name: 'סמן כאבוד' }).press('Enter');
  const lossDialog = page.getByRole('dialog', { name: 'סמן כאבוד' });
  await lossDialog.getByRole('button', { name: 'אישור' }).click();
  await stageBorrow(page, seed.stockItem.name);

  const attempts: Array<{ key: string; body: unknown }> = [];
  page.on('request', (outgoing) => {
    if (
      outgoing.method() === 'POST' &&
      outgoing.url().endsWith(`/api/borrowers/${seed.borrower.id}/operations`)
    ) {
      attempts.push({
        key: outgoing.headers()['idempotency-key']!,
        body: outgoing.postDataJSON(),
      });
    }
  });
  const externalReturn = await request.post('/api/return', {
    data: { checkoutId: seed.checkoutId, usable: 1, damaged: 0, note: 'e2e held conflict' },
  });
  expect(externalReturn.status()).toBe(201);
  const database = openLedger();
  const beforeAttempt = rows<{ count: number }>(
    database,
    'SELECT COUNT(*) count FROM inventory_events',
  )[0]!.count;

  const firstResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/api/borrowers/${seed.borrower.id}/operations`),
  );
  await confirmSave(page);
  const conflictResponse = await firstResponse;
  expect(conflictResponse.status()).toBe(409);
  expect(await conflictResponse.json()).toMatchObject({
    error: 'borrower_operation_conflict',
    outcome: 'rejected',
    conflicts: [
      {
        scope: 'held',
        code: 'held_balance_changed',
        itemId: seed.item.id,
        requested: 2,
        returnable: 1,
      },
    ],
  });
  const pending = page.locator('.staged-section');
  await expect(pending.getByText('יתרת הציוד אצל השואל השתנתה')).toHaveCount(2);
  await expect(pending.getByText(/החזרת ציוד · 1/)).toBeVisible();
  await expect(pending.getByText(/סמן כאבוד · 1/)).toBeVisible();
  await expect(pending.getByText(/השאלה · 1/)).toBeVisible();
  await expect(pending.getByRole('button', { name: 'ביטול פעולה' })).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'אישור פעולות' })).toBeDisabled();
  expect(
    rows<{ count: number }>(database, 'SELECT COUNT(*) count FROM inventory_events')[0]!.count,
  ).toBe(beforeAttempt);
  expect(
    rows<{ kind: string; quantity: number }>(
      database,
      'SELECT kind,quantity FROM inventory_events WHERE related_event_id=? ORDER BY id',
      seed.checkoutId,
    ),
  ).toEqual([{ kind: 'returned_usable', quantity: 1 }]);
  expect(attempts).toHaveLength(1);
  expect(attempts[0]!.body).toMatchObject({
    items: [
      {
        itemId: seed.item.id,
        return: [{ usable: 1, damaged: 0, note: '' }],
        lost: [{ quantity: 1, note: '' }],
      },
      { itemId: seed.stockItem.id, borrow: [{ quantity: 1, note: '' }] },
    ],
  });
  const rejected = rows<{ key: string; outcome: string }>(
    database,
    'SELECT key,outcome FROM idempotency_receipts WHERE subject_id=?',
    seed.borrower.id,
  );
  expect(rejected).toEqual([{ key: attempts[0]!.key, outcome: 'rejected' }]);

  const lossRow = pending.locator('.borrower-pending-row').filter({ hasText: 'סמן כאבוד' });
  await lossRow.getByRole('button', { name: 'ביטול פעולה' }).click();
  await expect(lossRow).toHaveCount(0);
  await expect(pending.getByText('יתרת הציוד אצל השואל השתנתה')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'אישור פעולות' })).toBeEnabled();
  await confirmSave(page);
  await expect(page.getByRole('dialog', { name: /כרטיס שואל/ })).toBeHidden();

  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.key).not.toBe(attempts[0]!.key);
  expect(attempts[1]!.body).toMatchObject({
    items: [
      { itemId: seed.item.id, return: [{ usable: 1, damaged: 0, note: '' }] },
      { itemId: seed.stockItem.id, borrow: [{ quantity: 1, note: '' }] },
    ],
  });
  expect(
    rows<{ kind: string; quantity: number }>(
      database,
      'SELECT kind,quantity FROM inventory_events WHERE related_event_id=? ORDER BY id',
      seed.checkoutId,
    ),
  ).toEqual([
    { kind: 'returned_usable', quantity: 1 },
    { kind: 'returned_usable', quantity: 1 },
  ]);
  expect(
    rows<{ count: number }>(
      database,
      "SELECT COUNT(*) count FROM inventory_events WHERE borrower_id=? AND item_id=? AND kind='marked_lost'",
      seed.borrower.id,
      seed.item.id,
    )[0]!.count,
  ).toBe(0);
  expect(
    rows<{ count: number }>(database, 'SELECT COUNT(*) count FROM inventory_events')[0]!.count,
  ).toBe(beforeAttempt + 2);
  const receipts = rows<{ key: string; outcome: string }>(
    database,
    'SELECT key,outcome FROM idempotency_receipts WHERE subject_id=?',
    seed.borrower.id,
  );
  expect(receipts).toHaveLength(2);
  expect(receipts).toContainEqual({ key: attempts[0]!.key, outcome: 'rejected' });
  expect(receipts).toContainEqual({ key: attempts[1]!.key, outcome: 'committed' });
});

test('rejects an operation without writes when the borrower becomes archived', async ({
  page,
  request,
  seed,
  openLedger,
}) => {
  await openSeededCard(page, seed.borrower.username);
  await stageBorrow(page, seed.stockItem.name);
  const database = openLedger();
  expect((await request.post(`/__e2e__/archive-borrower/${seed.borrower.id}`)).ok()).toBeTruthy();
  const eventCount = rows<{ count: number }>(
    database,
    'SELECT COUNT(*) count FROM inventory_events',
  )[0]!.count;
  await confirmSave(page);

  const conflict = page.getByText('השואל אינו פעיל');
  await expect(conflict).toBeVisible();
  await expect(conflict.locator('xpath=ancestor::*[@data-compatible="false"]')).toBeFocused();
  await expect(page.locator('.staged-section .borrower-pending-row')).toContainText('השאלה');
  await expect(page.getByRole('button', { name: 'ביטול פעולה' })).toHaveCount(1);
  expect(
    rows<{ count: number }>(database, 'SELECT COUNT(*) count FROM inventory_events')[0]!.count,
  ).toBe(eventCount);
});

test('retains an unknown envelope through authorization loss and clears it after epoch replacement', async ({
  page,
  request,
  seed,
  openLedger,
}) => {
  await openSeededCard(page, seed.borrower.username);
  await stageBorrow(page, seed.item.name);
  const endpoint = `**/api/borrowers/${seed.borrower.id}/operations`;
  await page.route(endpoint, (route) => route.abort('connectionfailed'));
  await confirmSave(page);
  const retry = page.getByRole('button', { name: 'בדיקת תוצאת השמירה' });
  await expect(retry).toBeVisible();

  await page.unrouteAll({ behavior: 'wait' });
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'forbidden', message: 'אין הרשאה לפעולה זו' }),
    }),
  );
  await retry.click();
  await expect(page.locator('.toast')).toContainText('אימות הרשאה');
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('mapatz:frozen-attempt:v1:')),
    ),
  ).toHaveLength(1);

  expect((await request.post('/__e2e__/rotate-epoch')).ok()).toBeTruthy();
  await page.unrouteAll({ behavior: 'wait' });
  await retry.click();
  await expect(page.getByRole('button', { name: 'טעינת אמת עדכנית' })).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('mapatz:frozen-attempt:v1:')),
    ),
  ).toEqual([]);
  const database = openLedger();
  expect(
    rows<{ count: number }>(
      database,
      'SELECT COUNT(*) count FROM idempotency_receipts WHERE subject_id=?',
      seed.borrower.id,
    )[0]?.count,
  ).toBe(0);
  expect(
    rows<{ count: number }>(
      database,
      "SELECT COUNT(*) count FROM inventory_events WHERE borrower_id=? AND kind='checked_out'",
      seed.borrower.id,
    )[0]?.count,
  ).toBe(1);
});

test('resolves a committed-but-lost creation with the exact envelope before retrying card load', async ({
  page,
  openLedger,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'דלפק השאלות' }).click();
  await page.getByRole('button', { name: 'יצירת שואל חדש' }).click();
  const create = page.getByRole('dialog', { name: 'יצירת שואל חדש' });
  const username = `created-${Date.now()}`;
  await create.getByLabel('שם משתמש').fill(username);
  await create.getByLabel('שם מלא').fill('שואל שנוצר');
  await create.getByLabel('פרטי קשר').fill('050-123');
  const createAttempts: Array<{ key: string; body: unknown }> = [];
  let loseCreateResponse = true;
  await page.route('**/api/borrowers', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    createAttempts.push({
      key: route.request().headers()['idempotency-key']!,
      body: route.request().postDataJSON(),
    });
    if (loseCreateResponse) {
      loseCreateResponse = false;
      await route.fetch();
      await route.abort('connectionfailed');
    } else await route.continue();
  });
  await create.getByRole('button', { name: 'יצירה' }).click();
  const recovery = page.getByRole('button', { name: 'בדיקת הפעולה' });
  await expect(recovery).toBeFocused();
  const stored = await page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) => key.startsWith('mapatz:frozen-attempt:v1:')),
  );
  expect(stored).toHaveLength(1);
  const envelope = JSON.parse(stored[0]![1]) as {
    idempotencyKey: string;
    body: unknown;
    kind: string;
  };
  expect(envelope).toMatchObject({
    kind: 'create',
    idempotencyKey: createAttempts[0]!.key,
    body: createAttempts[0]!.body,
  });

  let failedCardLoad = false;
  await page.route('**/api/borrowers/*/desk-snapshot', async (route) => {
    if (!failedCardLoad) {
      failedCardLoad = true;
      await route.abort('connectionfailed');
    } else await route.continue();
  });
  await recovery.click();

  await expect(page.locator('.toast')).toHaveCount(1);
  await expect(page.locator('.toast')).toContainText('השואל נוצר');
  expect(createAttempts).toHaveLength(2);
  expect(createAttempts[1]).toEqual(createAttempts[0]);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('mapatz:frozen-attempt:v1:')),
    ),
  ).toEqual([]);
  const retryCard = page.getByRole('button', { name: 'ניסיון פתיחת הכרטיס מחדש' });
  await expect(retryCard).toBeFocused();
  await retryCard.click();
  await expect(page.locator('.borrower-identity-meta')).toBeFocused();
  await expect(page.getByRole('listbox')).toHaveCount(0);

  const database = openLedger();
  expect(
    rows<{ count: number }>(
      database,
      'SELECT COUNT(*) count FROM borrowers WHERE username=?',
      username,
    )[0]?.count,
  ).toBe(1);
  expect(
    rows<{ count: number }>(
      database,
      "SELECT COUNT(*) count FROM idempotency_receipts WHERE command_kind='borrower_create' AND key=?",
      envelope.idempotencyKey,
    )[0]?.count,
  ).toBe(1);
});

test('keeps duplicate borrower values and archived-match guidance with one error Toast', async ({
  page,
  seed,
  openLedger,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'דלפק השאלות' }).click();
  await page.getByRole('button', { name: 'יצירת שואל חדש' }).click();
  const create = page.getByRole('dialog', { name: 'יצירת שואל חדש' });
  const username = create.getByLabel('שם משתמש');
  await username.fill(seed.archivedBorrower.username);
  await create.getByLabel('שם מלא').fill(seed.archivedBorrower.name);
  await create.getByLabel('פרטי קשר').fill('059-duplicate');
  await create.getByRole('button', { name: 'יצירה' }).click();

  await expect(create).toBeVisible();
  await expect(username).toHaveValue(seed.archivedBorrower.username);
  await expect(username).toBeFocused();
  await expect(create.getByText('Username matches an existing borrower')).toBeVisible();
  await expect(create.getByText(`${seed.archivedBorrower.name} — בארכיון`)).toBeVisible();
  await expect(page.locator('.toast')).toHaveCount(1);
  await expect(page.locator('.toast')).toContainText('נדרשת תשומת לב');
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('mapatz:frozen-attempt:v1:')),
    ),
  ).toEqual([]);
  const database = openLedger();
  expect(
    rows<{ count: number }>(
      database,
      "SELECT COUNT(*) count FROM idempotency_receipts WHERE command_kind='borrower_create' AND outcome='rejected'",
    )[0]?.count,
  ).toBeGreaterThanOrEqual(1);
});

test('traps keyboard focus at both dialog depths and guards dirty Escape with one alertdialog', async ({
  page,
  seed,
}) => {
  const borrowerSearch = await openSeededCard(page, seed.borrower.username);
  const itemSearch = page.getByRole('combobox', { name: 'חיפוש פריט' });
  await itemSearch.fill(seed.stockItem.name);
  await page.getByRole('option', { name: new RegExp(seed.stockItem.name) }).click();
  const child = page.getByRole('dialog', { name: 'הוספת השאלה' });
  const childClose = child.locator('.dialog-close');
  const childConfirm = child.getByRole('button', { name: 'אישור' });
  await expect(child.getByRole('spinbutton', { name: 'כמות' })).toBeFocused();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await childClose.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(childConfirm).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(childClose).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(child).toBeHidden();
  await expect(itemSearch).toBeFocused();

  await stageBorrow(page, seed.stockItem.name);
  const root = page.getByRole('dialog', { name: /כרטיס שואל/ });
  const rootClose = root.locator('.dialog-close');
  const reviewAndSave = root.getByRole('button', { name: 'אישור פעולות' });
  await rootClose.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(reviewAndSave).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(rootClose).toBeFocused();
  await page.keyboard.press('Escape');

  const discard = page.getByRole('alertdialog', { name: 'ביטול פעולות ממתינות?' });
  await expect(discard).toBeVisible();
  await expect(page.locator('#dialog-stack-root > *')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(discard).toBeHidden();
  await expect(rootClose).toBeFocused();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'מחיקת הפעולות וסגירה' }).click();
  await expect(root).toBeHidden();
  await expect(borrowerSearch).toBeFocused();
});

test('marks lost equipment without offering restoration through real admin authorization and closes on auth loss', async ({
  page,
  seed,
  openLedger,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'הפעל מצב מנהל' }).click();
  const authentication = page.getByRole('dialog', { name: 'הפעלת מצב מנהל' });
  await authentication.locator('input[name="password"]').fill('e2e-admin-password');
  await authentication.getByRole('button', { name: 'הפעל מצב מנהל' }).click();
  await expect(page.getByRole('button', { name: 'סיום מצב מנהל' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'ניווט ראשי' })
    .getByRole('link', { name: 'ניהול' })
    .click();
  const loanRow = page.getByRole('row', { name: new RegExp(seed.item.name) });
  const markLost = loanRow.getByRole('button', { name: 'סמן אבוד' });
  await expect(markLost).toBeEnabled();
  await markLost.click();
  let lostDialog = page.getByRole('dialog', { name: 'סימון ציוד כאבוד' });
  await lostDialog.locator('input[name="quantity"]').fill('1');
  await lostDialog.getByRole('button', { name: 'שמירה' }).click();
  await expect(lostDialog).toBeHidden();

  await expect(loanRow.getByRole('button', { name: 'בטל אובדן' })).toHaveCount(0);

  const database = openLedger();
  expect(
    rows<{ kind: string; quantity: number }>(
      database,
      "SELECT kind,quantity FROM inventory_events WHERE related_event_id=? AND kind IN ('marked_lost','found_returned') ORDER BY id",
      seed.checkoutId,
    ),
  ).toEqual([{ kind: 'marked_lost', quantity: 1 }]);

  await markLost.click();
  lostDialog = page.getByRole('dialog', { name: 'סימון ציוד כאבוד' });
  await page.evaluate(async () => {
    await fetch('/api/session/role', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'operator' }),
    });
  });
  await lostDialog.getByRole('button', { name: 'שמירה' }).click();
  await expect(lostDialog).toBeHidden();
  await expect(markLost).toBeDisabled();
  expect(
    rows<{ count: number }>(
      database,
      "SELECT COUNT(*) count FROM inventory_events WHERE related_event_id=? AND kind IN ('marked_lost','found_returned')",
      seed.checkoutId,
    )[0]!.count,
  ).toBe(1);
});

test('operator credits a previously lost unit back to usable inventory', async ({
  page,
  seed,
  openLedger,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'הפעל מצב מנהל' }).click();
  const authentication = page.getByRole('dialog', { name: 'הפעלת מצב מנהל' });
  await authentication.locator('input[name="password"]').fill('e2e-admin-password');
  await authentication.getByRole('button', { name: 'הפעל מצב מנהל' }).click();
  await page
    .getByRole('navigation', { name: 'ניווט ראשי' })
    .getByRole('link', { name: 'ניהול' })
    .click();
  const loanRow = page.getByRole('row', { name: new RegExp(seed.item.name) });
  await loanRow.getByRole('button', { name: 'סמן אבוד' }).click();
  const lostDialog = page.getByRole('dialog', { name: 'סימון ציוד כאבוד' });
  await lostDialog.getByRole('button', { name: 'שמירה' }).click();
  await page.evaluate(async () => {
    await fetch('/api/session/role', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'operator' }),
    });
  });

  await openSeededCard(page, seed.borrower.username);
  await expect(page.getByRole('button', { name: 'החזרת ציוד' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'אפשרויות נוספות' })).toHaveCount(0);
  await page.getByText('ציוד אבוד של השואל').click();
  const found = page.getByRole('button', { name: 'נמצא והוחזר' });
  await expect(found).toBeEnabled();
  await found.click();
  const dialog = page.getByRole('dialog', { name: 'נמצא והוחזר' });
  await expectQuantityDialogItem(dialog, seed.item.name);
  await expect(dialog.getByRole('checkbox', { name: 'הציוד הוחזר פגום' })).not.toBeChecked();
  await dialog.getByRole('spinbutton', { name: 'כמות' }).fill('1');
  await dialog.getByRole('button', { name: 'אישור' }).click();
  await confirmSave(page);
  await expect(page.locator('.toast')).toContainText('השמירה הושלמה');

  const database = openLedger();
  expect(
    rows<{ kind: string; quantity: number }>(
      database,
      'SELECT kind,quantity FROM inventory_events WHERE related_event_id=? ORDER BY id',
      seed.checkoutId,
    ),
  ).toEqual([
    { kind: 'marked_lost', quantity: 2 },
    { kind: 'found_returned', quantity: 1 },
  ]);
  expect(
    rows<{ available: number }>(
      database,
      `SELECT SUM(CASE kind
        WHEN 'stock_added' THEN quantity WHEN 'returned_usable' THEN quantity WHEN 'found_returned' THEN quantity
        WHEN 'checked_out' THEN -quantity ELSE 0 END) available
       FROM inventory_events WHERE item_id=?`,
      seed.item.id,
    )[0]!.available,
  ).toBe(5);
});

test('retires legacy presentation while preserving gated lost controls and responsive accessibility', async ({
  page,
  seed,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'ניווט ראשי' });
  await expect(navigation.getByRole('link', { name: /^השאלה$/ })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'החזרות' })).toHaveCount(0);
  await navigation.getByRole('link', { name: 'ניהול' }).click();
  await expect(page.getByRole('heading', { name: 'ציוד בחוץ ואבוד' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'החזרה' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'סמן אבוד' }).first()).toBeDisabled();

  await openSeededCard(page, seed.borrower.username);
  await stageBorrow(page, seed.item.name);
  const staged: Locator = page.getByRole('heading', { name: 'פעולות ממתינות' }).locator('..');
  const holdings: Locator = page.getByRole('heading', { name: /ציוד אצל השואל/ }).locator('..');
  const lost: Locator = page.locator('.lost-equipment-section');
  const holdingsTable = holdings.getByRole('table');
  await expect(holdingsTable.getByRole('columnheader', { name: 'אצל השואל' })).toBeVisible();
  const heldRow = holdingsTable.getByRole('rowheader', { name: seed.item.name }).locator('..');
  await expect(heldRow.getByRole('cell').first()).toHaveText('3');
  await expect(heldRow.getByRole('rowheader')).toHaveCSS('vertical-align', 'middle');
  await expect(heldRow.getByRole('cell').first()).toHaveCSS('vertical-align', 'middle');
  const quantityPadding = await heldRow
    .getByRole('cell')
    .first()
    .evaluate((cell) => {
      const style = getComputedStyle(cell);
      return {
        start: parseFloat(style.paddingInlineStart),
        end: parseFloat(style.paddingInlineEnd),
      };
    });
  expect(quantityPadding.start).toBeGreaterThan(quantityPadding.end);
  const wide = await Promise.all([
    staged.boundingBox(),
    holdings.boundingBox(),
    lost.boundingBox(),
  ]);
  expect(wide[0]!.x).toBeGreaterThan(wide[1]!.x);
  expect(Math.abs(wide[0]!.y - wide[1]!.y)).toBeLessThan(1);
  expect(Math.abs(wide[0]!.width - wide[1]!.width)).toBeLessThan(1);
  expect(wide[2]!.x).toBe(wide[1]!.x);
  expect(wide[2]!.y).toBeGreaterThan(wide[1]!.y);
  const holdingsElement = await holdings.elementHandle();
  expect(
    await staged.evaluate(
      (node, other) =>
        Boolean(node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING),
      holdingsElement,
    ),
  ).toBe(true);
  await expect(page.locator('.dialog-workspace')).toHaveCSS('overflow', 'hidden');
  await expect(page.locator('.dialog-workspace .dialog-shell-body')).toHaveCSS(
    'overflow-y',
    'auto',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const button of await page.getByRole('button').all()) {
    const box = await button.boundingBox();
    if (box && (await button.isVisible())) {
      expect(box.width).toBeGreaterThanOrEqual(40);
      expect(box.height).toBeGreaterThanOrEqual(40);
    }
  }
  await expect(page.locator('.app-nav')).toHaveCSS('transition-duration', '0s');
  await expect(page.getByRole('button', { name: 'אישור פעולות' })).toHaveCSS(
    'transition-duration',
    '0s',
  );
  await expect(page.getByRole('combobox', { name: 'חיפוש פריט' })).toHaveCSS(
    'transition-duration',
    '0s',
  );

  await page.setViewportSize({ width: 761, height: 720 });
  const splitThreshold = await Promise.all([staged.boundingBox(), holdings.boundingBox()]);
  expect(splitThreshold[0]!.x).toBeGreaterThan(splitThreshold[1]!.x);
  expect(
    await page
      .locator('.dialog-workspace .dialog-shell-body')
      .evaluate((body) => body.scrollWidth <= body.clientWidth),
  ).toBe(true);

  await page.setViewportSize({ width: 760, height: 720 });
  const stackThreshold = await Promise.all([staged.boundingBox(), holdings.boundingBox()]);
  expect(stackThreshold[0]!.y).toBeLessThan(stackThreshold[1]!.y);
  expect(
    await page
      .locator('.dialog-workspace .dialog-shell-body')
      .evaluate((body) => body.scrollWidth <= body.clientWidth),
  ).toBe(true);

  await page.setViewportSize({ width: 640, height: 720 });
  const zoomed = await Promise.all([
    staged.boundingBox(),
    holdings.boundingBox(),
    lost.boundingBox(),
  ]);
  expect(zoomed[0]!.y).toBeLessThan(zoomed[1]!.y);
  expect(zoomed[2]!.y).toBeGreaterThan(zoomed[1]!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.setViewportSize({ width: 320, height: 720 });
  const narrow = await Promise.all([
    staged.boundingBox(),
    holdings.boundingBox(),
    lost.boundingBox(),
  ]);
  expect(narrow[0]!.y).toBeLessThan(narrow[1]!.y);
  expect(narrow[2]!.y).toBeGreaterThan(narrow[1]!.y);
  expect(
    await page
      .locator('.dialog-workspace .dialog-shell-body')
      .evaluate((body) => body.scrollWidth <= body.clientWidth),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('keeps the ledger schema free of transaction grouping or receipt relations', async ({
  openLedger,
}) => {
  const database = openLedger();
  const eventColumns = rows<{ name: string }>(database, 'PRAGMA table_info(inventory_events)').map(
    ({ name }) => name,
  );
  expect(eventColumns).toEqual([
    'id',
    'kind',
    'item_id',
    'borrower_id',
    'quantity',
    'related_event_id',
    'note',
    'created_at',
  ]);
  expect(eventColumns.some((name) => /batch|transaction|receipt/i.test(name))).toBe(false);
});
