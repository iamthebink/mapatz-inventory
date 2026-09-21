import { foundReturned } from '../helpers/found-returned.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { InventoryService } from '../../src/domain/inventory.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('inventory domain', () => {
  it('migrates legacy operator credentials to the admin-only credential model', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-credentials-migration-'));
    cleanup.push(directory);
    const filename = join(directory, 'inventory.sqlite');
    const legacy = new DatabaseSync(filename);
    legacy.exec(
      readFileSync(new URL('../../src/db/migrations/001_initial.sql', import.meta.url), 'utf8'),
    );
    legacy
      .prepare('INSERT INTO credentials(role,salt,password_hash) VALUES (?,?,?)')
      .run('operator', 'operator-salt', 'operator-hash');
    legacy
      .prepare('INSERT INTO credentials(role,salt,password_hash) VALUES (?,?,?)')
      .run('admin', 'admin-salt', 'admin-hash');
    legacy.prepare('INSERT INTO migrations(version) VALUES (?)').run(1);
    legacy.close();

    const migrated = openDatabase(filename);
    expect(migrated.prepare('SELECT role,salt,password_hash FROM credentials').all()).toEqual([
      { role: 'admin', salt: 'admin-salt', password_hash: 'admin-hash' },
    ]);
    expect(() =>
      migrated
        .prepare('INSERT INTO credentials(role,salt,password_hash) VALUES (?,?,?)')
        .run('operator', 'salt', 'hash'),
    ).toThrow();
    migrated.close();
  });

  it('migrates version 3 inventory without changing rows or foreign-key relationships', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-camp-equipment-migration-'));
    cleanup.push(directory);
    const filename = join(directory, 'inventory.sqlite');
    const legacy = new DatabaseSync(filename);
    legacy.exec(
      readFileSync(new URL('../../src/db/migrations/001_initial.sql', import.meta.url), 'utf8'),
    );
    legacy.exec('PRAGMA foreign_keys = OFF');
    legacy.exec(
      readFileSync(
        new URL('../../src/db/migrations/002_import_export.sql', import.meta.url),
        'utf8',
      ),
    );
    legacy.exec('PRAGMA foreign_keys = ON');
    legacy.exec(
      readFileSync(
        new URL('../../src/db/migrations/003_admin_only_credentials.sql', import.meta.url),
        'utf8',
      ),
    );
    legacy.prepare('INSERT INTO migrations(version) VALUES (?),(?),(?)').run(1, 2, 3);
    const locationId = Number(
      (legacy.prepare("SELECT id FROM locations WHERE code='monster'").get() as { id: number }).id,
    );
    const itemId = Number(
      legacy
        .prepare(
          "INSERT INTO items(code,name,kind,location_id) VALUES (100,'Existing','non_consumable',?)",
        )
        .run(locationId).lastInsertRowid,
    );
    legacy.prepare('UPDATE code_sequence SET next_code=101 WHERE singleton=1').run();
    legacy.prepare("INSERT INTO item_aliases(item_id,alias) VALUES (?,'Preserved')").run(itemId);
    const eventId = Number(
      legacy
        .prepare(
          "INSERT INTO inventory_events(kind,item_id,quantity,note) VALUES ('stock_added',?,4,'Existing history')",
        )
        .run(itemId).lastInsertRowid,
    );
    legacy
      .prepare('INSERT INTO inventory_baselines(item_id,quantity,through_event_id) VALUES (?,?,?)')
      .run(itemId, 4, eventId);
    legacy.close();

    const migrated = openDatabase(filename);
    expect(migrated.prepare('SELECT COUNT(*) count FROM migrations').get()).toEqual({ count: 6 });
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(migrated.prepare('SELECT code,name,kind,location_id FROM items').all()).toEqual([
      { code: 100, name: 'Existing', kind: 'non_consumable', location_id: locationId },
    ]);
    expect(migrated.prepare('SELECT item_id,alias FROM item_aliases').all()).toEqual([
      { item_id: itemId, alias: 'Preserved' },
    ]);
    expect(migrated.prepare('SELECT item_id,quantity,note FROM inventory_events').all()).toEqual([
      { item_id: itemId, quantity: 4, note: 'Existing history' },
    ]);
    expect(
      migrated.prepare('SELECT item_id,quantity,through_event_id FROM inventory_baselines').all(),
    ).toEqual([{ item_id: itemId, quantity: 4, through_event_id: eventId }]);
    expect(
      new InventoryService(migrated).createItem({ name: 'Bar', kind: 'camp_equipment' }).kind,
    ).toBe('camp_equipment');
    migrated.close();
  });

  it('migrates idempotently, seeds locations, and persists monotonic codes and event-derived state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-domain-'));
    cleanup.push(directory);
    const filename = join(directory, 'inventory.sqlite');
    let db = openDatabase(filename);
    let inventory = new InventoryService(db);
    expect(inventory.listLocations().map((location) => location.code)).toEqual(
      expect.arrayContaining(['monster', 'kabira', 'submarine']),
    );
    const gloves = inventory.createItem({ name: 'כפפות', kind: 'consumable', aliases: ['Gloves'] });
    expect(gloves.code).toBe(100);
    inventory.addStock(gloves.id, 12);
    inventory.issue(gloves.id, 3);
    db.close();

    db = openDatabase(filename);
    inventory = new InventoryService(db);
    expect(
      (db.prepare('SELECT COUNT(*) count FROM migrations').get() as { count: number }).count,
    ).toBe(6);
    expect(inventory.listItems('gLoV')).toHaveLength(1);
    expect(inventory.listItems('100')[0]?.available).toBe(9);
    expect(inventory.createItem({ name: 'פטיש', kind: 'non_consumable' }).code).toBe(101);
    expect(() => db.prepare('UPDATE inventory_events SET quantity=99 WHERE id=1').run()).toThrow(
      /immutable/,
    );
    expect(() => db.prepare('DELETE FROM inventory_events WHERE id=1').run()).toThrow(/immutable/);
    db.close();
  });

  it('tracks camp equipment by quantity while rejecting issue and checkout lifecycles', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const item = inventory.createItem({ name: 'שולחן קבוע', kind: 'camp_equipment' });
    inventory.addStock(item.id, 8);
    expect(inventory.listItems(String(item.code))[0]).toMatchObject({
      kind: 'camp_equipment',
      available: 8,
      damaged: 0,
    });
    expect(() => inventory.issue(item.id, 1)).toThrow(
      expect.objectContaining({ code: 'wrong_item_kind' }),
    );
    expect(() => inventory.checkout(item.id, 999, 1)).toThrow(
      expect.objectContaining({ code: 'wrong_item_kind' }),
    );
    expect(() => inventory.createItem({ name: 'בר', kind: 'camp_equipment', lotSize: 2 })).toThrow(
      expect.objectContaining({ code: 'invalid_lot_size' }),
    );
    expect(inventory.listLedger().map((event) => event.kind)).toEqual(['stock_added']);
    db.close();
  });

  it('atomically rejects inactive borrowers, insufficient stock, over-return, and archive with active loans', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const item = inventory.createItem({ name: 'פטיש', kind: 'non_consumable' });
    const borrower = inventory.createBorrower({
      username: 'Alice',
      name: 'אליס',
      type: 'individual',
    });
    inventory.addStock(item.id, 2);
    expect(() => inventory.checkout(item.id, borrower.id, 3)).toThrow(
      expect.objectContaining({ code: 'insufficient_stock' }),
    );
    expect(inventory.listLedger()).toHaveLength(1);
    inventory.archiveBorrower(borrower.id, true);
    expect(() => inventory.checkout(item.id, borrower.id, 1)).toThrow(
      expect.objectContaining({ code: 'inactive_borrower' }),
    );
    inventory.archiveBorrower(borrower.id, false);
    const checkoutId = inventory.checkout(item.id, borrower.id, 2);
    expect(() => inventory.archiveItem(item.id, true)).toThrow(
      expect.objectContaining({ code: 'active_loan' }),
    );
    expect(() => inventory.archiveBorrower(borrower.id, true)).toThrow(
      expect.objectContaining({ code: 'active_loan' }),
    );
    inventory.returnCheckout(checkoutId, 1, 0);
    expect(inventory.listLoans()[0]?.outstanding).toBe(1);
    expect(() => inventory.returnCheckout(checkoutId, 2, 0)).toThrow(
      expect.objectContaining({ code: 'over_return' }),
    );
    expect(inventory.listLoans()[0]?.outstanding).toBe(1);
    db.close();
  });

  it('projects lost, damaged, repaired, and written-off lifecycles without rewriting history', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const item = inventory.createItem({ name: 'מסור', kind: 'non_consumable' });
    const borrower = inventory.createBorrower({ username: 'builder', name: 'בונה', type: 'other' });
    inventory.addStock(item.id, 3);
    const checkoutId = inventory.checkout(item.id, borrower.id, 3);
    inventory.markLost(checkoutId, 1, true);
    expect(inventory.listLoans()[0]).toMatchObject({ outstanding: 2, lost: 1 });
    const beforeRestoration = inventory.listLedger();
    expect(() => inventory.markLost(checkoutId, 2, false as unknown as true)).toThrow(
      expect.objectContaining({ code: 'unsupported_restoration' }),
    );
    expect(inventory.listLedger()).toEqual(beforeRestoration);
    expect(inventory.listLoans()[0]).toMatchObject({ outstanding: 2, lost: 1 });
    foundReturned(inventory, checkoutId, 1);
    expect(inventory.listLoans()[0]).toMatchObject({ outstanding: 2, lost: 0 });
    inventory.returnCheckout(checkoutId, 0, 2);
    expect(inventory.listItems('מסור')[0]).toMatchObject({ available: 1, damaged: 2 });
    inventory.resolveDamage(item.id, 1, true);
    inventory.resolveDamage(item.id, 1, false);
    expect(inventory.listItems('מסור')[0]).toMatchObject({ available: 2, damaged: 0 });
    expect(inventory.listLedger()).toHaveLength(7);
    db.close();
  });

  it('blocks archival through partial recovery and permits it after all equipment is settled', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const item = inventory.createItem({ name: 'Archival lifecycle', kind: 'non_consumable' });
    const borrower = inventory.createBorrower({
      username: 'archive-lifecycle',
      name: 'Archive lifecycle',
      type: 'other',
    });
    inventory.addStock(item.id, 4);
    const checkout = inventory.checkout(item.id, borrower.id, 4);
    inventory.markLost(checkout, 2, true);
    foundReturned(inventory, checkout, 1);
    expect(inventory.listLoans()[0]).toMatchObject({ outstanding: 2, lost: 1 });
    const expectArchivalBlocked = () => {
      expect(() => inventory.archiveItem(item.id, true)).toThrow(
        expect.objectContaining({ code: 'active_loan' }),
      );
      expect(() => inventory.archiveBorrower(borrower.id, true)).toThrow(
        expect.objectContaining({ code: 'active_loan' }),
      );
      expect(db.prepare('SELECT archived FROM items WHERE id=?').get(item.id)).toEqual({
        archived: 0,
      });
      expect(db.prepare('SELECT archived FROM borrowers WHERE id=?').get(borrower.id)).toEqual({
        archived: 0,
      });
    };
    expectArchivalBlocked();
    inventory.returnCheckout(checkout, 2, 0);
    expect(inventory.listLoans()[0]).toMatchObject({ outstanding: 0, lost: 1 });
    expectArchivalBlocked();
    foundReturned(inventory, checkout, 1);
    expect(inventory.listLoans()).toEqual([]);
    inventory.archiveItem(item.id, true);
    inventory.archiveBorrower(borrower.id, true);
    expect(db.prepare('SELECT archived FROM items WHERE id=?').get(item.id)).toEqual({
      archived: 1,
    });
    expect(db.prepare('SELECT archived FROM borrowers WHERE id=?').get(borrower.id)).toEqual({
      archived: 1,
    });
    db.close();
  });

  it('preserves omitted item fields while replacing aliases and enforces alias bounds', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const location = inventory.listLocations().find((entry) => entry.code === 'monster')!;
    const item = inventory.createItem({
      name: 'חבל',
      kind: 'consumable',
      lotSize: 5,
      locationId: location.id,
      aliases: ['Rope', 'ישן'],
    });
    const updated = inventory.updateItem(item.id, { name: 'חבל חדש', aliases: ['Cord'] });
    expect(updated).toMatchObject({ lotSize: 5, locationId: location.id, aliases: ['Cord'] });
    expect(inventory.listItems('rope')).toEqual([]);
    expect(inventory.listItems('cord')).toHaveLength(1);
    expect(inventory.updateItem(item.id, { name: 'חבל סופי' }).aliases).toEqual(['Cord']);
    expect(() => inventory.updateItem(item.id, { name: item.name, aliases: [' '] })).toThrow(
      expect.objectContaining({ code: 'invalid_alias' }),
    );
    expect(() =>
      inventory.createItem({
        name: 'עודף',
        kind: 'consumable',
        aliases: Array.from({ length: 21 }, (_, index) => `a${index}`),
      }),
    ).toThrow(expect.objectContaining({ code: 'too_many_aliases' }));
    expect(() => inventory.updateLocation(999, { code: 'missing', name: 'חסר' })).toThrow(
      expect.objectContaining({ code: 'not_found', status: 404 }),
    );
    db.close();
  });

  it('rejects archiving an item until damaged stock is resolved', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const item = inventory.createItem({ name: 'מקדחה', kind: 'non_consumable' });
    const borrower = inventory.createBorrower({
      username: 'repair-user',
      name: 'מתקן',
      type: 'individual',
    });
    inventory.addStock(item.id, 1);
    const checkout = inventory.checkout(item.id, borrower.id, 1);
    inventory.returnCheckout(checkout, 0, 1, 'נשבר');
    expect(() => inventory.archiveItem(item.id, true)).toThrow(
      expect.objectContaining({ code: 'damaged_stock' }),
    );
    inventory.resolveDamage(item.id, 1, false, 'לא ניתן לתקן');
    inventory.archiveItem(item.id, true);
    expect(inventory.listItems('', true)[0]?.archived).toBe(true);
    db.close();
  });
});
