import { test, _electron as electron, type ElectronApplication } from '@playwright/test';

const diagnosticIds = new WeakMap<ElectronApplication, number>();
let diagnosticSequence = 0;
export async function launchElectron(options: Parameters<typeof electron.launch>[0]) {
  const application = await electron.launch(options);
  diagnosticIds.set(application, ++diagnosticSequence);
  await application.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  return application;
}
export async function saveDiagnostics(application: ElectronApplication) {
  const id = diagnosticIds.get(application);
  if (id === undefined) return;
  diagnosticIds.delete(application);
  const page = application.windows()[0];
  if (page && !page.isClosed()) {
    const screenshotPath = test.info().outputPath(`electron-window-${id}.png`);
    const screenshot = await page.screenshot({ path: screenshotPath }).catch(() => undefined);
    if (screenshot)
      await test
        .info()
        .attach(`electron-window-${id}`, { path: screenshotPath, contentType: 'image/png' });
  }
  const path = test.info().outputPath(`electron-context-${id}.zip`);
  try {
    await application.context().tracing.stop({ path });
    await test.info().attach(`electron-context-${id}`, { path, contentType: 'application/zip' });
  } catch {
    /* The deliberate process-death cases can close Chromium before trace flush. */
  }
}
export async function finishApplication(application: ElectronApplication, graceful = false) {
  const child = (() => {
    try {
      return application.process();
    } catch {
      return undefined;
    }
  })();
  await saveDiagnostics(application);
  if (graceful) await application.close();
  else await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null)
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
}
