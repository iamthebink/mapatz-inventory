import ExcelJS from 'exceljs';
import { expect, test } from './fixtures';

test('admin replaces borrowers only after confirming equipment returns', async ({
  page,
  seed,
  openLedger,
}) => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Borrowers').addRows([
    ['Username', 'Name', 'Contact', 'Type'],
    ['import-browser', 'שואל מיובא', '', ''],
  ]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
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
  await page.getByRole('tab', { name: 'שואלים' }).click();
  await page.getByRole('button', { name: 'ייבוא שואלים מקובץ' }).click();
  const dialog = page.getByRole('dialog', { name: 'ייבוא שואלים מקובץ' });
  await dialog.getByLabel('קובץ שואלים').setInputFiles({
    name: 'borrowers.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  });
  await dialog.getByLabel('אופן הייבוא').selectOption('replace');
  await dialog.getByRole('button', { name: 'ייבוא', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: 'אישור החזרת ציוד והחלפת שואלים' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByText(seed.item.name, { exact: false })).toBeVisible();
  await expect(confirmation.getByRole('button', { name: 'ביטול' })).toBeFocused();
  const ledger = openLedger();
  const returned = () =>
    Number(
      ledger
        .prepare(
          "SELECT COALESCE(SUM(quantity),0) quantity FROM inventory_events WHERE related_event_id=? AND kind='returned_usable'",
        )
        .get(seed.checkoutId)?.quantity,
    );
  expect(returned()).toBe(0);
  await confirmation.getByRole('button', { name: 'ביטול' }).click();
  await expect(confirmation).toBeHidden();
  expect(returned()).toBe(0);
  await dialog.getByRole('button', { name: 'ייבוא', exact: true }).click();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'אישור החזרה וייבוא' }).click();
  await expect(confirmation).toBeHidden();
  await expect(page.locator('#dialog-stack-root > *')).toHaveCount(0);
  expect(returned()).toBe(2);
  expect(
    ledger.prepare('SELECT archived FROM borrowers WHERE id=?').get(seed.borrower.id)?.archived,
  ).toBe(1);
  expect(
    ledger.prepare('SELECT archived FROM borrowers WHERE username=?').get('import-browser')
      ?.archived,
  ).toBe(0);
  await expect(page.getByText('שואל מיובא', { exact: true })).toBeVisible();
});

test('admin imports with default merge while preserving absent borrowers and their loans', async ({
  page,
  seed,
  openLedger,
}) => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Borrowers').addRows([
    ['Username', 'Name', 'Contact', 'Type'],
    ['merge-browser', 'שואל ממוזג', '', ''],
  ]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
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
  await page.getByRole('tab', { name: 'שואלים' }).click();
  await page.getByRole('button', { name: 'ייבוא שואלים מקובץ' }).click();
  const dialog = page.getByRole('dialog', { name: 'ייבוא שואלים מקובץ' });
  await dialog.getByLabel('קובץ שואלים').setInputFiles({
    name: 'borrowers.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  });

  await expect(dialog.getByLabel('אופן הייבוא')).toHaveValue('merge');
  const ledger = openLedger();
  const checkoutBefore = ledger
    .prepare('SELECT * FROM inventory_events WHERE id=?')
    .get(seed.checkoutId);
  await dialog.getByRole('button', { name: 'ייבוא', exact: true }).click();
  await expect(page.locator('#dialog-stack-root > *')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(
    ledger.prepare('SELECT archived FROM borrowers WHERE username=?').get('merge-browser')
      ?.archived,
  ).toBe(0);
  expect(
    ledger.prepare('SELECT archived FROM borrowers WHERE id=?').get(seed.borrower.id)?.archived,
  ).toBe(0);
  expect(ledger.prepare('SELECT * FROM inventory_events WHERE id=?').get(seed.checkoutId)).toEqual(
    checkoutBefore,
  );
  expect(
    ledger
      .prepare('SELECT COUNT(*) count FROM inventory_events WHERE related_event_id=?')
      .get(seed.checkoutId)?.count,
  ).toBe(0);
  await expect(page.getByText('שואל ממוזג', { exact: true })).toBeVisible();
});
