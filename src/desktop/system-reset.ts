import { rm } from 'node:fs/promises';
import { join } from 'node:path';

export const RESET_PHRASE = 'איפוס מערכת';

// Explicit allowlist: never delete the profile directory, logs, or exported workbooks.
export async function removeOwnedSystemData(directory: string): Promise<void> {
  for (const name of [
    'inventory.sqlite',
    'inventory.sqlite-wal',
    'inventory.sqlite-shm',
    'inventory.sqlite-journal',
    'backups',
    'profile.json',
    'profile.json.tmp',
  ]) {
    await rm(join(directory, name), { recursive: true, force: true });
  }
}

export interface SystemResetSteps {
  stopBackend(): Promise<void>;
  clearBrowser(): Promise<void>;
  removeData(): Promise<void>;
  restart(): void;
}

// No rollback is claimed: each step is retryable and restart only follows complete clearing.
export async function performSystemReset(steps: SystemResetSteps): Promise<void> {
  await steps.stopBackend();
  await steps.clearBrowser();
  await steps.removeData();
  steps.restart();
}
