import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { InventoryService } from '../../src/domain/inventory.js';

const setup = () => {
  const db = openDatabase(':memory:');
  return { db, inventory: new InventoryService(db) };
};

describe('inventory management commands', () => {
  it('replays an uncertain location creation without inserting a second location', () => {
    const { db, inventory } = setup();
    const command = { key: 'location-create-1', code: 'A-1', name: 'Storage' };
    const initialCount = inventory.listLocations(true).length;
    const created = inventory.saveInventoryLocation(command);
    expect(inventory.saveInventoryLocation(command)).toEqual(created);
    expect(inventory.listLocations(true)).toHaveLength(initialCount + 1);
    expect(() =>
      inventory.saveInventoryLocation({ ...command, name: 'Different storage' }),
    ).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));
    expect(inventory.listLocations(true)).toHaveLength(initialCount + 1);
    db.close();
  });

  it('creates item and stock together, and rejects a duplicate without an item or event', () => {
    const { db, inventory } = setup();
    const input = {
      key: 'create-item-0001',
      name: 'Tent',
      kind: 'camp_equipment' as const,
      aliases: ['Shelter'],
      lotSize: null,
      locationId: null,
      targetAvailable: 20,
      note: '',
    };
    const created = inventory.saveInventoryItem(input);
    expect(created).toMatchObject({ available: 20, borrowed: 0, lost: 0, damaged: 0 });
    expect(inventory.listLedger()).toMatchObject([{ kind: 'stock_added', quantity: 20 }]);
    expect(inventory.saveInventoryItem(input)).toEqual(created);
    expect(inventory.listLedger()).toHaveLength(1);
    expect(() =>
      inventory.saveInventoryItem({
        ...input,
        key: 'create-item-0002',
        name: 'tent',
        targetAvailable: 4,
      }),
    ).toThrow(expect.objectContaining({ code: 'duplicate_item_name' }));
    expect(inventory.listItems()).toHaveLength(1);
    expect(inventory.listLedger()).toHaveLength(1);
    db.close();
  });

  it('saves absolute counts and metadata atomically, rejects stale counts, and permits metadata-only saves', () => {
    const { db, inventory } = setup();
    const item = inventory.createItem({ name: 'Hammer', kind: 'non_consumable' });
    inventory.addStock(item.id, 20);
    const snapshot = inventory.listItems('Hammer')[0]!;
    const base = { itemId: item.id, aliases: [], lotSize: null, locationId: null, note: '' };
    const reduced = inventory.saveInventoryItem({
      ...base,
      key: 'count-down-0001',
      name: 'Hammer one',
      targetAvailable: 17,
      stockSnapshot: snapshot.stockSnapshot,
    });
    expect(reduced.available).toBe(17);
    expect(inventory.listLedger()[0]).toMatchObject({ kind: 'stock_removed', quantity: 3 });
    const increased = inventory.saveInventoryItem({
      ...base,
      key: 'count-up-00001',
      name: 'Hammer two',
      targetAvailable: 25,
      stockSnapshot: reduced.stockSnapshot,
    });
    expect(increased.available).toBe(25);
    expect(inventory.listLedger()[0]).toMatchObject({ kind: 'stock_added', quantity: 8 });
    inventory.addStock(item.id, 1);
    const ledgerBefore = inventory.listLedger();
    expect(() =>
      inventory.saveInventoryItem({
        ...base,
        key: 'stale-count-01',
        name: 'Unsaved name',
        targetAvailable: 17,
        stockSnapshot: increased.stockSnapshot,
      }),
    ).toThrow(expect.objectContaining({ code: 'stale_stock' }));
    expect(inventory.listItems('Hammer two')[0]).toMatchObject({
      available: 26,
      name: 'Hammer two',
    });
    expect(inventory.listLedger()).toEqual(ledgerBefore);
    inventory.saveInventoryItem({ ...base, key: 'metadata-only-1', name: 'Hammer three' });
    expect(inventory.listItems('Hammer three')[0]?.available).toBe(26);
    expect(
      inventory.listLedger().map(({ id, kind, quantity }) => ({ id, kind, quantity })),
    ).toEqual(ledgerBefore.map(({ id, kind, quantity }) => ({ id, kind, quantity })));
    expect(() =>
      inventory.saveInventoryItem({
        ...base,
        key: 'invalid-count-1',
        name: 'Bad',
        targetAvailable: -1,
        stockSnapshot: 0,
      }),
    ).toThrow();
    expect(inventory.listItems('Hammer three')[0]?.name).toBe('Hammer three');
    db.close();
  });

  it('rejects a target of 17 after checkout changes the observed 20 to 18', () => {
    const { db, inventory } = setup();
    const item = inventory.createItem({ name: 'Checkout race', kind: 'non_consumable' });
    const borrower = inventory.createBorrower({
      username: 'race',
      name: 'Race',
      type: 'individual',
    });
    inventory.addStock(item.id, 20);
    const snapshot = inventory.listItems('Checkout race')[0]!;
    inventory.checkout(item.id, borrower.id, 2);
    expect(() =>
      inventory.saveInventoryItem({
        key: 'checkout-race-01',
        itemId: item.id,
        name: 'Uncommitted rename',
        aliases: [],
        lotSize: null,
        locationId: null,
        targetAvailable: 17,
        stockSnapshot: snapshot.stockSnapshot,
      }),
    ).toThrow(expect.objectContaining({ code: 'stale_stock' }));
    expect(inventory.listItems('Checkout race')[0]).toMatchObject({
      available: 18,
      borrowed: 2,
      name: 'Checkout race',
    });
    expect(inventory.listLedger().map((event) => event.kind)).toEqual([
      'checked_out',
      'stock_added',
    ]);
    db.close();
  });

  it('records a five-unit addition when an absolute target changes from 20 to 25', () => {
    const { db, inventory } = setup();
    const item = inventory.createItem({ name: 'Count up', kind: 'camp_equipment' });
    inventory.addStock(item.id, 20);
    const snapshot = inventory.listItems('Count up')[0]!;
    inventory.saveInventoryItem({
      key: 'count-up-five',
      itemId: item.id,
      name: item.name,
      aliases: [],
      lotSize: null,
      locationId: null,
      targetAvailable: 25,
      stockSnapshot: snapshot.stockSnapshot,
    });
    expect(inventory.listItems('Count up')[0]?.available).toBe(25);
    expect(inventory.listLedger()[0]).toMatchObject({ kind: 'stock_added', quantity: 5 });
    db.close();
  });

  it('resolves damage once, preserves loan balances, and checks quantity against current damage', () => {
    const { db, inventory } = setup();
    const item = inventory.createItem({ name: 'Saw', kind: 'non_consumable' });
    const borrower = inventory.createBorrower({
      username: 'worker',
      name: 'Worker',
      type: 'individual',
    });
    inventory.addStock(item.id, 14);
    const checkout = inventory.checkout(item.id, borrower.id, 4);
    inventory.returnCheckout(checkout, 0, 4);
    const before = inventory.listItems('Saw')[0]!;
    expect(before).toMatchObject({ available: 10, borrowed: 0, lost: 0, damaged: 4 });
    const command = {
      key: 'damage-repair-1',
      itemId: item.id,
      quantity: 2,
      repaired: true,
      note: '',
    };
    const first = inventory.resolveDamageCommand(command);
    expect(inventory.resolveDamageCommand(command)).toEqual(first);
    expect(inventory.listItems('Saw')[0]).toMatchObject({
      available: 12,
      damaged: 2,
      borrowed: 0,
      lost: 0,
    });
    expect(() =>
      inventory.resolveDamageCommand({ ...command, key: 'damage-too-many', quantity: 3 }),
    ).toThrow(expect.objectContaining({ code: 'excessive_quantity' }));
    inventory.resolveDamageCommand({ ...command, key: 'damage-writeoff', repaired: false });
    expect(inventory.listItems('Saw')[0]).toMatchObject({
      available: 12,
      damaged: 0,
      borrowed: 0,
      lost: 0,
    });
    db.close();
  });

  it('zeros available stock while archiving and prevents archived locations on active items', () => {
    const { db, inventory } = setup();
    const location = inventory.createLocation('store', 'Store');
    const item = inventory.createItem({
      name: 'Rope',
      kind: 'consumable',
      locationId: Number(location.id),
    });
    expect(() =>
      inventory.updateLocation(Number(location.id), {
        code: 'store',
        name: 'Store',
        archived: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'location_in_use' }));
    inventory.addStock(item.id, 1);
    inventory.archiveItem(item.id, true);
    expect(inventory.listItems('Rope', true)[0]).toMatchObject({ archived: true, available: 0 });
    expect(inventory.listLedger()[0]).toMatchObject({
      kind: 'stock_removed',
      quantity: 1,
      note: 'ארכוב פריט',
    });
    inventory.updateLocation(Number(location.id), { code: 'store', name: 'Store', archived: true });
    expect(() => inventory.archiveItem(item.id, false)).toThrow(
      expect.objectContaining({ code: 'invalid_location' }),
    );
    inventory.archiveItem(item.id, false, null);
    expect(inventory.listItems('Rope')[0]).toMatchObject({
      locationId: null,
      archived: false,
      available: 0,
    });
    db.close();
  });

  it('rejects an old ledger command after replacement and replays archive without undoing later changes', () => {
    const { db, inventory } = setup();
    const item = inventory.createItem({ name: 'Archive replay', kind: 'non_consumable' });
    const epoch = inventory.inventoryEpoch();
    const archive = {
      key: 'archive-replay-1',
      ledgerEpoch: epoch,
      itemId: item.id,
      archived: true,
    };
    inventory.archiveItemCommand(archive);
    inventory.archiveItemCommand({ ...archive, key: 'archive-restore-1', archived: false });
    expect(inventory.archiveItemCommand(archive)).toEqual({ itemId: item.id, archived: true });
    expect(inventory.listItems('Archive replay', true)[0]?.archived).toBe(false);
    db.prepare(
      'UPDATE inventory_replacement_guard SET ledger_epoch=ledger_epoch+1 WHERE singleton=1',
    ).run();
    expect(() => inventory.archiveItemCommand(archive)).toThrow(
      expect.objectContaining({ code: 'stale_ledger' }),
    );
    db.close();
  });

  it('replays a keyed archive without removing available stock twice', () => {
    const { db, inventory } = setup();
    const item = inventory.createItem({ name: 'Archive stock replay', kind: 'consumable' });
    inventory.addStock(item.id, 5);
    const command = {
      key: 'archive-stock-replay-1',
      ledgerEpoch: inventory.inventoryEpoch(),
      itemId: item.id,
      archived: true,
    };
    expect(inventory.archiveItemCommand(command)).toEqual({ itemId: item.id, archived: true });
    expect(inventory.listItems('', true)[0]).toMatchObject({ archived: true, available: 0 });
    expect(inventory.archiveItemCommand(command)).toEqual({ itemId: item.id, archived: true });
    expect(inventory.listLedger().filter((event) => event.kind === 'stock_removed')).toMatchObject([
      { quantity: 5 },
    ]);
    db.close();
  });

  it('blocks archive when only the lost balance remains', () => {
    const { db, inventory } = setup();
    const item = inventory.createItem({ name: 'Lost only', kind: 'non_consumable' });
    const borrower = inventory.createBorrower({
      username: 'lost-only',
      name: 'Lost',
      type: 'individual',
    });
    inventory.addStock(item.id, 1);
    const checkout = inventory.checkout(item.id, borrower.id, 1);
    inventory.markLost(checkout, 1, true);
    expect(inventory.listItems('Lost only', true)[0]).toMatchObject({
      available: 0,
      borrowed: 0,
      lost: 1,
      damaged: 0,
    });
    expect(() =>
      inventory.archiveItemCommand({
        key: 'lost-archive-1',
        ledgerEpoch: inventory.inventoryEpoch(),
        itemId: item.id,
        archived: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'nonzero_balances' }));
    db.close();
  });
});
