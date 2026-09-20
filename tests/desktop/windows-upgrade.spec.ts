import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { launchElectron, finishApplication, saveDiagnostics } from './electron-helpers';

const exec = promisify(execFile);
const baselineVersion = '0.1.0';
const password = 'upgrade-rehearsal-password';

async function post(page: Page, path: string, body: unknown, key?: string) {
  return page.evaluate(
    async ({ path, body, key }) => {
      const response = await fetch(`/api${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
      return response.json();
    },
    { path, body, key },
  );
}

async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const get = async (path: string) => {
      const response = await fetch(`/api${path}`);
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      return response.json();
    };
    return {
      items: await get('/items'),
      borrowers: await get('/borrowers'),
      ledger: await get('/ledger'),
    };
  });
}

async function install(installer: string, phase: string) {
  // Wait for the complete installer process tree, not just the bootstrapper.
  const result = await exec(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$p = Start-Process -FilePath $env:MAPATZ_INSTALLER -ArgumentList "--silent" -Wait -PassThru; if ($p.ExitCode -ne 0) { throw "Installer exited $($p.ExitCode)" }',
    ],
    { env: { ...process.env, MAPATZ_INSTALLER: installer }, timeout: 90_000 },
  );
  await writeFile(test.info().outputPath(`${phase}-installer.log`), result.stdout + result.stderr);
}

test('published Windows installation upgrades in place without losing field state', async () => {
  // This test uses the real default profile and installers. Never run against an operator's PC.
  expect(process.platform).toBe('win32');
  expect(process.env.GITHUB_ACTIONS).toBe('true');
  expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');
  expect(process.env.MAPATZ_PROFILE).toBeUndefined();
  const baselineInstaller = process.env.MAPATZ_BASELINE_INSTALLER;
  const candidateInstaller = process.env.MAPATZ_CANDIDATE_INSTALLER;
  expect(baselineInstaller).toBeTruthy();
  expect(candidateInstaller).toBeTruthy();
  const candidateVersion: string = JSON.parse(await readFile('package.json', 'utf8')).version;
  // Stable numeric versions only: never turn a same-version reinstall into a false upgrade pass.
  expect(candidateVersion).toMatch(/^\d+\.\d+\.\d+$/);
  const candidateParts = candidateVersion.split('.').map(Number);
  const baselineParts = baselineVersion.split('.').map(Number);
  const differing = candidateParts.findIndex((part, index) => part !== baselineParts[index]);
  expect(differing).toBeGreaterThanOrEqual(0);
  expect(candidateParts[differing]!).toBeGreaterThan(baselineParts[differing]!);
  const installRoot = join(process.env.LOCALAPPDATA!, 'mapatz_inventory');
  const expectedProfile = join(process.env.APPDATA!, 'Mapatz Inventory');
  expect(existsSync(installRoot), 'Upgrade needs a clean hosted runner').toBe(false);
  expect(existsSync(expectedProfile), 'Never overwrite an existing profile').toBe(false);
  const launch = (version: string) =>
    launchElectron({
      executablePath: join(installRoot, `app-${version}`, 'mapatz-inventory.exe'),
      cwd: tmpdir(),
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    });
  const baselineDigest = createHash('sha256')
    .update(await readFile(baselineInstaller!))
    .digest('hex');
  expect(baselineDigest).toBe('800804e0fa668e347a64df6acd360e2bb92a9f0a745552daca6218a66d00ad5e');
  const candidateDigest = createHash('sha256')
    .update(await readFile(candidateInstaller!))
    .digest('hex');
  const proof: Record<string, unknown> = {
    baselineVersion,
    candidateVersion,
    baselineDigest,
    candidateDigest,
  };
  const checkpoint = async (phase: string, details: Record<string, unknown> = {}) => {
    Object.assign(proof, details, { phase });
    await writeFile(test.info().outputPath('upgrade-proof.json'), JSON.stringify(proof, null, 2));
  };
  await checkpoint('installers-validated');
  let application: ElectronApplication | undefined;
  let profile = expectedProfile;
  try {
    await install(baselineInstaller!, 'baseline');
    application = await launch(baselineVersion);
    expect(await application.evaluate(({ app }) => app.getVersion())).toBe(baselineVersion);
    profile = await application.evaluate(({ app }) => app.getPath('userData'));
    expect(resolve(profile).toLowerCase()).toBe(resolve(expectedProfile).toLowerCase());
    let page = await application.firstWindow();
    await page.locator('#password').fill(password);
    await page.locator('#confirmation').fill(password);
    await page.getByRole('button', { name: 'שמירה ופתיחה' }).click();
    await page.waitForURL('http://127.0.0.1:*/');
    const origin = new URL(page.url()).origin;
    await post(page, '/session/role', { role: 'admin', password });
    const item = await post(page, '/items', { name: 'אוהל שדרוג', kind: 'non_consumable' });
    await post(page, '/stock/add', { itemId: item.id, quantity: 5 });
    const { borrower } = await post(
      page,
      '/borrowers',
      {
        contractVersion: 1,
        ledgerEpoch: 1,
        username: 'upgrade-camper',
        name: 'שואל שדרוג',
        contact: '',
        type: 'individual',
      },
      crypto.randomUUID(),
    );
    const borrowKey = crypto.randomUUID();
    const borrowBody = {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [{ itemId: item.id, borrow: [{ quantity: 2, note: 'before upgrade' }] }],
    };
    const borrowReceipt = await post(
      page,
      `/borrowers/${borrower.id}/operations`,
      borrowBody,
      borrowKey,
    );
    await page.evaluate(() => localStorage.setItem('upgrade-rehearsal', 'preserve-origin-storage'));
    const before = await snapshot(page);
    expect(before.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: item.id, available: 3 })]),
    );
    const profileBefore = await readFile(join(profile, 'profile.json'), 'utf8');
    await finishApplication(application, true);
    application = undefined;

    await checkpoint('baseline-seeded-and-closed', { profile, origin, before });

    // No uninstall, profile copy, or data restoration between the two real Setup packages.
    await install(candidateInstaller!, 'candidate');
    await checkpoint('candidate-installed');
    application = await launch(candidateVersion);
    expect(await application.evaluate(({ app }) => app.getVersion())).toBe(candidateVersion);
    expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
    const shortcuts = await application.evaluate(({ app, shell }, root) => {
      const fs = process.getBuiltinModule('fs');
      const path = process.getBuiltinModule('path');
      const folders = [
        app.getPath('desktop'),
        path.join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs'),
      ];
      const found: { shortcut: string; target: string; args: string }[] = [];
      for (const folder of folders) {
        for (const name of fs.readdirSync(folder, { recursive: true })) {
          if (typeof name !== 'string' || !name.endsWith('.lnk') || !/mapatz/i.test(name)) continue;
          const link = shell.readShortcutLink(path.join(folder, name));
          if (!link.target.toLowerCase().startsWith(root.toLowerCase() + path.sep)) continue;
          if (!fs.existsSync(link.target))
            throw new Error(`Missing shortcut target: ${link.target}`);
          found.push({
            shortcut: path.join(folder, name),
            target: link.target,
            args: link.args ?? '',
          });
        }
      }
      return found;
    }, installRoot);
    await checkpoint('candidate-launched', { shortcuts });
    expect(
      shortcuts.length,
      'Installer must retain a working application shortcut',
    ).toBeGreaterThan(0);
    for (const link of shortcuts) {
      expect(`${link.target} ${link.args}`).toContain('mapatz-inventory.exe');
      expect(`${link.target} ${link.args}`).not.toContain(`app-${baselineVersion}`);
    }
    page = await application.firstWindow();
    await page.waitForURL(`${origin}/`);
    await expect(page.locator('#password')).toHaveCount(0);
    expect(await readFile(join(profile, 'profile.json'), 'utf8')).toBe(profileBefore);
    expect(await page.evaluate(() => localStorage.getItem('upgrade-rehearsal'))).toBe(
      'preserve-origin-storage',
    );
    await post(page, '/session/role', { role: 'admin', password });
    expect(await snapshot(page)).toEqual(before);
    expect(await post(page, `/borrowers/${borrower.id}/operations`, borrowBody, borrowKey)).toEqual(
      { ...borrowReceipt, replayed: true },
    );
    expect(await snapshot(page)).toEqual(before); // Persisted receipt must prevent duplicate borrowing.
    await post(
      page,
      `/borrowers/${borrower.id}/operations`,
      {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [{ itemId: item.id, return: [{ usable: 1, damaged: 0, note: 'after upgrade' }] }],
      },
      crypto.randomUUID(),
    );
    const afterReturn = await snapshot(page);
    await checkpoint('candidate-data-verified', { afterReturn, shortcuts });
    expect(afterReturn.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: item.id, available: 4 })]),
    );
    await finishApplication(application, true);
    application = undefined;
    application = await launch(candidateVersion);
    page = await application.firstWindow();
    await page.waitForURL(`${origin}/`);
    await post(page, '/session/role', { role: 'admin', password });
    expect(await snapshot(page)).toEqual(afterReturn);
    await finishApplication(application, true);
    application = undefined;
    await checkpoint('candidate-restart-verified');
    const shortcutResult = await exec(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
$ErrorActionPreference = 'Stop'
Start-Process -FilePath $env:MAPATZ_SHORTCUT
try {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $windows = @(Get-Process -Name 'mapatz-inventory' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
    if ($windows.Count -gt 0) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  if ($windows.Count -ne 1) { throw 'Shortcut did not open exactly one application window' }
  $opened = $windows[0]
  if ($opened.Path -ne $env:MAPATZ_EXPECTED_EXE) { throw "Shortcut opened wrong executable: $($opened.Path)" }
  $opened.Path
  if (!$opened.CloseMainWindow()) { throw 'Could not close shortcut-launched application' }
  if (!$opened.WaitForExit(30000)) { throw 'Shortcut-launched application did not exit' }
} finally {
  Get-Process | Where-Object { $_.ProcessName -eq 'mapatz-inventory' -and $_.Path -and $_.Path.StartsWith($env:MAPATZ_INSTALL_ROOT, [System.StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue
}
`,
      ],
      {
        env: {
          ...process.env,
          MAPATZ_SHORTCUT: shortcuts[0]!.shortcut,
          MAPATZ_EXPECTED_EXE: join(installRoot, `app-${candidateVersion}`, 'mapatz-inventory.exe'),
          MAPATZ_INSTALL_ROOT: installRoot,
        },
        timeout: 75_000,
      },
    );
    await checkpoint('complete', { shortcutExecutable: shortcutResult.stdout.trim() });
  } catch (error) {
    await checkpoint('failed', {
      failedAfter: proof.phase,
      error: error instanceof Error ? error.stack : String(error),
    });
    throw error;
  } finally {
    for (const name of ['desktop.log', 'profile.json']) {
      const data = await readFile(join(profile, name)).catch(() => undefined);
      if (data) await writeFile(test.info().outputPath(name), data);
    }
    if (application) {
      const child = (() => {
        try {
          return application.process();
        } catch {
          return undefined;
        }
      })();
      const closing = (async () => {
        await saveDiagnostics(application).catch(() => {});
        await finishApplication(application).catch(() => {});
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        closing,
        new Promise<void>((done) => {
          timer = setTimeout(done, 10_000);
        }),
      ]);
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null)
        await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10_000 }).catch(
          () => {},
        );
    }
    // Hosted runner disposal removes the installation and profile after evidence upload.
  }
});
