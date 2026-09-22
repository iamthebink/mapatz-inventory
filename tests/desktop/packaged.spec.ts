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
        username: 'recovered',
        name: 'שואל משוחזר',
        contact: '',
        type: 'individual',
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
    page.once('dialog', (dialog) => void dialog.dismiss());
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'ביטול', exact: true }).click();
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
      buttons: ['נסה שוב', 'יציאה'],
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
            username: 'camp-user',
            name: 'שואל',
            contact: '',
            type: 'individual',
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
        .toMatchObject({ type: 'error', buttons: ['נסה שוב', 'יציאה'], defaultId: 0, cancelId: 1 });
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
          username: 'quit-test',
          name: 'בדיקת יציאה',
          contact: '',
          type: 'individual',
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
        .toMatchObject({ buttons: ['נסה שוב', 'יציאה'], cancelId: 1 });
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
    username: 'drained-command',
    name: 'Drain',
    contact: '',
    type: 'individual',
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
      db.prepare("SELECT count(*) AS count FROM borrowers WHERE username='drained-command'").get(),
    ).toEqual({ count: 1 });
    db.close();
  } finally {
    socket.destroy();
    await closing;
    await cleanupProfile(profile);
  }
});
