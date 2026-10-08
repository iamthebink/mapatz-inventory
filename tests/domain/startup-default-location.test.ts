import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { InventoryService } from '../../src/domain/inventory.js';
import { InventoryTransferService } from '../../src/domain/import-export.js';
import {
  exportWorkbook,
  parseResetWorkbook,
  parseRecoveryWorkbook,
} from '../../src/io/workbook.js';

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })),
);
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'startup-default-'));
  directories.push(directory);
  return join(directory, 'inventory.sqlite');
}

it('selects the seeded active צוללת on first startup', () => {
  const db = openDatabase(':memory:');
  try {
    const service = new InventoryService(db);
    expect(
      service
        .listLocations()
        .filter((location) => location.isDefault)
        .map((location) => location.name),
    ).toEqual(['צוללת']);
  } finally {
    db.close();
  }
});

it.each([
  'preferred',
  'fallback',
  'archived-preferred',
  'archived-lowest',
  'no-active',
  'empty',
  'existing',
] as const)('initializes a missing default on restart: %s', (scenario) => {
  const path = databasePath();
  const db = openDatabase(path);
  const service = new InventoryService(db);
  const preferred = service.listLocations().find((location) => location.name === 'צוללת')!;
  const first = service.listLocations().find((location) => location.id === 1)!;
  db.prepare('UPDATE inventory_settings SET default_location_id=NULL').run();
  if (scenario === 'fallback') db.prepare('DELETE FROM locations WHERE id=?').run(preferred.id);
  if (scenario === 'archived-preferred')
    db.prepare('UPDATE locations SET archived=1 WHERE id=?').run(preferred.id);
  if (scenario === 'archived-lowest') {
    db.prepare('DELETE FROM locations WHERE id=?').run(preferred.id);
    db.prepare('UPDATE locations SET archived=1 WHERE id=?').run(first.id);
  }
  if (scenario === 'empty') db.prepare('DELETE FROM locations').run();
  if (scenario === 'no-active') db.prepare('UPDATE locations SET archived=1').run();
  if (scenario === 'existing')
    db.prepare('UPDATE inventory_settings SET default_location_id=?').run(first.id);
  db.close();
  const reopened = openDatabase(path);
  try {
    expect(new InventoryService(reopened).defaultLocationId()).toBe(
      scenario === 'no-active' || scenario === 'empty'
        ? null
        : scenario === 'preferred'
          ? preferred.id
          : scenario === 'archived-lowest'
            ? 3
            : first.id,
    );
  } finally {
    reopened.close();
  }
  const again = openDatabase(path);
  try {
    if (scenario === 'empty') expect(new InventoryService(again).listLocations(true)).toEqual([]);
    expect(new InventoryService(again).defaultLocationId()).toBe(
      scenario === 'no-active' || scenario === 'empty'
        ? null
        : scenario === 'preferred'
          ? preferred.id
          : scenario === 'archived-lowest'
            ? 3
            : first.id,
    );
  } finally {
    again.close();
  }
});

it.each(['reset', 'recovery'] as const)(
  '%s with no default stays unset until restart',
  async (mode) => {
    const path = databasePath();
    const db = openDatabase(path);
    const transfer = new InventoryTransferService(db);
    db.prepare('UPDATE inventory_settings SET default_location_id=NULL').run();
    const workbook = await exportWorkbook(transfer.snapshot());
    if (mode === 'reset') transfer.replaceWithReset(await parseResetWorkbook(workbook));
    else transfer.replaceWithRecovery(await parseRecoveryWorkbook(workbook));
    expect(new InventoryService(db).defaultLocationId()).toBeNull();
    db.close();
    const reopened = openDatabase(path);
    try {
      expect(
        new InventoryService(reopened)
          .listLocations()
          .filter((location) => location.isDefault)
          .map((location) => location.name),
      ).toEqual(['צוללת']);
    } finally {
      reopened.close();
    }
  },
);

it('does not initialize the default when authoritative state fails validation', () => {
  const path = databasePath();
  const db = openDatabase(path);
  db.prepare('UPDATE inventory_settings SET default_location_id=NULL').run();
  db.prepare('DELETE FROM state_clock').run();
  db.close();
  expect(() => openDatabase(path)).toThrow(/incomplete authoritative inventory state/);
  const raw = new DatabaseSync(path);
  try {
    expect(raw.prepare('SELECT default_location_id FROM inventory_settings').get()).toMatchObject({
      default_location_id: null,
    });
  } finally {
    raw.close();
  }
});
