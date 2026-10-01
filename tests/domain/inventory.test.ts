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

function checkoutDatabaseForReopen() {
  const directory = mkdtempSync(join(tmpdir(), 'mapatz-checkout-integrity-'));
  cleanup.push(directory);
  const filename = join(directory, 'inventory.sqlite');
  const db = openDatabase(filename);
  const inventory = new InventoryService(db);
  const borrower = inventory.createBorrower({
    username: 'checkout-owner',
    name: 'Checkout Owner',
    type: 'individual',
  });
  const otherBorrower = inventory.createBorrower({
    username: 'other-owner',
    name: 'Other Owner',
    type: 'individual',
  });
  const item = inventory.createItem({ name: 'Checkout integrity item', kind: 'non_consumable' });
  inventory.addStock(item.id, 3);
  const checkoutId = inventory.checkout(item.id, borrower.id, 2);
  return {
    db,
    filename,
    itemId: item.id,
    otherBorrowerId: otherBorrower.id,
    checkoutId,
  };
}

describe('inventory domain', () => {
  it('rolls back an audit append when its stored-state update fails', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const item = inventory.createItem({ name: 'Atomic state', kind: 'non_consumable' });
    const before = {
      item: inventory.listItems()[0],
      events: db.prepare('SELECT COUNT(*) count FROM inventory_events').get(),
      clock: db.prepare('SELECT revision FROM state_clock').get(),
    };
    db.exec(`CREATE TRIGGER fail_state_update BEFORE UPDATE ON item_state
      BEGIN SELECT RAISE(ABORT, 'state update failed'); END`);
    expect(() => inventory.addStock(item.id, 1)).toThrow('state update failed');
    expect(inventory.listItems()[0]).toEqual(before.item);
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual(before.events);
    expect(db.prepare('SELECT revision FROM state_clock').get()).toEqual(before.clock);
    db.close();
  });

  it('rejects unsafe balance arithmetic without appending an audit event', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const item = inventory.createItem({ name: 'Safe arithmetic', kind: 'non_consumable' });
    inventory.addStock(item.id, Number.MAX_SAFE_INTEGER);
    const before = inventory.listItems()[0];
    const eventCount = db.prepare('SELECT COUNT(*) count FROM inventory_events').get();
    expect(() => inventory.addStock(item.id, 1)).toThrow();
    expect(inventory.listItems()[0]).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual(eventCount);
    db.close();
  });

  it('rejects movement that makes a non-consumable combined total unsafe atomically', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const borrower = inventory.createBorrower({
      username: 'total-owner',
      name: 'Total Owner',
      type: 'individual',
    });
    const item = inventory.createItem({ name: 'Combined total', kind: 'non_consumable' });
    inventory.addStock(item.id, Number.MAX_SAFE_INTEGER);
    inventory.checkout(item.id, borrower.id, 1);
    const before = inventory.listItems()[0];
    const eventCount = db.prepare('SELECT COUNT(*) count FROM inventory_events').get();
    const revision = db.prepare('SELECT revision FROM state_clock').get();

    expect(() => inventory.addStock(item.id, 1)).toThrow(
      expect.objectContaining({ code: 'excessive_quantity' }),
    );
    expect(inventory.listItems()[0]).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual(eventCount);
    expect(db.prepare('SELECT revision FROM state_clock').get()).toEqual(revision);
    db.close();
  });

  it('rejects a loan whose checkout audit identity changed before reopen', () => {
    const state = checkoutDatabaseForReopen();
    state.db
      .prepare('UPDATE loan_state SET borrower_id=? WHERE checkout_id=?')
      .run(state.otherBorrowerId, state.checkoutId);
    state.db.close();

    expect(() => openDatabase(state.filename)).toThrow(/inconsistent checkout and loan state/);
  });

  it('rejects a checkout event without operational loan state before reopen', () => {
    const state = checkoutDatabaseForReopen();
    state.db.prepare('DELETE FROM loan_state WHERE checkout_id=?').run(state.checkoutId);
    state.db.prepare('UPDATE item_state SET borrowed=0 WHERE item_id=?').run(state.itemId);
    state.db.close();

    expect(() => openDatabase(state.filename)).toThrow(/inconsistent checkout and loan state/);
  });

  it('rejects operational aggregate corruption before reopen', () => {
    const state = checkoutDatabaseForReopen();
    state.db.prepare('UPDATE item_state SET borrowed=borrowed+1 WHERE item_id=?').run(state.itemId);
    state.db.close();

    expect(() => openDatabase(state.filename)).toThrow(/invalid authoritative inventory balances/);
  });

  it('uses stored balances and loan identity after restart with audit SELECTs blocked', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-stored-state-'));
    cleanup.push(directory);
    const filename = join(directory, 'inventory.sqlite');
    let db = openDatabase(filename);
    let inventory = new InventoryService(db);
    const borrower = inventory.createBorrower({
      username: 'test',
      name: 'Test',
      type: 'individual',
    });
    const item = inventory.createItem({ name: 'Radio case', kind: 'non_consumable' });
    inventory.addStock(item.id, 3);
    const checkoutId = inventory.checkout(item.id, borrower.id, 2);
    inventory.markLost(checkoutId, 1, true);
    db.close();

    db = openDatabase(filename);
    const guarded = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            if (/^\s*SELECT\b/i.test(sql) && /\binventory_events\b/i.test(sql))
              throw new Error('Operational audit SELECT blocked');
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as typeof db;
    inventory = new InventoryService(guarded);
    expect(inventory.listItems()[0]).toMatchObject({ available: 1, borrowed: 1, lost: 1 });
    expect(inventory.listLoans()[0]).toMatchObject({ checkoutId, outstanding: 1, lost: 1 });
    expect(inventory.getBorrowerDeskSnapshot(borrower.id).holdings).toEqual([
      { itemId: item.id, returnable: 1, lost: 1 },
    ]);
    inventory.returnCheckout(checkoutId, 1, 0);
    expect(() => inventory.archiveItem(item.id, true)).toThrow();
    db.close();
  });
  it('issues an atomic anonymous batch and replays committed and rejected outcomes', () => {
    const db = openDatabase(':memory:');
    try {
      const inventory = new InventoryService(db);
      const first = inventory.createItem({ name: 'Tape', kind: 'consumable' });
      const second = inventory.createItem({ name: 'Ties', kind: 'consumable' });
      inventory.addStock(first.id, 3);
      inventory.addStock(second.id, 2);
      const input = {
        key: crypto.randomUUID(),
        ledgerEpoch: 1,
        items: [
          { itemId: first.id, quantity: 2, note: 'desk' },
          { itemId: second.id, quantity: 1, note: '' },
        ],
      };
      expect(inventory.issueBatch(input)).toMatchObject({ outcome: 'committed', replayed: false });
      expect(inventory.issueBatch(input)).toMatchObject({ outcome: 'committed', replayed: true });
      expect(
        db
          .prepare(
            "SELECT item_id itemId, borrower_id borrowerId, related_event_id checkoutId FROM inventory_events WHERE kind='issued' ORDER BY id",
          )
          .all(),
      ).toEqual([
        { itemId: first.id, borrowerId: null, checkoutId: null },
        { itemId: second.id, borrowerId: null, checkoutId: null },
      ]);
      const shortage = {
        ...input,
        key: crypto.randomUUID(),
        items: [
          { itemId: first.id, quantity: 2, note: '' },
          { itemId: second.id, quantity: 2, note: '' },
        ],
      };
      expect(inventory.issueBatch(shortage)).toMatchObject({
        outcome: 'rejected',
        conflicts: [
          { itemId: first.id, code: 'insufficient_stock' },
          { itemId: second.id, code: 'insufficient_stock' },
        ],
      });
      expect(
        db.prepare("SELECT COUNT(*) count FROM inventory_events WHERE kind='issued'").get(),
      ).toEqual({ count: 2 });
      expect(inventory.issueBatch(shortage)).toMatchObject({ outcome: 'rejected', replayed: true });
      const repeated = {
        key: crypto.randomUUID(),
        ledgerEpoch: 1,
        items: [
          { itemId: first.id, quantity: 1, note: '' },
          { itemId: first.id, quantity: 1, note: '' },
        ],
      };
      expect(inventory.issueBatch(repeated)).toMatchObject({
        outcome: 'rejected',
        conflicts: [{ itemId: first.id, code: 'insufficient_stock', available: 1 }],
      });
      const tool = inventory.createItem({ name: 'Hammer', kind: 'non_consumable' });
      inventory.addStock(tool.id, 2);
      expect(
        inventory.issueBatch({
          key: crypto.randomUUID(),
          ledgerEpoch: 1,
          items: [{ itemId: tool.id, quantity: 1, note: '' }],
        }),
      ).toMatchObject({
        outcome: 'rejected',
        conflicts: [{ itemId: tool.id, code: 'wrong_item_kind' }],
      });
      expect(
        db.prepare("SELECT COUNT(*) count FROM inventory_events WHERE kind='issued'").get(),
      ).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });
  it('adds the recoverable credential column to an existing version-7 profile', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-password-migration-'));
    cleanup.push(directory);
    const filename = join(directory, 'inventory.sqlite');
    const legacy = openDatabase(filename);
    legacy.exec('ALTER TABLE credentials DROP COLUMN recoverable_password');
    legacy.prepare('DELETE FROM migrations WHERE version=8').run();
    legacy.close();

    const migrated = openDatabase(filename);
    const columns = migrated.prepare('PRAGMA table_info(credentials)').all() as { name: string }[];
    expect(columns.some((column) => column.name === 'recoverable_password')).toBe(true);
    expect(migrated.prepare('SELECT version FROM migrations WHERE version=8').get()).toEqual({
      version: 8,
    });
    migrated.close();
  });

  it('rejects an old database without authoritative state before changing its schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-old-state-'));
    cleanup.push(directory);
    const filename = join(directory, 'inventory.sqlite');
    const legacy = new DatabaseSync(filename);
    legacy.exec(
      readFileSync(new URL('../../src/db/migrations/001_initial.sql', import.meta.url), 'utf8'),
    );
    legacy.prepare('INSERT INTO migrations(version) VALUES (1)').run();
    legacy.close();

    expect(() => openDatabase(filename)).toThrow('missing authoritative inventory state');
    const unchanged = new DatabaseSync(filename);
    expect(unchanged.prepare('SELECT version FROM migrations').all()).toEqual([{ version: 1 }]);
    unchanged.close();
  });

  it('migrates idempotently, seeds locations, and persists monotonic identities and stored state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-domain-'));
    cleanup.push(directory);
    const filename = join(directory, 'inventory.sqlite');
    let db = openDatabase(filename);
    let inventory = new InventoryService(db);
    expect(inventory.listLocations().map((location) => location.code)).toEqual(
      expect.arrayContaining(['monster', 'kabira', 'submarine']),
    );
    const gloves = inventory.createItem({ name: 'כפפות', kind: 'consumable', aliases: ['Gloves'] });
    expect(gloves.id).toBe(1);
    expect(gloves).not.toHaveProperty('code');
    expect(
      db
        .prepare('PRAGMA table_info(items)')
        .all()
        .map((column) => column.name),
    ).not.toContain('code');
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='code_sequence'").get(),
    ).toBeUndefined();
    expect(inventory.listItems(String(gloves.id))).toEqual([]);
    inventory.addStock(gloves.id, 12);
    inventory.issue(gloves.id, 3);
    db.close();

    db = openDatabase(filename);
    inventory = new InventoryService(db);
    expect(
      (db.prepare('SELECT COUNT(*) count FROM migrations').get() as { count: number }).count,
    ).toBe(9);
    expect(inventory.listItems('gLoV')).toHaveLength(1);
    expect(inventory.listItems('Gloves')[0]?.available).toBe(9);
    expect(inventory.createItem({ name: 'פטיש', kind: 'non_consumable' }).id).toBe(2);
    expect(() => db.prepare('UPDATE inventory_events SET quantity=99 WHERE id=1').run()).toThrow(
      /immutable/,
    );
    expect(() => db.prepare('DELETE FROM inventory_events WHERE id=1').run()).toThrow(/immutable/);
    db.close();
  });

  it('keeps item names unique across create, update, archive state, and direct writes', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const original = inventory.createItem({
      name: 'TÉNT',
      kind: 'non_consumable',
      aliases: ['Shelter'],
    });
    inventory.archiveItem(original.id, true);
    const identityHighWaterBeforeConflict = db
      .prepare(
        "SELECT result_json FROM inventory_command_receipts WHERE key='system:identity-high-water'",
      )
      .get();

    expect(() => inventory.createItem({ name: '\t  tént\n', kind: 'consumable' })).toThrow(
      expect.objectContaining({ code: 'duplicate_item_name', status: 409 }),
    );
    expect(
      db
        .prepare(
          "SELECT result_json FROM inventory_command_receipts WHERE key='system:identity-high-water'",
        )
        .get(),
    ).toEqual(identityHighWaterBeforeConflict);

    const other = inventory.createItem({ name: 'Lantern', kind: 'non_consumable' });
    expect(() =>
      inventory.updateItem(other.id, {
        name: 'TE\u0301NT',
        aliases: ['Changed only on success'],
      }),
    ).toThrow(expect.objectContaining({ code: 'duplicate_item_name', status: 409 }));
    expect(inventory.listItems('', true).find((item) => item.id === other.id)).toMatchObject({
      name: 'Lantern',
      aliases: [],
    });

    expect(() =>
      db
        .prepare(
          "INSERT INTO items(name,kind) VALUES (char(9) || 'tént' || char(10),'non_consumable')",
        )
        .run(),
    ).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE items SET name='TÉNT' WHERE id=?").run(other.id)).toThrow(
      /UNIQUE/,
    );
    db.close();
  });

  it('tracks camp equipment by quantity while rejecting issue and checkout lifecycles', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const item = inventory.createItem({ name: 'שולחן קבוע', kind: 'camp_equipment' });
    inventory.addStock(item.id, 8);
    expect(inventory.listItems(item.name)[0]).toMatchObject({
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
      expect.objectContaining({ code: 'nonzero_balances' }),
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
        expect.objectContaining({ code: 'nonzero_balances' }),
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
    expect(
      inventory.commitBorrowerOperations(borrower.id, '00000000-0000-4000-8000-000000000028', {
        contractVersion: 1,
        ledgerEpoch: inventory.getBorrowerDeskSnapshot(borrower.id).ledgerEpoch,
        items: [
          {
            itemId: item.id,
            lostCredit: [{ quantity: 1, condition: 'damaged', note: 'final damaged recovery' }],
          },
        ],
      }),
    ).toMatchObject({ outcome: 'committed' });
    expect(inventory.listLoans()).toEqual([]);
    expect(() => inventory.archiveItem(item.id, true)).toThrow(
      expect.objectContaining({ code: 'nonzero_balances' }),
    );
    inventory.archiveBorrower(borrower.id, true);
    inventory.resolveDamage(item.id, 1, true);
    inventory.saveInventoryItem({
      key: 'zero-before-archive',
      itemId: item.id,
      name: item.name,
      aliases: [],
      lotSize: null,
      locationId: null,
      targetAvailable: 0,
      stockRevision: inventory.listItems(item.name)[0]!.stockRevision,
    });
    inventory.archiveItem(item.id, true);
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
      expect.objectContaining({ code: 'nonzero_balances' }),
    );
    inventory.resolveDamage(item.id, 1, false, 'לא ניתן לתקן');
    inventory.archiveItem(item.id, true);
    expect(inventory.listItems('', true)[0]?.archived).toBe(true);
    db.close();
  });
});
