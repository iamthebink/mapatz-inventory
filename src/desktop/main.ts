import { spawn } from 'node:child_process';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  utilityProcess,
  powerMonitor,
  session as electronSession,
  type UtilityProcess,
} from 'electron';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { performSystemReset, removeOwnedSystemData, RESET_PHRASE } from './system-reset.js';
import { markProfileInitialized, profilePort } from './profile.js';

const here = dirname(fileURLToPath(import.meta.url));
app.setName('Mapatz Inventory');
if (process.env.MAPATZ_PROFILE) app.setPath('userData', process.env.MAPATZ_PROFILE);
const directory = app.getPath('userData');
let window: BrowserWindow | undefined;
let backend: UtilityProcess | undefined;
let approvedClose = false;
let ready = false;
let stopping = false;
let backendExited = false;
let failureOpen = false;
let resetActive = false;
let resetFailed = false;
let deferredFailure: string | undefined;
let resetWindow: BrowserWindow | undefined;
let origin = '';
const token = randomBytes(32).toString('hex');
const resetURL = new URL('./reset.html', import.meta.url).href;
const setupURL = new URL('./setup.html', import.meta.url).href;
function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, setup = false) {
  return (
    event.sender === window?.webContents &&
    event.senderFrame === window?.webContents.mainFrame &&
    (setup ? event.senderFrame?.url === setupURL : event.senderFrame?.url.startsWith(`${origin}/`))
  );
}
function log(message: string) {
  try {
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, 'desktop.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    console.error('Desktop diagnostic log is unavailable.');
  }
}
function confirmReset(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const confirmation = new BrowserWindow({
      width: 620,
      height: 650,
      show: false,
      parent: window,
      modal: !!window,
      webPreferences: {
        preload: join(here, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'reset-confirmation',
      },
    });
    resetWindow = confirmation;
    confirmation.removeMenu();
    confirmation.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    confirmation.webContents.on('will-navigate', (event) => event.preventDefault());
    const trustedConfirmation = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
      event.sender === confirmation.webContents &&
      event.senderFrame === confirmation.webContents.mainFrame &&
      event.senderFrame?.url === resetURL;
    let decided = false;
    const finish = (confirmed: boolean) => {
      if (decided) return;
      decided = true;
      resolve(confirmed);
      confirmation.destroy();
    };
    confirmation.webContents.on('render-process-gone', (_event, details) => {
      log(`Reset confirmation renderer stopped (${details.reason}, ${details.exitCode})`);
      finish(false);
    });
    ipcMain.handle('desktop:reset-confirm', (event, phrase: unknown) => {
      if (!trustedConfirmation(event) || phrase !== RESET_PHRASE)
        throw new Error('Invalid reset confirmation');
      finish(true);
    });
    const cancel = (event: Electron.IpcMainEvent) => {
      if (trustedConfirmation(event)) finish(false);
    };
    ipcMain.on('desktop:reset-cancel', cancel);
    confirmation.once('closed', () => {
      resetWindow = undefined;
      ipcMain.removeHandler('desktop:reset-confirm');
      ipcMain.removeListener('desktop:reset-cancel', cancel);
      if (!decided) resolve(false);
    });
    void confirmation
      .loadURL(resetURL)
      .then(() => {
        if (!confirmation.isDestroyed()) confirmation.show();
      })
      .catch((error: unknown) => {
        decided = true;
        confirmation.destroy();
        reject(error);
      });
  });
}
async function stopBackendForReset(): Promise<void> {
  if (!backend || backendExited) return;
  const owner = backend;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      owner.removeListener('exit', exited);
      reject(new Error('Backend did not stop; no files were deleted. Retry or exit.'));
    }, 30_000);
    const exited = (code: number) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Backend stopped with error (${code}); retry reset.`));
      else resolve();
    };
    owner.once('exit', exited);
    owner.postMessage({ type: 'stop' });
  });
}
async function executeReset(): Promise<void> {
  ready = false;
  stopping = true;
  try {
    log('System reset: stopping backend');
    await performSystemReset({
      stopBackend: stopBackendForReset,
      clearBrowser: async () => {
        // Destroy the application renderer before clearing durable commands so it cannot rewrite them.
        approvedClose = true;
        window?.destroy();
        window = undefined;
        await electronSession.defaultSession.clearStorageData();
        await electronSession.defaultSession.clearCache();
        await electronSession.defaultSession.flushStorageData();
      },
      removeData: () => removeOwnedSystemData(directory),
      restart: () => {
        log('System reset complete; restarting for password setup');
        app.relaunch();
        resetActive = false;
        app.quit();
      },
    });
  } catch (error) {
    log(`System reset incomplete: ${String(error)}`);
    resetActive = false;
    resetFailed = true;
    stopping = false;
    await failure(`איפוס המערכת לא הושלם. ניתן לנסות שוב או לצאת. ${String(error)}`);
  }
}
async function requestReset(fromBackend = false): Promise<void> {
  if (resetActive || stopping) {
    if (fromBackend) backend?.postMessage({ type: 'reset-result', error: 'Reset already pending' });
    return;
  }
  resetActive = true;
  try {
    const confirmed = await confirmReset();
    if (fromBackend && !backendExited)
      backend?.postMessage({
        type: 'reset-result',
        outcome: confirmed ? 'confirmed' : 'cancelled',
      });
    if (confirmed) {
      deferredFailure = undefined;
      // Let the accepted HTTP response finish before draining the owner.
      setImmediate(() => void executeReset());
    } else {
      resetActive = false;
      const pendingFailure = deferredFailure;
      deferredFailure = undefined;
      if (resetFailed)
        await failure(
          'איפוס המערכת בוטל לאחר איפוס שלא הושלם. ייתכן שחלק מהנתונים כבר נמחקו. ניתן לנסות שוב או לצאת.',
        );
      else if (pendingFailure) await failure(pendingFailure);
      else if (!fromBackend) await failure('ההפעלה נכשלה. איפוס המערכת בוטל; הנתונים נשמרו.');
    }
  } catch (error) {
    resetActive = false;
    if (fromBackend) backend?.postMessage({ type: 'reset-result', error: String(error) });
    else await failure(String(error));
  }
}
async function failure(message: string) {
  if (resetActive) {
    if (!stopping) {
      deferredFailure = message;
      log(message);
    }
    return;
  }
  if (failureOpen || stopping) return;
  failureOpen = true;
  ready = false;
  log(message);
  const options: Electron.MessageBoxOptions = {
    type: 'error',
    title: 'Mapatz — שגיאת הפעלה',
    message,
    detail: `פרטי אבחון: ${join(directory, 'desktop.log')}`,
    buttons: ['נסה שוב', 'יציאה', 'איפוס מערכת'],
    defaultId: 0,
    cancelId: 1,
  };
  log(JSON.stringify({ event: 'failure-dialog', options }));
  const result = await dialog.showMessageBox(options);
  failureOpen = false;
  if (result.response === 2 || (result.response === 0 && resetFailed)) {
    await requestReset();
    return;
  }
  if (result.response === 0) app.relaunch();
  approvedClose = true;
  if (result.response === 1 && resetFailed && backend && !backendExited) {
    // Exit remains actionable when graceful stop failed; no deletion follows forced termination.
    stopping = true;
    log('Exiting after incomplete reset; terminating backend without deleting data');
    if (!backend.kill()) app.exit(1);
    return;
  }
  app.quit();
}
async function loadWindow(url: string) {
  try {
    await window?.loadURL(url);
    window?.show();
  } catch (error) {
    await failure(error instanceof Error ? error.message : 'Renderer failed to load');
  }
}
const squirrelEvent =
  process.platform === 'win32'
    ? process.argv.find((argument) =>
        [
          '--squirrel-install',
          '--squirrel-updated',
          '--squirrel-uninstall',
          '--squirrel-obsolete',
        ].includes(argument),
      )
    : undefined;
if (squirrelEvent) {
  if (
    ['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall'].includes(squirrelEvent)
  ) {
    const updater = join(dirname(process.execPath), '..', 'Update.exe');
    const child = spawn(
      updater,
      [
        squirrelEvent === '--squirrel-uninstall' ? '--removeShortcut' : '--createShortcut',
        basename(process.execPath),
      ],
      { windowsHide: true },
    );
    child.on('close', () => app.quit());
    child.on('error', () => app.quit());
  } else app.quit();
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.on('before-quit', (event) => {
    if (resetActive) {
      event.preventDefault();
      resetWindow?.focus();
      return;
    }
    log(
      `Quit requested: approved=${approvedClose}, stopping=${stopping}, backendExited=${backendExited}`,
    );
    if (!approvedClose && window) {
      event.preventDefault();
      window.close();
      return;
    }
    if (backend && !backendExited) {
      event.preventDefault();
      stopping = true;
      log('Sending backend stop from before-quit');
      backend.postMessage({ type: 'stop' });
    }
  });
  app.on('window-all-closed', () => {
    if (!resetActive) app.quit();
  });
  void app.whenReady().then(async () => {
    try {
      const port = await profilePort(directory);
      origin = `http://127.0.0.1:${port}`;
      window = new BrowserWindow({
        width: 1280,
        height: 850,
        show: false,
        webPreferences: {
          preload: join(here, 'preload.cjs'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      window.removeMenu();
      const session = window.webContents.session;
      // Recovery may copy plain text, but cannot read the clipboard or grant other permissions.
      session.setPermissionCheckHandler(
        (contents, permission, requestingOrigin, details) =>
          permission === 'clipboard-sanitized-write' &&
          contents === window?.webContents &&
          requestingOrigin === origin &&
          details.isMainFrame &&
          !!details.requestingUrl?.startsWith(`${origin}/`),
      );
      session.setPermissionRequestHandler((contents, permission, callback, details) =>
        callback(
          permission === 'clipboard-sanitized-write' &&
            contents === window?.webContents &&
            details.isMainFrame &&
            details.requestingUrl.startsWith(`${origin}/`),
        ),
      );
      session.webRequest.onBeforeSendHeaders((details, callback) => {
        if (details.url.startsWith(`${origin}/`))
          details.requestHeaders['x-mapatz-desktop-token'] = token;
        callback({ requestHeaders: details.requestHeaders });
      });
      session.webRequest.onBeforeRequest((details, callback) =>
        callback({
          cancel: !(
            details.url.startsWith(`${origin}/`) ||
            details.url === setupURL ||
            details.url === new URL('./setup.js', import.meta.url).href
          ),
        }),
      );
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(`${origin}/`) && url !== setupURL) event.preventDefault();
      });
      window.on('close', (event) => {
        if (resetActive) {
          event.preventDefault();
          resetWindow?.focus();
          return;
        }
        if (approvedClose) return;
        if (!ready) {
          approvedClose = true;
          return;
        }
        event.preventDefault();
        window?.webContents.send('desktop:close-request');
      });
      window.on('closed', () => {
        log('Window closed; sending backend stop');
        window = undefined;
        if (resetActive) return;
        stopping = true;
        backend?.postMessage({ type: 'stop' });
      });
      window.webContents.on(
        'render-process-gone',
        (_event, details) =>
          void failure(
            `Renderer stopped (${details.reason}, ${details.exitCode}). Restart to reconcile saved commands.`,
          ),
      );
      ipcMain.handle('desktop:setup', (event, password: unknown) => {
        if (
          !trusted(event, true) ||
          typeof password !== 'string' ||
          password.length < 8 ||
          password.length > 256
        )
          throw new Error('סיסמה חייבת להכיל 8–256 תווים');
        log('Credential setup requested');
        backend?.postMessage({ type: 'password', password });
      });
      ipcMain.on('desktop:close-approved', (event) => {
        if (!trusted(event)) return;
        approvedClose = true;
        window?.close();
      });
      ipcMain.handle('desktop:save', async (event, data: unknown) => {
        if (!trusted(event) || !(data instanceof Uint8Array) || data.length > 100 * 1024 * 1024)
          throw new Error('Invalid workbook');
        const selected = await dialog.showSaveDialog(window!, {
          defaultPath: 'mapatz-inventory.xlsx',
          filters: [{ name: 'Excel', extensions: ['xlsx'] }],
        });
        if (selected.canceled || !selected.filePath) return 'cancelled';
        writeFileSync(selected.filePath, data);
        return 'saved';
      });
      powerMonitor.on('resume', () => window?.webContents.send('desktop:resume'));
      backend = utilityProcess.fork(join(here, 'backend.js'), [], { stdio: 'pipe' });
      // Backend diagnostics contain errors only; password travels through IPC, never argv/env/logs.
      backend.stderr?.on('data', (chunk: Buffer) => log(chunk.toString()));
      let startupTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
        () => void failure('Backend startup timed out.'),
        30_000,
      );
      backend.on('message', (message: { type: string; message?: string }) => {
        if (message.type === 'reset-request') {
          void requestReset(true);
          return;
        }
        if (message.type === 'diagnostic') {
          log(message.message ?? 'Backend diagnostic');
          return;
        }
        clearTimeout(startupTimer);
        startupTimer = undefined;
        if (message.type === 'failure') {
          void failure(message.message ?? 'Backend failed');
          return;
        }
        if (resetActive || stopping) return;
        try {
          if (message.type === 'setup') void loadWindow(setupURL);
          if (message.type === 'ready') {
            log('Backend ready');
            markProfileInitialized(directory);
            ready = true;
            void loadWindow(origin);
          }
        } catch (error) {
          void failure(error instanceof Error ? error.message : 'Startup failed');
        }
      });
      backend.on('exit', (code) => {
        log(`Backend exited: ${code}`);
        backendExited = true;
        if (resetActive) {
          if (!stopping)
            void failure(`Backend stopped (${code}). Restart to reconcile saved commands.`);
          return;
        }
        if (stopping) {
          app.quit();
          return;
        }
        if (!stopping)
          void failure(`Backend stopped (${code}). Restart to reconcile saved commands.`);
      });
      backend.postMessage({ type: 'start', directory, port, token });
    } catch (error) {
      void failure(error instanceof Error ? error.message : 'Startup failed');
    }
  });
}
