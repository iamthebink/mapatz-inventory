import { expect, test } from './fixtures';

test('creates a full-name-only borrower with empty optional fields', async ({
  page,
  openLedger,
}) => {
  const name = `שם מלא בלבד ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('link', { name: 'דלפק השאלות' }).click();
  await page.getByRole('button', { name: 'יצירת שואל חדש' }).click();
  const form = page.getByRole('dialog', { name: 'יצירת שואל חדש' });
  await form.getByLabel('שם מלא').fill(name);
  await form.getByRole('button', { name: 'יצירה' }).click();
  await expect(page.getByRole('dialog', { name: `כרטיס שואל — ${name}` })).toBeVisible();
  const ledger = openLedger();
  expect(
    ledger
      .prepare('SELECT playa_name,phone_number,camp_department FROM borrowers WHERE full_name=?')
      .get(name),
  ).toEqual({ playa_name: '', phone_number: '', camp_department: '' });
});

test('suggests camps outside filtered search and warns before creating a distinct likely match', async ({
  page,
}) => {
  const name = `שואל עם מחנה ${Date.now()}`;
  const camp = `מחנה לדוגמה ${Date.now()}`;
  await page.goto('/');
  const { ledgerEpoch } = await (await page.request.get('/api/borrowers/search?q=')).json();
  const create = await page.request.post('/api/borrowers', {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: {
      contractVersion: 1,
      ledgerEpoch,
      fullName: name,
      playaName: '',
      phoneNumber: '050111',
      campDepartment: camp,
    },
  });
  expect(create.status()).toBe(201);
  await page.getByRole('link', { name: 'דלפק השאלות' }).click();
  await page.getByRole('searchbox', { name: 'חיפוש שואל' }).fill('no matching directory profile');
  await page.getByRole('button', { name: 'יצירת שואל חדש' }).click();
  const form = page.getByRole('dialog', { name: 'יצירת שואל חדש' });
  await expect(form.locator(`#workflow-camp-suggestions option[value="${camp}"]`)).toHaveCount(1);
  await form.getByLabel('שם מלא').fill(name);
  await form.getByLabel('מספר טלפון').fill('052222');
  await form.getByLabel('מחנה / מחלקה').fill('מחנה חדש בטקסט חופשי');
  await expect(page.locator('.toast')).toContainText('נמצאו שואלים עם פרטים דומים');
  await expect(page.locator('.toast')).toContainText(camp);
  await form.getByRole('button', { name: 'יצירה' }).click();
  await expect(page.getByRole('dialog', { name: `כרטיס שואל — ${name}` })).toBeVisible();
  await expect(page.getByRole('dialog', { name: `כרטיס שואל — ${name}` })).toContainText(
    'מחנה חדש בטקסט חופשי',
  );
});

test('management Enter submission without blur preserves similar-profile guidance after commit', async ({
  page,
  seed,
}) => {
  await page.goto('/management');
  await page.getByRole('button', { name: 'הפעל מצב מנהל' }).click();
  const authentication = page.getByRole('dialog', { name: 'הפעלת מצב מנהל' });
  await authentication.locator('input[name="password"]').fill('e2e-admin-password');
  await authentication.getByRole('button', { name: 'הפעל מצב מנהל' }).click();
  await page.getByRole('tab', { name: /שואלים/ }).click();
  await page.getByRole('button', { name: 'יצירת שואל חדש' }).click();
  const form = page.getByRole('dialog', { name: 'יצירת שואל חדש' });
  const name = form.getByLabel('שם מלא');
  await name.fill(seed.borrower.fullName);
  await name.press('Enter');
  await expect(form).toBeHidden();
  const toast = page.locator('.toast');
  await expect(toast).toContainText('הפעולה הושלמה בהצלחה');
  await expect(toast).toContainText('נמצאו שואלים עם פרטים דומים');
  await expect(toast).toContainText(seed.borrower.phoneNumber);
  await expect(toast).toContainText(seed.borrower.campDepartment);
});
