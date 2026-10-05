import { mkdtemp, mkdir, readFile, rm, lstat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { performSystemReset, removeOwnedSystemData } from '../../src/desktop/system-reset.js';

describe('system factory reset boundaries', () => {
  it('removes owned data and sidecars, preserves diagnostics, exports and symlink targets, and permits retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reset-boundaries-'));
    const profile = join(root, 'profile');
    const outside = join(root, 'exported');
    try {
      await mkdir(profile);
      await mkdir(outside);
      await writeFile(join(outside, 'inventory.xlsx'), 'export');
      await symlink(outside, join(profile, 'backups'), 'dir');
      for (const name of [
        'inventory.sqlite',
        'inventory.sqlite-wal',
        'inventory.sqlite-shm',
        'inventory.sqlite-journal',
        'profile.json',
        'profile.json.tmp',
        'desktop.log',
        'inventory.xlsx',
      ])
        await writeFile(join(profile, name), name);
      await removeOwnedSystemData(profile);
      await removeOwnedSystemData(profile);
      expect(await readFile(join(profile, 'desktop.log'), 'utf8')).toBe('desktop.log');
      expect(await readFile(join(profile, 'inventory.xlsx'), 'utf8')).toBe('inventory.xlsx');
      expect(await readFile(join(outside, 'inventory.xlsx'), 'utf8')).toBe('export');
      for (const name of [
        'inventory.sqlite',
        'inventory.sqlite-wal',
        'inventory.sqlite-shm',
        'inventory.sqlite-journal',
        'profile.json',
        'profile.json.tmp',
        'backups',
      ])
        await expect(lstat(join(profile, name))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('never deletes before ownership and browser clearing finish, never restarts on failure', async () => {
    for (const failed of ['stopBackend', 'clearBrowser', 'removeData'] as const) {
      const order: string[] = [];
      const steps = {
        stopBackend: vi.fn(async () => {
          order.push('stopBackend');
        }),
        clearBrowser: vi.fn(async () => {
          order.push('clearBrowser');
        }),
        removeData: vi.fn(async () => {
          order.push('removeData');
        }),
        restart: vi.fn(() => {
          order.push('restart');
        }),
      };
      steps[failed].mockImplementation(async () => {
        order.push(failed);
        throw new Error(failed);
      });
      await expect(performSystemReset(steps)).rejects.toThrow(failed);
      expect(order).toEqual(
        ['stopBackend', 'clearBrowser', 'removeData'].slice(
          0,
          ['stopBackend', 'clearBrowser', 'removeData'].indexOf(failed) + 1,
        ),
      );
      expect(steps.restart).not.toHaveBeenCalled();
    }
    const order: string[] = [];
    await performSystemReset({
      stopBackend: async () => {
        order.push('stop');
      },
      clearBrowser: async () => {
        order.push('clear');
      },
      removeData: async () => {
        order.push('remove');
      },
      restart: () => {
        order.push('restart');
      },
    });
    expect(order).toEqual(['stop', 'clear', 'remove', 'restart']);
  });
});
