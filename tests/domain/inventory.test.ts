import { mkdtempSync, rmSync } from 'node:fs';
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
    ).toBe(1);
    expect(inventory.listItems('gLoV')).toHaveLength(1);
    expect(inventory.listItems('100')[0]?.available).toBe(9);
    expect(inventory.createItem({ name: 'פטיש', kind: 'non_consumable' }).code).toBe(101);
    expect(() => db.prepare('UPDATE inventory_events SET quantity=99 WHERE id=1').run()).toThrow(
      /immutable/,
    );
    expect(() => db.prepare('DELETE FROM inventory_events WHERE id=1').run()).toThrow(/immutable/);
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
    expect(() => inventory.markLost(checkoutId, 2, false)).toThrow(
      expect.objectContaining({ code: 'excessive_quantity' }),
    );
    inventory.markLost(checkoutId, 1, false);
    expect(inventory.listLoans()[0]).toMatchObject({ outstanding: 3, lost: 0 });
    inventory.returnCheckout(checkoutId, 1, 2);
    expect(inventory.listItems('מסור')[0]).toMatchObject({ available: 1, damaged: 2 });
    inventory.resolveDamage(item.id, 1, true);
    inventory.resolveDamage(item.id, 1, false);
    expect(inventory.listItems('מסור')[0]).toMatchObject({ available: 2, damaged: 0 });
    expect(inventory.listLedger()).toHaveLength(8);
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
