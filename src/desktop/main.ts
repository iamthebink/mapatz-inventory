import { spawn } from 'node:child_process';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  utilityProcess,
  powerMonitor,
  type UtilityProcess,
} from 'electron';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
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
let origin = '';
const token = randomBytes(32).toString('hex');
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
async function failure(message: string) {
  if (failureOpen || stopping) return;
  failureOpen = true;
  ready = false;
  log(message);
  const options: Electron.MessageBoxOptions = {
    type: 'error',
    title: 'Mapatz — שגיאת הפעלה',
    message,
    detail: `הנתונים נשמרו. פרטי אבחון: ${join(directory, 'desktop.log')}`,
    buttons: ['נסה שוב', 'יציאה'],
    defaultId: 0,
    cancelId: 1,
  };
  log(JSON.stringify({ event: 'failure-dialog', options }));
  const result = await dialog.showMessageBox(options);
  if (result.response === 0) {
    app.relaunch();
    approvedClose = true;
    app.quit();
  } else {
    approvedClose = true;
    app.quit();
  }
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
  app.on('window-all-closed', () => app.quit());
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
      session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
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
        if (message.type === 'diagnostic') {
          log(message.message ?? 'Backend diagnostic');
          return;
        }
        clearTimeout(startupTimer);
        startupTimer = undefined;
        try {
          if (message.type === 'setup') void loadWindow(setupURL);
          if (message.type === 'ready') {
            log('Backend ready');
            markProfileInitialized(directory);
            ready = true;
            void loadWindow(origin);
          }
          if (message.type === 'failure') void failure(message.message ?? 'Backend failed');
        } catch (error) {
          void failure(error instanceof Error ? error.message : 'Startup failed');
        }
      });
      backend.on('exit', (code) => {
        log(`Backend exited: ${code}`);
        backendExited = true;
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
