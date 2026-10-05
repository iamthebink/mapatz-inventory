import { test, expect } from '@playwright/test';
import { launchElectron, finishApplication, saveDiagnostics } from './electron-helpers';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function cleanupProfile(profile: string) {
  const { readFile } = await import('node:fs/promises');
  const log = await readFile(join(profile, 'desktop.log')).catch(() =>
    Buffer.from('No desktop diagnostics emitted.'),
  );
  const logPath = test.info().outputPath('desktop.log');
  await writeFile(logPath, log);
  await test.info().attach('desktop.log', { path: logPath, contentType: 'text/plain' });
  await rm(profile, { recursive: true, force: true });
}

async function executable() {
  if (process.env.MAPATZ_EXECUTABLE) return process.env.MAPATZ_EXECUTABLE;
  const out = resolve('desktop-stage/out');
  const folder = (await readdir(out)).find(
    (name) => name.includes(process.platform) && name.endsWith(process.arch),
  );
  if (!folder) throw new Error('Run pnpm desktop:package first');
  return join(
    out,
    folder,
    process.platform === 'darwin'
      ? 'Mapatz Inventory.app/Contents/MacOS/mapatz-inventory'
      : 'mapatz-inventory.exe',
  );
}

test('packaged SQLite transactions, workbook roundtrip, setup and persistent relaunch', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'mapatz-desktop-'));
  const executablePath = await executable();
  const launch = () =>
    launchElectron({
      executablePath,
      cwd: tmpdir(),
      env: { ...process.env, MAPATZ_PROFILE: profile },
    });
  let application = await launch();
  try {
    const page = await application.firstWindow();
    await page.locator('#password').fill('camp-password-123');
    await page.locator('#confirmation').fill('camp-password-123');
    await page.getByRole('button', { name: 'שמירה ופתיחה' }).click();
    await page.waitForURL('http://127.0.0.1:*/');
    const origin = new URL(page.url()).origin;
    // Exercise packaged runtime modules in a utility process (not the checkout's Node).
    const proof = await application.evaluate(async ({ utilityProcess, app }) => {
      const path = process.getBuiltinModule('path');
      const fs = process.getBuiltinModule('fs');
      const os = process.getBuiltinModule('os');
      const script = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'mapatz-proof-')),
        'proof.cjs',
      );
      fs.writeFileSync(
        script,
        `const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require(${JSON.stringify(path.join(app.getAppPath(), 'node_modules/exceljs'))});
(async () => { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE proof (value INTEGER); BEGIN; INSERT INTO proof VALUES (7); ROLLBACK;');
if (db.prepare('SELECT count(*) AS n FROM proof').get().n !== 0 || db.isTransaction) throw new Error('Rollback failed');
db.exec('BEGIN; INSERT INTO proof VALUES (9); COMMIT;');
const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('בדיקה').addRow([db.prepare('SELECT value FROM proof').get().value]);
const restored = new ExcelJS.Workbook(); await restored.xlsx.load(await workbook.xlsx.writeBuffer());
process.parentPort.postMessage(restored.worksheets[0].getCell('A1').value); db.close(); })().catch(error => { process.parentPort.postMessage(String(error)); });`,
      );
      return await new Promise((resolve, reject) => {
        const child = utilityProcess.fork(script);
        child.on('message', (value) => {
          child.kill();
          fs.rmSync(path.dirname(script), { recursive: true, force: true });
          resolve(value);
        });
        child.on('exit', (code) => {
          if (code) reject(new Error(`Proof exited ${code}`));
        });
      });
    });
    expect(proof).toBe(9);
    await finishApplication(application, true);
    application = await launch();
    const reopened = await application.firstWindow();
    await reopened.waitForURL(`${origin}/`);
    await expect(reopened.locator('#password')).toHaveCount(0);
  } finally {
    await finishApplication(application);
    await cleanupProfile(profile);
  }
});

async function freshApp() {
  const profile = await mkdtemp(join(tmpdir(), 'mapatz-matrix-'));
  const executablePath = await executable();
  const launch = () =>
    launchElectron({
      executablePath,
      cwd: tmpdir(),
      env: { ...process.env, MAPATZ_PROFILE: profile },
    });
  const application = await launch();
  const page = await application.firstWindow();
  await page.locator('#password').fill('camp-password-123');
  await page.locator('#confirmation').fill('camp-password-123');
  await page.getByRole('button', { name: 'שמירה ופתיחה' }).click();
  await page.waitForURL('http://127.0.0.1:*/');
  await page.getByRole('link', { name: 'דלפק השאלות' }).click();
  await expect(page.getByRole('searchbox', { name: 'חיפוש שואל' })).toBeEnabled();
  return { application, page, profile, launch, executablePath };
}

test('packaged desktop recovery reveals the current password after the full ritual', async () => {
  test.setTimeout(90_000);
  const context = await freshApp();
  try {
    const exactPassword = '  camp\t password\n123  ';
    const passwordStatuses = await context.page.evaluate(async (password) => {
      const post = (path: string, body: object) =>
        fetch(`/api/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      return [
        (await post('session/role', { role: 'admin', password: 'camp-password-123' })).status,
        (await post('password', { password })).status,
        (await post('session/role', { role: 'operator' })).status,
      ];
    }, exactPassword);
    expect(passwordStatuses).toEqual([200, 204, 200]);
    await context.page.getByRole('button', { name: 'הפעל מצב מנהל' }).click();
    await context.page.getByRole('button', { name: 'שכחתי את סיסמת המנהל' }).click();
    await context.page.getByRole('button', { name: 'אני אידיוט.ית ושכחתי סיסמה' }).click();
    const phrase = context.page.getByRole('textbox', { name: 'בקשה להצגת הסיסמה' });
    await phrase.click();
    await expect(phrase).toHaveAttribute('placeholder', 'פה פה יא חמור.ה');
    await phrase.click();
    await phrase.fill('תראי');
    await expect(phrase).toHaveValue('');
    await expect(phrase).toHaveAttribute('placeholder', 'רגע בעצם פה');
    await phrase.fill('תראי לי את הסיסמה בבקשה');
    await context.page.getByRole('button', { name: 'אישור', exact: true }).click();
    const addition = context.page.getByTestId('recovery-addition');
    await expect(addition).toBeVisible();
    const original = await addition.textContent();
    for (let version = 0; version < 2; version++) {
      const digits = (await addition.textContent())!.match(/\d+/g)!.map(Number);
      await context.page
        .getByRole('textbox', { name: 'סכום המספרים' })
        .fill(String(digits[0]! + digits[1]!));
      await context.page.getByRole('button', { name: 'אישור', exact: true }).click();
      if (version === 0) await expect(addition).not.toHaveText(original!);
    }
    await context.page.getByRole('button', { name: 'די כבר, הגזמת' }).click();
    await context.page.getByRole('button', { name: 'לחצו כאן להצגת הסיסמה' }).click();
    await context.page.getByRole('radio', { name: 'לא', exact: true }).check();
    await context.page.getByRole('button', { name: 'אישור', exact: true }).click();
    await expect(context.page.getByRole('radio')).toHaveCount(1);
    await expect(context.page.getByText(/מצטער שנתתי רושם/)).toBeVisible();
    await context.page.getByRole('radio', { name: /^אתה ליטרלי/ }).check();
    await context.page.getByRole('button', { name: 'אישור', exact: true }).click();
    const passwordOutput = context.page.locator('output.admin-recovery-password');
    await expect(passwordOutput).toBeVisible();
    expect(await passwordOutput.textContent()).toBe(exactPassword);
    await expect(passwordOutput).toHaveCSS('white-space', 'pre-wrap');
    await context.page.getByRole('button', { name: 'העתקת הסיסמה' }).click();
    await expect(context.page.getByRole('status', { name: /הצלחה: העתקת הסיסמה/ })).toBeVisible();
    // Chromium writes native CRLF line endings to the Windows clipboard.
    // Compare the exact native representation; keep all other whitespace intact.
    const clipboardPassword =
      process.platform === 'win32' ? exactPassword.replace(/\n/g, '\r\n') : exactPassword;
    expect(await context.application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      clipboardPassword,
    );
    const readDenied = await context.page.evaluate(async () => {
      try {
        await navigator.clipboard.readText();
        return false;
      } catch (cause) {
        return cause instanceof DOMException && cause.name === 'NotAllowedError';
      }
    });
    expect(readDenied).toBe(true);
    await context.page.evaluate(async () => {
      const iframe = document.createElement('iframe');
      iframe.id = 'clipboard-child-test';
      iframe.src = location.origin;
      iframe.allow = 'clipboard-write';
      iframe.style.cssText =
        'position:fixed;top:80px;left:80px;width:240px;height:100px;z-index:2147483647;background:white';
      const loaded = new Promise<void>((resolve) => {
        iframe.onload = () => resolve();
      });
      document.body.append(iframe);
      await loaded;
    });
    const child = context.page
      .frames()
      .find((frame) => frame.parentFrame() === context.page.mainFrame())!;
    await child.evaluate(() => {
      const button = document.createElement('button');
      button.textContent = 'Attempt child clipboard write';
      button.onclick = async () => {
        try {
          await navigator.clipboard.writeText('child overwrite');
          document.body.dataset.clipboardResult = 'allowed';
        } catch (cause) {
          document.body.dataset.clipboardResult =
            cause instanceof DOMException ? cause.name : 'unexpected';
        }
      };
      document.body.replaceChildren(button);
    });
    await child.getByRole('button', { name: 'Attempt child clipboard write' }).click();
    await expect
      .poll(() => child.evaluate(() => document.body.dataset.clipboardResult))
      .toBe('NotAllowedError');
    expect(await context.application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      clipboardPassword,
    );
    await context.page.locator('#clipboard-child-test').evaluate((iframe) => iframe.remove());
    await context.page.screenshot({ path: test.info().outputPath('recovery-reveal.png') });
    await context.page.locator('.admin-recovery').getByRole('button', { name: 'סגירה' }).click();
    await expect(context.page.getByRole('alertdialog')).toContainText('הסיסמה תוסתר');
    await context.page.getByRole('button', { name: 'יציאה' }).click();
    await expect(context.page.getByRole('dialog')).toHaveCount(0);
    await context.page.emulateMedia({ reducedMotion: 'reduce' });
    await context.page.setViewportSize({ width: 600, height: 360 });
    await context.page.getByRole('button', { name: 'הפעל מצב מנהל' }).click();
    await context.page.getByRole('button', { name: 'שכחתי את סיסמת המנהל' }).click();
    await context.page.getByRole('button', { name: 'אני אידיוט.ית ושכחתי סיסמה' }).click();
    await phrase.click();
    await expect(phrase).toHaveAttribute('placeholder', 'פה פה יא חמור.ה');
    await phrase.click();
    await phrase.fill('abc');
    await expect(phrase).toHaveAttribute('placeholder', 'רגע בעצם פה');
    const submit = context.page.getByRole('button', { name: 'אישור', exact: true });
    await submit.scrollIntoViewIfNeeded();
    const submitBounds = await submit.boundingBox();
    const exitBounds = await context.page
      .getByRole('button', { name: 'יציאה מהשחזור' })
      .boundingBox();
    expect(submitBounds!.y + submitBounds!.height).toBeLessThanOrEqual(exitBounds!.y);
    await context.page.screenshot({ path: test.info().outputPath('recovery-short.png') });
    await context.page.getByRole('button', { name: 'יציאה מהשחזור' }).click();
    await context.page.getByRole('button', { name: 'להמשיך בשחזור' }).click();
    await expect(phrase).toHaveAttribute('placeholder', 'רגע בעצם פה');
    await context.page.getByRole('button', { name: 'יציאה מהשחזור' }).click();
    await context.page.getByRole('button', { name: 'יציאה', exact: true }).click();
    await expect(context.page.getByRole('button', { name: 'הפעל מצב מנהל' })).toBeFocused();
  } finally {
    await finishApplication(context.application);
    await cleanupProfile(context.profile);
  }
});

test('lost response survives replacement, replays once, and retains credential and origin', async () => {
  const context = await freshApp();
  let application = context.application;
  try {
    const origin = new URL(context.page.url()).origin;
    const key = await context.page.evaluate(async () => {
      const idempotencyKey = crypto.randomUUID();
      const body = {
        contractVersion: 1,
        ledgerEpoch: 1,
        playaName: 'recovered',
        fullName: 'שואל משוחזר',
        phoneNumber: '',
        campDepartment: '',
      };
      localStorage.setItem(
        `mapatz:frozen-attempt:v1:${idempotencyKey}`,
        JSON.stringify({
          version: 1,
          kind: 'create',
          endpoint: '/borrowers',
          subjectId: null,
          intent: 'create',
          idempotencyKey,
          ledgerEpoch: 1,
          body,
        }),
      );
      const response = await fetch('/api/borrowers', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
      });
      if (response.status !== 201) throw new Error(await response.text());
      // Deliberately leave the frozen envelope: equivalent to response lost after commit.
      return idempotencyKey;
    });
    const crashed = application.process();
    await finishApplication(application);
    await expect.poll(() => crashed.exitCode).not.toBeNull();
    // A new executable location models replacement independently of the saved profile.
    const replacement = await mkdtemp(join(tmpdir(), 'mapatz-replacement-'));
    const { cp } = await import('node:fs/promises');
    const sourceRoot =
      process.platform === 'darwin'
        ? resolve(context.executablePath, '../../..')
        : resolve(context.executablePath, '..');
    await cp(
      sourceRoot,
      join(replacement, process.platform === 'darwin' ? 'Mapatz Inventory.app' : 'app'),
      { recursive: true, verbatimSymlinks: true },
    );
    const replacementExecutable =
      process.platform === 'darwin'
        ? join(replacement, 'Mapatz Inventory.app/Contents/MacOS/mapatz-inventory')
        : join(replacement, 'app/mapatz-inventory.exe');
    application = await launchElectron({
      executablePath: replacementExecutable,
      cwd: tmpdir(),
      env: { ...process.env, MAPATZ_PROFILE: context.profile },
    });
    const page = await application.firstWindow();
    await page.waitForURL(`${origin}/`);
    await page.getByRole('link', { name: 'דלפק השאלות' }).click();
    await expect
      .poll(() =>
        page.evaluate((key) => localStorage.getItem(`mapatz:frozen-attempt:v1:${key}`), key),
      )
      .toBeNull();
    const borrowers = await page.evaluate(async () =>
      (await fetch('/api/borrowers?q=recovered')).json(),
    );
    expect(borrowers).toHaveLength(1);
    const credential = await page.evaluate(async () => {
      const response = await fetch('/api/session/role', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin', password: 'camp-password-123' }),
      });
      return response.status;
    });
    expect(credential).toBe(200);
    await finishApplication(application, true);
    await rm(replacement, { recursive: true, force: true });
  } finally {
    await finishApplication(application).catch(() => {});
    await cleanupProfile(context.profile);
  }
});

test('export UI reports disk completion and failure, keeps cancel neutral, and requires the launch token', async () => {
  const { application, page, profile } = await freshApp();
  try {
    await page.evaluate(async () =>
      fetch('/api/session/role', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin', password: 'camp-password-123' }),
      }),
    );
    await page.goto(`${new URL(page.url()).origin}/management`);
    await page.getByRole('tab', { name: /ייבוא וייצוא/ }).click();
    const submit = page
      .locator('form')
      .filter({ has: page.getByText('ייצוא מלאי', { exact: true }) })
      .getByRole('button', { name: 'בצע פעולה' });
    const target = join(profile, 'מלאי.xlsx');
    await application.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, target);
    await submit.click();
    await expect(page.getByRole('status', { name: /הצלחה: ייצוא מלאי/ })).toBeVisible();
    const { readFile } = await import('node:fs/promises');
    expect((await readFile(target)).subarray(0, 2).toString()).toBe('PK');
    await page.getByRole('button', { name: 'סגירת הודעה' }).click();
    await expect(page.locator('.toast')).toHaveCount(0);
    await application.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
    });
    await submit.click();
    await expect(submit).toBeEnabled();
    await expect(page.locator('.toast')).toHaveCount(0);
    await application.evaluate(
      ({ dialog }, target) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
      },
      join(profile, 'missing', 'file.xlsx'),
    );
    await submit.click();
    await expect(page.getByRole('alert', { name: /שגיאה: ייצוא מלאי/ })).toBeVisible();
    await expect(page.locator('.toast-success')).toHaveCount(0);
    expect((await fetch(`${new URL(page.url()).origin}/api/items`)).status).toBe(403);
  } finally {
    await finishApplication(application);
    await cleanupProfile(profile);
  }
});

test('unknown recovery blocks quit, dirty creation asks before discard, and second launch has one owner', async () => {
  const { application, page, profile, executablePath } = await freshApp();
  try {
    const { spawn } = await import('node:child_process');
    const duplicate = spawn(executablePath, [], {
      cwd: tmpdir(),
      env: { ...process.env, MAPATZ_PROFILE: profile },
      stdio: 'ignore',
    });
    await new Promise<void>((resolve) => duplicate.once('exit', () => resolve()));
    expect(application.windows()).toHaveLength(1);
    await page.getByRole('button', { name: 'יצירת שואל חדש' }).click();
    await page.getByLabel('שם מלא', { exact: true }).fill('טיוטה');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    const discard = page.getByRole('alertdialog', { name: 'לבטל טיוטת שואל?' });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'להמשיך לערוך' }).click();
    await expect(page.getByRole('dialog', { name: 'יצירת שואל חדש' })).toBeVisible();
    await expect(page.getByLabel('שם מלא', { exact: true })).toHaveValue('טיוטה');
    expect(application.windows()).toHaveLength(1);
    await page.getByRole('button', { name: 'ביטול', exact: true }).click();
    await discard.getByRole('button', { name: 'מחיקת טיוטה' }).click();
    await expect(page.getByRole('dialog', { name: 'יצירת שואל חדש' })).toHaveCount(0);
    await page.evaluate(() => localStorage.setItem('mapatz:frozen-attempt:v1:broken', '{}'));
    await page.reload();
    await expect(page.getByText('לא ניתן לקבוע בוודאות את מצב הפעולה. נסו שוב.')).toBeVisible();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect(page.getByText('יש להשלים שחזור לפני היציאה.')).toBeVisible();
    expect(application.windows()).toHaveLength(1);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByRole('searchbox', { name: 'חיפוש שואל' })).toBeVisible();
  } finally {
    await finishApplication(application);
    await cleanupProfile(profile);
  }
});

test('port collision and newer schema fail visibly without replacing data', async () => {
  const context = await freshApp();
  const { readFile } = await import('node:fs/promises');
  const { createServer } = await import('node:net');
  const { spawn } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  await finishApplication(context.application, true);
  const port = JSON.parse(await readFile(join(context.profile, 'profile.json'), 'utf8'))
    .port as number;
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const launch = () =>
    spawn(context.executablePath, [], {
      cwd: tmpdir(),
      env: { ...process.env, MAPATZ_PROFILE: context.profile },
      stdio: 'ignore',
    });
  let child = launch();
  const stop = async () => {
    const closed = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await closed;
  };
  try {
    await expect
      .poll(async () => readFile(join(context.profile, 'desktop.log'), 'utf8'))
      .toContain('EADDRINUSE');
    const diagnostic = await readFile(join(context.profile, 'desktop.log'), 'utf8');
    expect(diagnostic.match(/Backend ready/g)).toHaveLength(1);
    const dialogLine = diagnostic
      .split('\n')
      .find((line) => line.includes('"event":"failure-dialog"'))!;
    expect(JSON.parse(dialogLine.slice(dialogLine.indexOf('{'))).options).toMatchObject({
      type: 'error',
      buttons: ['נסה שוב', 'יציאה', 'איפוס מערכת'],
      defaultId: 0,
      cancelId: 1,
    });

    await stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const db = new DatabaseSync(join(context.profile, 'inventory.sqlite'));
    db.prepare('INSERT INTO migrations(version) VALUES (999)').run();
    db.close();
    child = launch();
    await expect
      .poll(async () => readFile(join(context.profile, 'desktop.log'), 'utf8'))
      .toContain('newer application');
    const check = new DatabaseSync(join(context.profile, 'inventory.sqlite'), { readOnly: true });
    expect(check.prepare('SELECT version FROM migrations WHERE version=999').get()).toBeTruthy();
    expect(check.prepare("SELECT 1 FROM credentials WHERE role='admin'").get()).toBeTruthy();
    check.close();
  } finally {
    if (child.exitCode === null) await stop();
    server.close();
    await cleanupProfile(context.profile);
  }
});

test('packaged inventory borrow/return, failed command rollback, and recovery workbook roundtrip', async () => {
  const { application, page, profile } = await freshApp();
  try {
    const result = await page.evaluate(async () => {
      const post = async (path: string, body: unknown, key?: string) => {
        const response = await fetch(`/api${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(key ? { 'Idempotency-Key': key } : {}),
          },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      await post('/session/role', { role: 'admin', password: 'camp-password-123' });
      const item = (await post('/items', { name: 'אוהל', kind: 'non_consumable' })).body;
      await post('/stock/add', { itemId: item.id, quantity: 5 });
      const borrower = (
        await post(
          '/borrowers',
          {
            contractVersion: 1,
            ledgerEpoch: 1,
            playaName: 'camp-user',
            fullName: 'שואל',
            phoneNumber: '',
            campDepartment: '',
          },
          crypto.randomUUID(),
        )
      ).body.borrower;
      const command = (parts: unknown[]) =>
        post(
          `/borrowers/${borrower.id}/operations`,
          { contractVersion: 1, ledgerEpoch: 1, items: parts },
          crypto.randomUUID(),
        );
      const borrowed = await command([{ itemId: item.id, borrow: [{ quantity: 2, note: '' }] }]);
      const before = await (await fetch('/api/ledger')).json();
      const rejected = await command([
        {
          itemId: item.id,
          borrow: [{ quantity: 100, note: '' }],
          return: [{ usable: 1, damaged: 0, note: '' }],
        },
      ]);
      const after = await (await fetch('/api/ledger')).json();
      const returned = await command([
        { itemId: item.id, return: [{ usable: 1, damaged: 1, note: '' }] },
      ]);
      const workbook = await (await fetch('/api/workbook')).arrayBuffer();
      const restored = await fetch('/api/workbook/recovery', {
        method: 'POST',
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'x-mapatz-confirmed': 'true',
        },
        body: workbook,
      });
      const items = await (await fetch('/api/items')).json();
      return {
        borrowed: borrowed.status,
        rejected: rejected.status,
        unchanged: JSON.stringify(before) === JSON.stringify(after),
        returned: returned.status,
        restored: restored.status,
        items,
      };
    });
    expect(result.borrowed).toBe(201);
    expect(result.rejected).toBe(409);
    expect(result.unchanged).toBe(true);
    expect(result.returned).toBe(201);
    expect(result.restored).toBe(204);
    expect(result.items[0]).toMatchObject({ available: 4, damaged: 1 });
  } finally {
    await finishApplication(application);
    await cleanupProfile(profile);
  }
});

for (const response of [0, 1])
  test(`backend failure offers retry/quit and safely executes choice ${response}`, async () => {
    const context = await freshApp();
    let application = context.application;
    try {
      const child = application.process();
      await application.evaluate(({ app, dialog }) => {
        const state = globalThis as typeof globalThis & {
          failureOptions?: unknown;
          finishFailure?: (value: { response: number; checkboxChecked: boolean }) => void;
          retryRequested?: boolean;
        };
        app.relaunch = () => {
          state.retryRequested = true;
        };
        dialog.showMessageBox = async (options: unknown) => {
          state.failureOptions = options;
          return new Promise((resolve) => {
            state.finishFailure = resolve;
          });
        };
        const utility = app
          .getAppMetrics()
          .find(
            (metric) => metric.type === 'Utility' && metric.serviceName?.includes('NodeService'),
          );
        if (!utility) throw new Error('Backend process missing');
        process.kill(utility.pid);
      });
      await expect
        .poll(() =>
          application.evaluate(
            () => (globalThis as typeof globalThis & { failureOptions?: unknown }).failureOptions,
          ),
        )
        .toMatchObject({
          type: 'error',
          buttons: ['נסה שוב', 'יציאה', 'איפוס מערכת'],
          defaultId: 0,
          cancelId: 1,
        });
      const options = await application.evaluate(
        () =>
          (globalThis as typeof globalThis & { failureOptions: { detail: string } }).failureOptions,
      );
      expect(options.detail).toContain('desktop.log');
      const retryMarker = join(context.profile, 'retry-requested');
      await saveDiagnostics(application);
      await application
        .evaluate(
          ({ app }, { response, retryMarker }) => {
            const state = globalThis as typeof globalThis & {
              finishFailure: (value: { response: number; checkboxChecked: boolean }) => void;
            };
            app.relaunch = () => {
              process.getBuiltinModule('fs').writeFileSync(retryMarker, 'retry');
            };
            state.finishFailure({ response, checkboxChecked: false });
          },
          { response, retryMarker },
        )
        .catch(() => {});
      await expect.poll(() => child.exitCode).toBe(0);
      const { readFile, stat } = await import('node:fs/promises');
      expect((await stat(join(context.profile, 'inventory.sqlite'))).size).toBeGreaterThan(0);
      if (response === 0) {
        expect(await readFile(retryMarker, 'utf8')).toBe('retry');
        application = await context.launch();
        const page = await application.firstWindow();
        await expect(page.getByRole('link', { name: 'דלפק השאלות' })).toBeVisible();
        await expect(page.locator('#password')).toHaveCount(0);
      }
    } finally {
      await finishApplication(application);
      await cleanupProfile(context.profile);
    }
  });

test('dirty staged quit requires discard and saving quit keeps backend alive', async () => {
  const { application, page, profile } = await freshApp();
  try {
    await page.evaluate(async () => {
      const post = async (path: string, body: unknown, key?: string) =>
        (
          await fetch(`/api${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(key ? { 'Idempotency-Key': key } : {}),
            },
            body: JSON.stringify(body),
          })
        ).json();
      await post('/session/role', { role: 'admin', password: 'camp-password-123' });
      const item = await post('/items', { name: 'ציוד לבדיקה', kind: 'non_consumable' });
      await post('/stock/add', { itemId: item.id, quantity: 5 });
      await post(
        '/borrowers',
        {
          contractVersion: 1,
          ledgerEpoch: 1,
          playaName: 'quit-test',
          fullName: 'בדיקת יציאה',
          phoneNumber: '',
          campDepartment: '',
        },
        crypto.randomUUID(),
      );
    });
    await page.reload();
    await page.getByRole('searchbox', { name: 'חיפוש שואל' }).fill('quit-test');
    await page.getByRole('button', { name: /פתיחת כרטיס שואל/ }).click();
    const search = page.getByRole('combobox', { name: 'חיפוש פריט' });
    await search.fill('ציוד לבדיקה');
    await page.getByRole('option', { name: /ציוד לבדיקה/ }).waitFor();
    await search.press('ArrowDown');
    await search.press('Enter');
    const quantity = page.getByRole('dialog', { name: 'הוספת השאלה' });
    await quantity.getByRole('spinbutton', { name: 'כמות' }).fill('1');
    await quantity.getByRole('button', { name: 'אישור' }).click();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    const discard = page.getByRole('alertdialog', { name: 'ביטול פעולות ממתינות?' });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: /המשך עבודה/ }).click();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/borrowers/*/operations', async (route) => {
      await held;
      await route.continue();
    });
    await page.getByRole('button', { name: 'אישור פעולות' }).click();
    await page.getByRole('button', { name: 'אישור ושמירה' }).click();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect(page.getByText('לא ניתן לצאת בזמן שמצב השמירה אינו ודאי.')).toBeVisible();
    expect(await page.evaluate(async () => (await fetch('/api/items')).status)).toBe(200);
    release();
    await expect(page.getByText('השמירה הושלמה.', { exact: true })).toBeVisible();
  } finally {
    await finishApplication(application);
    await cleanupProfile(profile);
  }
});

test('first-run validation and cancel leave setup retryable without a credential', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'mapatz-setup-'));
  const executablePath = await executable();
  const launch = () =>
    launchElectron({
      executablePath,
      cwd: tmpdir(),
      env: { ...process.env, MAPATZ_PROFILE: profile },
    });
  let application = await launch();
  try {
    const page = await application.firstWindow();
    await page.locator('#password').fill('camp-password-123');
    await page.locator('#confirmation').fill('different-password');
    await page.getByRole('button', { name: 'שמירה ופתיחה' }).click();
    await expect(page.getByRole('alert')).toHaveText('הסיסמאות אינן תואמות');
    await finishApplication(application, true);
    application = await launch();
    const retry = await application.firstWindow();
    await expect(retry.locator('#password')).toBeVisible();
    await expect(retry.locator('#password')).toHaveValue('');
  } finally {
    await finishApplication(application);
    await cleanupProfile(profile);
  }
});

test('non-desk reload blocks all app work until frozen recovery resolves', async () => {
  const { application, page, profile } = await freshApp();
  try {
    await page.evaluate(() => localStorage.setItem('mapatz:frozen-attempt:v1:broken', '{}'));
    await page.goto(`${new URL(page.url()).origin}/management`);
    await expect(page.getByRole('heading', { name: 'שחזור פעולות ממתינות' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'ניהול', exact: true })).toHaveCount(0);
    await expect(page.getByText('ייבוא איפוס שנתי', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'בצע פעולה' })).toHaveCount(0);
    await page.evaluate(() => localStorage.clear());
    await page.getByRole('button', { name: 'נסה שוב', exact: true }).click();
    await expect(page.getByRole('link', { name: 'ניהול', exact: true })).toBeVisible();
  } finally {
    await finishApplication(application);
    await cleanupProfile(profile);
  }
});

for (const emptyKind of ['zero-byte', 'empty-sqlite'])
  test(`initialized profile rejects ${emptyKind} replacement without bootstrap`, async () => {
    const context = await freshApp();
    await finishApplication(context.application, true);
    const { writeFile, readFile, stat } = await import('node:fs/promises');
    const { spawn } = await import('node:child_process');
    const filename = join(context.profile, 'inventory.sqlite');
    for (const suffix of ['', '-wal', '-shm']) await rm(`${filename}${suffix}`, { force: true });
    await writeFile(filename, '');
    if (emptyKind === 'empty-sqlite') {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(filename);
      db.exec('CREATE TABLE unrelated(value TEXT)');
      db.close();
    }
    const original = await readFile(filename);
    const child = spawn(context.executablePath, [], {
      cwd: tmpdir(),
      env: { ...process.env, MAPATZ_PROFILE: context.profile },
      stdio: 'ignore',
    });
    try {
      await expect
        .poll(() => readFile(join(context.profile, 'desktop.log'), 'utf8'))
        .toContain('empty or incomplete');
      expect(await readFile(filename)).toEqual(original);
      expect((await stat(filename)).size).toBe(original.length);
    } finally {
      const closed = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await closed;
      await cleanupProfile(context.profile);
    }
  });

for (const fault of ['profile-write', 'renderer-load'])
  test(`startup ${fault} failure still offers Quit when diagnostics cannot be written`, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'mapatz-startup-fault-'));
    const application = await launchElectron({
      executablePath: await executable(),
      cwd: tmpdir(),
      env: { ...process.env, MAPATZ_PROFILE: profile },
    });
    try {
      const page = await application.firstWindow();
      await page.locator('#password').fill('camp-password-123');
      await page.locator('#confirmation').fill('camp-password-123');
      await application.evaluate(({ BrowserWindow, dialog }, fault) => {
        const fs = process.getBuiltinModule('fs');
        const originalWrite = fs.writeFileSync;
        fs.appendFileSync = () => {
          throw new Error('Simulated unwritable diagnostic log');
        };
        if (fault === 'profile-write')
          fs.writeFileSync = (...args: Parameters<typeof originalWrite>) => {
            if (String(args[0]).endsWith('profile.json.tmp'))
              throw new Error('Simulated profile write failure');
            return originalWrite(...args);
          };
        process.getBuiltinModule('module').syncBuiltinESMExports();
        if (fault === 'renderer-load')
          BrowserWindow.getAllWindows()[0]!.loadURL = async () => {
            throw new Error('Simulated renderer load failure');
          };
        const state = globalThis as typeof globalThis & {
          failureOptions?: unknown;
          finishFailure?: (result: { response: number; checkboxChecked: boolean }) => void;
        };
        dialog.showMessageBox = async (options: unknown) => {
          state.failureOptions = options;
          return new Promise((resolve) => {
            state.finishFailure = resolve;
          });
        };
      }, fault);
      await page.getByRole('button', { name: 'שמירה ופתיחה' }).click();
      await expect
        .poll(() =>
          application.evaluate(
            () => (globalThis as typeof globalThis & { failureOptions?: unknown }).failureOptions,
          ),
        )
        .toMatchObject({ buttons: ['נסה שוב', 'יציאה', 'איפוס מערכת'], cancelId: 1 });
      const child = application.process();
      await saveDiagnostics(application);
      await application
        .evaluate(() =>
          (
            globalThis as typeof globalThis & {
              finishFailure: (result: { response: number; checkboxChecked: boolean }) => void;
            }
          ).finishFailure({ response: 1, checkboxChecked: false }),
        )
        .catch(() => {});
      await expect.poll(() => child.exitCode).toBe(0);
      const { stat } = await import('node:fs/promises');
      expect((await stat(join(profile, 'inventory.sqlite'))).size).toBeGreaterThan(0);
    } finally {
      await finishApplication(application);
      await cleanupProfile(profile);
    }
  });

test('repeated clean quits stop the backend and main process', async () => {
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const context = await freshApp();
    try {
      const child = context.application.process();
      await finishApplication(context.application, true);
      expect(child.exitCode).toBe(0);
    } finally {
      await finishApplication(context.application);
      await cleanupProfile(context.profile);
    }
  }
});

test('quit drains an incomplete local HTTP connection without a windowless process', async () => {
  const context = await freshApp();
  const { createConnection } = await import('node:net');
  const port = Number(new URL(context.page.url()).port);
  const socket = createConnection({ host: '127.0.0.1', port });
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  const child = context.application.process();
  const closing = finishApplication(context.application, true);
  try {
    await expect.poll(() => child.exitCode, { timeout: 3_000 }).toBe(0);
  } finally {
    socket.destroy();
    await closing;
    await cleanupProfile(context.profile);
  }
});

test('normal quit lets an accepted command finish before closing SQLite', async () => {
  const context = await freshApp();
  const { application, page, profile } = context;
  const { createConnection } = await import('node:net');
  await application.evaluate(({ session }) => {
    session.defaultSession.webRequest.onSendHeaders((details) => {
      const token = details.requestHeaders['x-mapatz-desktop-token'];
      if (typeof token === 'string')
        (globalThis as typeof globalThis & { launchToken?: string }).launchToken = token;
    });
  });
  await page.evaluate(async () => fetch('/api/session'));
  const token = await application.evaluate(
    () => (globalThis as typeof globalThis & { launchToken?: string }).launchToken,
  );
  expect(token).toBeTruthy();
  const port = Number(new URL(page.url()).port);
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  const body = JSON.stringify({
    contractVersion: 1,
    ledgerEpoch: 1,
    playaName: 'drained-command',
    fullName: 'Drain',
    phoneNumber: '',
    campDepartment: '',
  });
  const key = '00000000-0000-4000-8000-000000000099';
  let response = '';
  socket.on('data', (chunk) => {
    response += chunk.toString();
  });
  socket.write(
    `POST /api/borrowers HTTP/1.1\r\nHost: 127.0.0.1\r\nx-mapatz-desktop-token: ${token}\r\nContent-Type: application/json\r\nIdempotency-Key: ${key}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 1)}`,
  );
  // A successful roundtrip after sending the first body byte orders this test behind header parsing.
  await page.evaluate(async () => fetch('/api/session'));
  const child = application.process();
  const closing = finishApplication(application, true);
  try {
    const { readFile } = await import('node:fs/promises');
    await expect
      .poll(() => readFile(join(profile, 'desktop.log'), 'utf8'))
      .toContain('Backend stop received');
    expect(child.exitCode).toBeNull();
    socket.end(body.slice(1));
    await closing;
    expect(response).toContain('201 Created');
    expect(response).toContain('"outcome":"committed"');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(profile, 'inventory.sqlite'), { readOnly: true });
    expect(
      db
        .prepare("SELECT count(*) AS count FROM borrowers WHERE playa_name='drained-command'")
        .get(),
    ).toEqual({ count: 1 });
    db.close();
  } finally {
    socket.destroy();
    await closing;
    await cleanupProfile(profile);
  }
});

async function interceptResetRestart(
  application: Awaited<ReturnType<typeof launchElectron>>,
  profile: string,
) {
  await application.evaluate(({ app }, profile) => {
    app.relaunch = () =>
      process
        .getBuiltinModule('fs')
        .writeFileSync(process.getBuiltinModule('path').join(profile, 'reset-relaunch'), 'yes');
  }, profile);
}

async function initiateReset(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launchElectron>>['firstWindow']>>,
) {
  await page.evaluate(() => {
    void fetch('/api/system/reset', { method: 'POST' }).then(async (response) => {
      (window as typeof window & { resetResponse?: unknown }).resetResponse = {
        status: response.status,
        body: await response.json(),
      };
    });
  });
}

test('factory reset cancels unchanged, rejects renderer IPC, drains and clears pending state, then supports workbook recovery', async () => {
  test.setTimeout(90_000);
  const context = await freshApp();
  let application = context.application;
  try {
    const workbook = await context.page.evaluate(async () => {
      await fetch('/api/session/role', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin', password: 'camp-password-123' }),
      });
      const item = await (
        await fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'ציוד לשחזור', kind: 'non_consumable' }),
        })
      ).json();
      await fetch('/api/stock/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, quantity: 7 }),
      });
      localStorage.setItem('mapatz:frozen-attempt:v1:broken', '{}');
      return Array.from(new Uint8Array(await (await fetch('/api/workbook')).arrayBuffer()));
    });
    await writeFile(join(context.profile, 'preserved.xlsx'), Buffer.from(workbook));
    const { mkdir, readFile, stat } = await import('node:fs/promises');
    await mkdir(join(context.profile, 'backups'), { recursive: true });
    await writeFile(join(context.profile, 'backups', 'internal.sqlite'), 'old');
    const originalProfile = await readFile(join(context.profile, 'profile.json'), 'utf8');
    await initiateReset(context.page);
    let confirmation = await application.waitForEvent('window');
    await confirmation.waitForURL('**/reset.html');
    await expect(confirmation.locator('body')).toContainText(
      'קבצים בתיקיית הגיבויים הפנימיים יימחקו',
    );
    await expect(confirmation.locator('body')).toContainText('קבצים שיוצאו מחוץ לתיקייה זו יישמרו');
    // Application renderer has the bridge but cannot authorize local confirmation IPC.
    expect(
      await context.page.evaluate(async () => {
        try {
          await (
            window.mapatzDesktop as unknown as { confirmReset(phrase: string): Promise<void> }
          ).confirmReset('איפוס מערכת');
          return 'accepted';
        } catch {
          return 'rejected';
        }
      }),
    ).toBe('rejected');
    await confirmation.locator('#phrase').fill('איפוס מערכת ');
    await expect(confirmation.locator('#confirm')).toBeDisabled();
    await confirmation.getByRole('button', { name: 'ביטול', exact: true }).click();
    await expect
      .poll(() =>
        context.page.evaluate(
          () => (window as typeof window & { resetResponse?: unknown }).resetResponse,
        ),
      )
      .toEqual({ status: 200, body: { outcome: 'cancelled' } });
    expect(await readFile(join(context.profile, 'profile.json'), 'utf8')).toBe(originalProfile);
    expect(
      await context.page.evaluate(() => localStorage.getItem('mapatz:frozen-attempt:v1:broken')),
    ).toBe('{}');
    await interceptResetRestart(application, context.profile);
    const child = application.process();
    await initiateReset(context.page);
    confirmation = await application.waitForEvent('window');
    await confirmation.waitForURL('**/reset.html');
    await confirmation.locator('#phrase').fill('איפוס מערכת');
    await saveDiagnostics(application);
    await confirmation.locator('#confirm').click();
    await expect.poll(() => child.exitCode).toBe(0);
    const log = await readFile(join(context.profile, 'desktop.log'), 'utf8');
    expect(log.indexOf('Backend database closed')).toBeLessThan(
      log.indexOf('System reset complete'),
    );
    expect(await readFile(join(context.profile, 'reset-relaunch'), 'utf8')).toBe('yes');
    await expect(stat(join(context.profile, 'inventory.sqlite'))).rejects.toThrow();
    await expect(stat(join(context.profile, 'backups'))).rejects.toThrow();
    expect(await readFile(join(context.profile, 'preserved.xlsx'))).toEqual(Buffer.from(workbook));
    await expect(stat(join(context.profile, 'profile.json'))).rejects.toThrow();
    // Reuse the old origin only in this fresh, uninitialized test profile to prove its storage was cleared.
    await writeFile(
      join(context.profile, 'profile.json'),
      JSON.stringify({ port: JSON.parse(originalProfile).port }),
    );
    application = await context.launch();
    const setup = await application.firstWindow();
    await setup.locator('#password').fill('new-password-123');
    await setup.locator('#confirmation').fill('new-password-123');
    await setup.getByRole('button', { name: 'שמירה ופתיחה' }).click();
    await setup.waitForURL('http://127.0.0.1:*/');
    expect(new URL(setup.url()).port).toBe(String(JSON.parse(originalProfile).port));
    expect(
      await setup.evaluate(() => localStorage.getItem('mapatz:frozen-attempt:v1:broken')),
    ).toBeNull();
    expect(await setup.evaluate(async () => (await fetch('/api/items')).json())).toEqual([]);
    const restored = await setup.evaluate(async (workbook) => {
      const post = async (password: string) =>
        (
          await fetch('/api/session/role', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ role: 'admin', password }),
          })
        ).status;
      const oldPassword = await post('camp-password-123');
      const newPassword = await post('new-password-123');
      const imported = await fetch('/api/workbook/recovery', {
        method: 'POST',
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'x-mapatz-confirmed': 'true',
        },
        body: new Uint8Array(workbook),
      });
      return {
        oldPassword,
        newPassword,
        imported: imported.status,
        items: await (await fetch('/api/items')).json(),
      };
    }, workbook);
    expect(restored).toMatchObject({
      oldPassword: 401,
      newPassword: 200,
      imported: 204,
      items: [{ name: 'ציוד לשחזור', available: 7 }],
    });
  } finally {
    await finishApplication(application);
    await cleanupProfile(context.profile);
  }
});

for (const corrupt of [false, true])
  test(`failure recovery factory reset works with ${corrupt ? 'corrupt SQLite' : 'incompatible SQLite'}`, async () => {
    const context = await freshApp();
    let application = context.application;
    try {
      await application.evaluate(({ app, dialog }) => {
        const state = globalThis as typeof globalThis & {
          resetFailure?: unknown;
          selectReset?: (result: { response: number; checkboxChecked: boolean }) => void;
        };
        dialog.showMessageBox = async (options: unknown) => {
          state.resetFailure = options;
          return new Promise((resolve) => {
            state.selectReset = resolve;
          });
        };
        const backend = app
          .getAppMetrics()
          .find(
            (metric) => metric.type === 'Utility' && metric.serviceName?.includes('NodeService'),
          );
        if (!backend) throw new Error('Backend missing');
        process.kill(backend.pid);
      });
      await expect
        .poll(() =>
          application.evaluate(
            () => (globalThis as typeof globalThis & { resetFailure?: unknown }).resetFailure,
          ),
        )
        .toMatchObject({ buttons: ['נסה שוב', 'יציאה', 'איפוס מערכת'] });
      if (corrupt) await writeFile(join(context.profile, 'inventory.sqlite'), 'corrupt SQLite');
      else {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(join(context.profile, 'inventory.sqlite'));
        db.exec('INSERT INTO migrations(version) VALUES (9999)');
        db.close();
      }
      await interceptResetRestart(application, context.profile);
      const child = application.process();
      await application.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            selectReset: (result: { response: number; checkboxChecked: boolean }) => void;
          }
        ).selectReset({ response: 2, checkboxChecked: false }),
      );
      const confirmation = await application.waitForEvent('window');
      await confirmation.waitForURL('**/reset.html');
      await confirmation.locator('#phrase').fill('איפוס מערכת');
      await saveDiagnostics(application);
      await confirmation.locator('#confirm').click();
      await expect.poll(() => child.exitCode).toBe(0);
      application = await context.launch();
      const setup = await application.firstWindow();
      await expect(setup.locator('#password')).toBeVisible();
    } finally {
      await finishApplication(application);
      await cleanupProfile(context.profile);
    }
  });

for (const fault of ['invalid-profile', 'missing-profile', 'corrupt-database', 'newer-database'])
  test(`built Electron runtime resets startup ${fault} independently of main window`, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'mapatz-reset-pre-window-'));
    const bootstrap = await mkdtemp(join(tmpdir(), 'mapatz-reset-bootstrap-'));
    if (fault === 'invalid-profile')
      await writeFile(join(profile, 'profile.json'), '{broken-profile');
    if (fault === 'corrupt-database' || fault === 'newer-database')
      await writeFile(
        join(profile, 'profile.json'),
        JSON.stringify({ port: 23456, initialized: fault === 'corrupt-database' }),
      );
    if (fault === 'newer-database') {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(join(profile, 'inventory.sqlite'));
      db.exec(
        'CREATE TABLE migrations(version INTEGER); INSERT INTO migrations(version) VALUES (9999)',
      );
      db.close();
    } else await writeFile(join(profile, 'inventory.sqlite'), 'corrupt database');
    await writeFile(
      join(bootstrap, 'package.json'),
      JSON.stringify({ type: 'module', main: 'bootstrap.mjs' }),
    );
    await writeFile(
      join(bootstrap, 'bootstrap.mjs'),
      `import { app, dialog } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
dialog.showMessageBox = async options => {
  globalThis.startupResetFailure = options;
  return new Promise(resolve => { globalThis.selectStartupReset = resolve; });
};
app.relaunch = () => writeFileSync(join(app.getPath('userData'), 'reset-relaunch'), 'yes');
await import(${JSON.stringify(new URL('file://' + resolve('desktop-stage/dist/desktop/main.js')).href)});`,
    );
    // The test bootstrap installs native-dialog control before importing the exact staged main/assets.
    // Packaged-binary tests above cover the normal launch; this covers failure before any main window.
    let application = await launchElectron({
      args: [bootstrap],
      cwd: tmpdir(),
      env: { ...process.env, MAPATZ_PROFILE: profile },
    });
    try {
      await expect
        .poll(() =>
          application.evaluate(
            () =>
              (globalThis as typeof globalThis & { startupResetFailure?: unknown })
                .startupResetFailure,
          ),
        )
        .toMatchObject({ buttons: ['נסה שוב', 'יציאה', 'איפוס מערכת'] });
      expect(
        await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      ).toBe(fault.endsWith('profile') ? 0 : 1);
      const confirmationOpened = application.waitForEvent('window');
      await application.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            selectStartupReset: (result: { response: number; checkboxChecked: boolean }) => void;
          }
        ).selectStartupReset({ response: 2, checkboxChecked: false }),
      );
      let confirmation = await confirmationOpened;
      await confirmation.waitForURL('**/reset.html');
      if (fault === 'invalid-profile') {
        await confirmation.locator('#phrase').fill('איפוס');
        await expect(confirmation.locator('#confirm')).toBeDisabled();
        await confirmation.locator('#cancel').click();
        await expect
          .poll(() =>
            application.evaluate(
              () =>
                (globalThis as typeof globalThis & { startupResetFailure?: { message: string } })
                  .startupResetFailure?.message,
            ),
          )
          .toContain('בוטל');
        const { readFile } = await import('node:fs/promises');
        expect(await readFile(join(profile, 'profile.json'), 'utf8')).toBe('{broken-profile');
        expect(await readFile(join(profile, 'inventory.sqlite'), 'utf8')).toBe('corrupt database');
        const retryOpened = application.waitForEvent('window');
        await application.evaluate(() =>
          (
            globalThis as typeof globalThis & {
              selectStartupReset: (result: { response: number; checkboxChecked: boolean }) => void;
            }
          ).selectStartupReset({ response: 2, checkboxChecked: false }),
        );
        confirmation = await retryOpened;
        await confirmation.waitForURL('**/reset.html');
      }
      await confirmation.locator('#phrase').fill('איפוס מערכת');
      const child = application.process();
      await saveDiagnostics(application);
      await confirmation.locator('#confirm').click();
      await expect.poll(() => child.exitCode).toBe(0);
      application = await launchElectron({
        executablePath: await executable(),
        cwd: tmpdir(),
        env: { ...process.env, MAPATZ_PROFILE: profile },
      });
      await expect((await application.firstWindow()).locator('#password')).toBeVisible();
    } finally {
      await finishApplication(application);
      await cleanupProfile(profile);
      await rm(bootstrap, { recursive: true, force: true });
    }
  });

test('storage-clear failure preserves database and offers retry that completes', async () => {
  const context = await freshApp();
  let application = context.application;
  try {
    await context.page.evaluate(async () => {
      await fetch('/api/session/role', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin', password: 'camp-password-123' }),
      });
    });
    await application.evaluate(({ session, dialog }) => {
      const state = globalThis as typeof globalThis & {
        clearFailure?: unknown;
        retryReset?: (result: { response: number; checkboxChecked: boolean }) => void;
        restoreClear?: () => void;
      };
      const original = session.defaultSession.clearStorageData.bind(session.defaultSession);
      session.defaultSession.clearStorageData = async () => {
        throw new Error('Simulated storage failure');
      };
      state.restoreClear = () => {
        session.defaultSession.clearStorageData = original;
      };
      dialog.showMessageBox = async (options: unknown) => {
        state.clearFailure = options;
        return new Promise((resolve) => {
          state.retryReset = resolve;
        });
      };
    });
    await interceptResetRestart(application, context.profile);
    const firstOpened = application.waitForEvent('window');
    await initiateReset(context.page);
    const first = await firstOpened;
    await first.waitForURL('**/reset.html');
    await first.locator('#phrase').fill('איפוס מערכת');
    await first.locator('#confirm').click();
    await expect
      .poll(() =>
        application.evaluate(
          () => (globalThis as typeof globalThis & { clearFailure?: unknown }).clearFailure,
        ),
      )
      .toMatchObject({
        message: expect.stringContaining('Simulated storage failure'),
        buttons: ['נסה שוב', 'יציאה', 'איפוס מערכת'],
      });
    const { stat } = await import('node:fs/promises');
    expect((await stat(join(context.profile, 'inventory.sqlite'))).size).toBeGreaterThan(0);
    expect(application.windows()).toHaveLength(0);
    const retryOpened = application.waitForEvent('window');
    await application.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        restoreClear: () => void;
        retryReset: (result: { response: number; checkboxChecked: boolean }) => void;
      };
      state.restoreClear();
      state.retryReset({ response: 0, checkboxChecked: false });
    });
    let retry = await retryOpened;
    await retry.waitForURL('**/reset.html');
    await retry.locator('#cancel').click();
    await expect
      .poll(() =>
        application.evaluate(
          () =>
            (globalThis as typeof globalThis & { clearFailure?: { message: string } }).clearFailure
              ?.message,
        ),
      )
      .toContain('ייתכן שחלק מהנתונים כבר נמחקו');
    expect(
      await application.evaluate(
        () =>
          (globalThis as typeof globalThis & { clearFailure?: { message: string } }).clearFailure
            ?.message,
      ),
    ).not.toContain('הנתונים נשמרו');
    const confirmedRetryOpened = application.waitForEvent('window');
    await application.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          retryReset: (result: { response: number; checkboxChecked: boolean }) => void;
        }
      ).retryReset({ response: 0, checkboxChecked: false }),
    );
    retry = await confirmedRetryOpened;
    await retry.waitForURL('**/reset.html');
    await retry.locator('#phrase').fill('איפוס מערכת');
    const child = application.process();
    await saveDiagnostics(application);
    await retry.locator('#confirm').click();
    await expect.poll(() => child.exitCode).toBe(0);
    application = await context.launch();
    await expect((await application.firstWindow()).locator('#password')).toBeVisible();
  } finally {
    await finishApplication(application);
    await cleanupProfile(context.profile);
  }
});

for (const outcome of ['retry', 'exit'])
  test(`backend stop timeout never deletes a live owner and permits ${outcome}`, async () => {
    test.skip(process.platform === 'win32', 'SIGSTOP is available on the local Unix runtime');
    test.setTimeout(90_000);
    const context = await freshApp();
    let application = context.application;
    let backendPid: number | undefined;
    try {
      await context.page.evaluate(async () => {
        await fetch('/api/session/role', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'admin', password: 'camp-password-123' }),
        });
      });
      await application.evaluate(({ dialog }) => {
        const state = globalThis as typeof globalThis & {
          stopFailure?: unknown;
          retryStoppedReset?: (result: { response: number; checkboxChecked: boolean }) => void;
        };
        dialog.showMessageBox = async (options: unknown) => {
          state.stopFailure = options;
          return new Promise((resolve) => {
            state.retryStoppedReset = resolve;
          });
        };
      });
      await interceptResetRestart(application, context.profile);
      const opened = application.waitForEvent('window');
      await initiateReset(context.page);
      const confirmation = await opened;
      await confirmation.waitForURL('**/reset.html');
      backendPid = await application.evaluate(({ app }) => {
        const backend = app
          .getAppMetrics()
          .find(
            (metric) => metric.type === 'Utility' && metric.serviceName?.includes('NodeService'),
          );
        if (!backend) throw new Error('Backend missing');
        process.kill(backend.pid, 'SIGSTOP');
        return backend.pid;
      });
      await confirmation.locator('#phrase').fill('איפוס מערכת');
      await confirmation.locator('#confirm').click();
      await expect
        .poll(
          () =>
            application.evaluate(
              () => (globalThis as typeof globalThis & { stopFailure?: unknown }).stopFailure,
            ),
          { timeout: 40_000 },
        )
        .toMatchObject({
          message: expect.stringContaining('no files were deleted'),
          buttons: ['נסה שוב', 'יציאה', 'איפוס מערכת'],
        });
      const { stat } = await import('node:fs/promises');
      expect((await stat(join(context.profile, 'inventory.sqlite'))).size).toBeGreaterThan(0);
      if (outcome === 'exit') {
        const child = application.process();
        await saveDiagnostics(application);
        await application
          .evaluate(() =>
            (
              globalThis as typeof globalThis & {
                retryStoppedReset: (result: { response: number; checkboxChecked: boolean }) => void;
              }
            ).retryStoppedReset({ response: 1, checkboxChecked: false }),
          )
          .catch(() => {});
        await expect.poll(() => child.exitCode).toBe(0);
        backendPid = undefined;
        expect((await stat(join(context.profile, 'inventory.sqlite'))).size).toBeGreaterThan(0);
        return;
      }
      await application.evaluate((_electron, pid) => process.kill(pid, 'SIGCONT'), backendPid);
      backendPid = undefined;
      await expect
        .poll(() =>
          application.evaluate(({ app }) =>
            app
              .getAppMetrics()
              .some(
                (metric) =>
                  metric.type === 'Utility' && metric.serviceName?.includes('NodeService'),
              ),
          ),
        )
        .toBe(false);
      const retryOpened = application.waitForEvent('window');
      await application.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            retryStoppedReset: (result: { response: number; checkboxChecked: boolean }) => void;
          }
        ).retryStoppedReset({ response: 0, checkboxChecked: false }),
      );
      const retry = await retryOpened;
      await retry.waitForURL('**/reset.html');
      await retry.locator('#phrase').fill('איפוס מערכת');
      const child = application.process();
      await saveDiagnostics(application);
      await retry.locator('#confirm').click();
      await expect.poll(() => child.exitCode).toBe(0);
      application = await context.launch();
      await expect((await application.firstWindow()).locator('#password')).toBeVisible();
    } finally {
      if (backendPid)
        await application
          .evaluate((_electron, pid) => process.kill(pid, 'SIGCONT'), backendPid)
          .catch(() => {});
      await finishApplication(application);
      await cleanupProfile(context.profile);
    }
  });

test('admin settings reset button requires admin and returns from local cancellation', async () => {
  const context = await freshApp();
  try {
    await context.page.getByRole('link', { name: 'ניהול', exact: true }).click();
    await context.page.getByRole('tab', { name: /הרשאות והגדרות/ }).click();
    await expect(
      context.page.getByRole('button', { name: 'איפוס מערכת', exact: true }),
    ).toBeDisabled();
    await context.page.evaluate(async () => {
      await fetch('/api/session/role', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin', password: 'camp-password-123' }),
      });
    });
    await context.page.reload();
    await context.page.getByRole('tab', { name: /הרשאות והגדרות/ }).click();
    const reset = context.page.getByRole('button', { name: 'איפוס מערכת', exact: true });
    await expect(reset).toBeEnabled();
    const opened = context.application.waitForEvent('window');
    await reset.click();
    const confirmation = await opened;
    await confirmation.waitForURL('**/reset.html');
    await expect(context.page.getByRole('button', { name: 'ממתין לאישור…' })).toBeDisabled();
    await confirmation.locator('#cancel').click();
    await expect(reset).toBeEnabled();
    expect(await context.page.evaluate(async () => (await fetch('/api/items')).status)).toBe(200);
  } finally {
    await finishApplication(context.application);
    await cleanupProfile(context.profile);
  }
});

test('confirmation renderer crash cancels and permits another confirmation and ordinary exit', async () => {
  const context = await freshApp();
  try {
    await context.page.evaluate(async () => {
      await fetch('/api/session/role', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin', password: 'camp-password-123' }),
      });
    });
    const opened = context.application.waitForEvent('window');
    await initiateReset(context.page);
    await (await opened).waitForURL('**/reset.html');
    await context.application.evaluate(({ BrowserWindow }) => {
      const confirmation = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().endsWith('/reset.html'),
      );
      if (!confirmation) throw new Error('Reset confirmation missing');
      confirmation.webContents.forcefullyCrashRenderer();
    });
    await expect
      .poll(() =>
        context.page.evaluate(
          () => (window as typeof window & { resetResponse?: unknown }).resetResponse,
        ),
      )
      .toEqual({ status: 200, body: { outcome: 'cancelled' } });
    expect(
      await context.application.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    ).toBe(1);
    const retryOpened = context.application.waitForEvent('window');
    await initiateReset(context.page);
    const retry = await retryOpened;
    await retry.waitForURL('**/reset.html');
    await retry.locator('#cancel').click();
    await expect
      .poll(() =>
        context.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      )
      .toBe(1);
    const child = context.application.process();
    await saveDiagnostics(context.application);
    await context.application
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
      .catch(() => {});
    await expect.poll(() => child.exitCode).toBe(0);
    const { stat } = await import('node:fs/promises');
    expect((await stat(join(context.profile, 'inventory.sqlite'))).size).toBeGreaterThan(0);
  } finally {
    await finishApplication(context.application);
    await cleanupProfile(context.profile);
  }
});

test('backend death while confirmation is open surfaces failure after cancellation and permits exit', async () => {
  const context = await freshApp();
  try {
    await context.page.evaluate(async () => {
      await fetch('/api/session/role', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin', password: 'camp-password-123' }),
      });
    });
    await context.application.evaluate(({ dialog }) => {
      const state = globalThis as typeof globalThis & {
        deferredBackendFailure?: unknown;
        finishDeferredFailure?: (result: { response: number; checkboxChecked: boolean }) => void;
      };
      dialog.showMessageBox = async (options: unknown) => {
        state.deferredBackendFailure = options;
        return new Promise((resolve) => {
          state.finishDeferredFailure = resolve;
        });
      };
    });
    const opened = context.application.waitForEvent('window');
    await initiateReset(context.page);
    const confirmation = await opened;
    await confirmation.waitForURL('**/reset.html');
    await context.application.evaluate(({ app }) => {
      const owner = app
        .getAppMetrics()
        .find((metric) => metric.type === 'Utility' && metric.serviceName?.includes('NodeService'));
      if (!owner) throw new Error('Backend missing');
      process.kill(owner.pid);
    });
    await expect
      .poll(() =>
        context.application.evaluate(({ app }) =>
          app
            .getAppMetrics()
            .some(
              (metric) => metric.type === 'Utility' && metric.serviceName?.includes('NodeService'),
            ),
        ),
      )
      .toBe(false);
    await confirmation.locator('#cancel').click();
    await expect
      .poll(() =>
        context.application.evaluate(
          () =>
            (globalThis as typeof globalThis & { deferredBackendFailure?: unknown })
              .deferredBackendFailure,
        ),
      )
      .toMatchObject({
        message: expect.stringContaining('Backend stopped'),
        buttons: ['נסה שוב', 'יציאה', 'איפוס מערכת'],
      });
    const { stat } = await import('node:fs/promises');
    expect((await stat(join(context.profile, 'inventory.sqlite'))).size).toBeGreaterThan(0);
    const child = context.application.process();
    await saveDiagnostics(context.application);
    await context.application
      .evaluate(() =>
        (
          globalThis as typeof globalThis & {
            finishDeferredFailure: (result: { response: number; checkboxChecked: boolean }) => void;
          }
        ).finishDeferredFailure({ response: 1, checkboxChecked: false }),
      )
      .catch(() => {});
    await expect.poll(() => child.exitCode).toBe(0);
  } finally {
    await finishApplication(context.application);
    await cleanupProfile(context.profile);
  }
});
