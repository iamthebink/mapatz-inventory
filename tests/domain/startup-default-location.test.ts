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

it.each(['preferred', 'fallback', 'archived-preferred', 'archived-lowest', 'existing'] as const)(
  'initializes a missing default on restart: %s',
  (scenario) => {
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
    if (scenario === 'existing')
      db.prepare('UPDATE inventory_settings SET default_location_id=?').run(first.id);
    db.close();
    const reopened = openDatabase(path);
    try {
      expect(new InventoryService(reopened).defaultLocationId()).toBe(
        scenario === 'preferred' ? preferred.id : scenario === 'archived-lowest' ? 3 : first.id,
      );
    } finally {
      reopened.close();
    }
    const again = openDatabase(path);
    try {
      expect(new InventoryService(again).defaultLocationId()).toBe(
        scenario === 'preferred' ? preferred.id : scenario === 'archived-lowest' ? 3 : first.id,
      );
    } finally {
      again.close();
    }
  },
);

it.each(['reset', 'recovery'] as const)(
  '%s with no default selects immediately without restart',
  async (mode) => {
    const path = databasePath();
    const db = openDatabase(path);
    const transfer = new InventoryTransferService(db);
    db.prepare('UPDATE inventory_settings SET default_location_id=NULL').run();
    const workbook = await exportWorkbook(transfer.snapshot());
    if (mode === 'reset') transfer.replaceWithReset(await parseResetWorkbook(workbook));
    else transfer.replaceWithRecovery(await parseRecoveryWorkbook(workbook));
    expect(
      new InventoryService(db)
        .listLocations()
        .filter((location) => location.isDefault)
        .map((location) => location.name),
    ).toEqual(['צוללת']);
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

it.each(['reset', 'recovery'] as const)(
  '%s rejects an empty or all-archived location catalog atomically',
  (mode) => {
    for (const locations of [
      [],
      [{ name: 'צוללת', archived: true, isDefault: false }],
      [{ name: 'Old warehouse', archived: true, isDefault: false }],
    ]) {
      const db = openDatabase(':memory:');
      try {
        const transfer = new InventoryTransferService(db);
        const before = transfer.snapshot();
        const epoch = new InventoryService(db).inventoryEpoch();
        expect(() => {
          if (mode === 'reset') transfer.replaceWithReset({ locations, items: [] });
          else transfer.replaceWithRecovery({ ...before, locations });
        }).toThrow(expect.objectContaining({ code: 'active_location_required' }));
        expect(transfer.snapshot()).toEqual(before);
        expect(new InventoryService(db).inventoryEpoch()).toBe(epoch);
      } finally {
        db.close();
      }
    }
  },
);

it.each(['archive', 'delete'] as const)(
  'rejects %s of the last active location, including retries',
  (action) => {
    const db = openDatabase(':memory:');
    try {
      const service = new InventoryService(db);
      const transfer = new InventoryTransferService(db);
      const home = service.listLocations().find((location) => location.isDefault)!;
      for (const location of service.listLocations().filter((row) => row.id !== home.id)) {
        service.retireLocationCommand({
          key: `delete-${location.id}`,
          ledgerEpoch: 1,
          locationId: location.id,
          action: 'delete',
          expectedCode: location.code,
          expectedName: location.name,
          expectedItemIds: [],
          expectedBalances: [],
        });
      }
      const before = transfer.snapshot();
      const command = {
        key: 'last-location',
        ledgerEpoch: 1,
        locationId: home.id,
        action,
        expectedCode: home.code,
        expectedName: home.name,
        expectedItemIds: [],
        expectedBalances: [],
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => service.retireLocationCommand(command)).toThrow(
          expect.objectContaining({ code: 'active_location_required' }),
        );
        expect(transfer.snapshot()).toEqual(before);
      }
      expect(() =>
        service.updateLocation(home.id, { code: home.code, name: home.name, archived: true }),
      ).toThrow(expect.objectContaining({ code: 'active_location_required' }));
      expect(() =>
        service.saveInventoryLocation({
          key: 'archive-home',
          locationId: home.id,
          code: home.code,
          name: home.name,
          archived: true,
        }),
      ).toThrow(expect.objectContaining({ code: 'active_location_required' }));
      expect(transfer.snapshot()).toEqual(before);
      const other = service.createLocation('other', 'Other');
      const result = service.retireLocationCommand(command);
      expect(service.defaultLocationId()).toBe(other.id);
      expect(service.retireLocationCommand(command)).toEqual(result);
      expect(service.defaultLocationId()).toBe(other.id);
    } finally {
      db.close();
    }
  },
);

it('creating a location repairs an absent setting within the same transaction', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('UPDATE inventory_settings SET default_location_id=NULL').run();
    const service = new InventoryService(db);
    service.createLocation('new', 'New');
    expect(service.listLocations().find((location) => location.isDefault)?.name).toBe('צוללת');
  } finally {
    db.close();
  }
});

it.each(['reset', 'recovery'] as const)(
  'rolls back %s state and epoch if choosing the default fails',
  (mode) => {
    const db = openDatabase(':memory:');
    try {
      const transfer = new InventoryTransferService(db);
      const before = transfer.snapshot();
      const epoch = new InventoryService(db).inventoryEpoch();
      db.exec(`CREATE TRIGGER reject_default BEFORE UPDATE ON inventory_settings
      WHEN NEW.default_location_id IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'default rejected'); END`);
      expect(() => {
        const locations = [{ name: 'New', archived: false, isDefault: false }];
        if (mode === 'reset') transfer.replaceWithReset({ locations, items: [] });
        else transfer.replaceWithRecovery({ ...before, locations });
      }).toThrow('default rejected');
      expect(new InventoryService(db).inventoryEpoch()).toBe(epoch);
      expect(transfer.snapshot()).toEqual(before);
    } finally {
      db.close();
    }
  },
);

it.each(['empty', 'archived'] as const)(
  'rejects startup with an %s catalog without changing it',
  (state) => {
    const path = databasePath();
    const db = openDatabase(path);
    db.prepare('UPDATE inventory_settings SET default_location_id=NULL').run();
    db.exec(state === 'empty' ? 'DELETE FROM locations' : 'UPDATE locations SET archived=1');
    const before = db.prepare('SELECT * FROM locations ORDER BY id').all();
    db.close();
    expect(() => openDatabase(path)).toThrow(
      expect.objectContaining({ code: 'active_location_required' }),
    );
    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('SELECT * FROM locations ORDER BY id').all()).toEqual(before);
      expect(raw.prepare('SELECT default_location_id FROM inventory_settings').get()).toMatchObject(
        { default_location_id: null },
      );
    } finally {
      raw.close();
    }
  },
);
