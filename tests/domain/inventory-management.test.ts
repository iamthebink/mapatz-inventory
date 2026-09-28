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

  it('rejects the identity high-water receipt key for every inventory command', () => {
    const { db, inventory } = setup();
    const location = inventory.createLocation('reserved-key-location', 'Reserved key location');
    const item = inventory.createItem({
      name: 'Reserved key item',
      kind: 'consumable',
      locationId: Number(location.id),
    });
    const borrower = inventory.createBorrower({
      username: 'reserved-key-borrower',
      name: 'Reserved key borrower',
      type: 'individual',
    });
    const preview = inventory.listItems('Reserved key item')[0]!;
    const borrowerPreview = inventory.borrowerDeletionStatus(borrower.id);
    const locationCount = inventory.listLocations(true).length;
    const ledgerEpoch = inventory.inventoryEpoch();
    const reservedKey = 'system:identity-high-water';
    const commands = [
      () =>
        inventory.saveInventoryLocation({
          key: reservedKey,
          ledgerEpoch,
          code: 'new-location',
          name: 'New location',
        }),
      () =>
        inventory.retireLocationCommand({
          key: reservedKey,
          ledgerEpoch,
          locationId: Number(location.id),
          action: 'delete',
          expectedItemIds: [item.id],
          expectedCode: location.code,
          expectedName: location.name,
        }),
      () =>
        inventory.saveInventoryItem({
          key: reservedKey,
          ledgerEpoch,
          itemId: item.id,
          name: item.name,
          aliases: [],
          lotSize: null,
          locationId: Number(location.id),
        }),
      () =>
        inventory.archiveItemCommand({
          key: reservedKey,
          ledgerEpoch,
          itemId: item.id,
          archived: true,
        }),
      () =>
        inventory.deleteItemCommand({
          key: reservedKey,
          ledgerEpoch,
          itemId: item.id,
          expectedStockRevision: preview.stockRevision,
          expectedCode: preview.code,
          expectedName: preview.name,
          expectedLocationId: preview.locationId,
        }),
      () =>
        inventory.deleteBorrowerCommand({
          key: reservedKey,
          ledgerEpoch,
          borrowerId: borrower.id,
          expectedStateRevision: borrowerPreview.stateRevision,
          expectedOutstanding: 0,
          expectedLost: 0,
          expectedName: borrower.name,
          expectedUsername: borrower.username,
        }),
      () =>
        inventory.issueBatch({
          key: reservedKey,
          ledgerEpoch,
          items: [{ itemId: item.id, quantity: 1, note: '' }],
        }),
      () =>
        inventory.resolveDamageCommand({
          key: reservedKey,
          ledgerEpoch,
          itemId: item.id,
          quantity: 1,
          repaired: true,
          note: '',
        }),
    ];

    for (const command of commands)
      expect(command).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));
    expect(inventory.listItems('Reserved key item')).toHaveLength(1);
    expect(inventory.listLocations(true)).toHaveLength(locationCount);
    expect(inventory.listBorrowers('', true)).toHaveLength(1);
    expect(
      db
        .prepare('SELECT COUNT(*) count FROM inventory_command_receipts WHERE key=?')
        .get(reservedKey),
    ).toEqual({ count: 1 });
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
      stockRevision: snapshot.stockRevision,
    });
    expect(reduced.available).toBe(17);
    expect(inventory.listLedger()[0]).toMatchObject({ kind: 'stock_removed', quantity: 3 });
    const increased = inventory.saveInventoryItem({
      ...base,
      key: 'count-up-00001',
      name: 'Hammer two',
      targetAvailable: 25,
      stockRevision: reduced.stockRevision,
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
        stockRevision: increased.stockRevision,
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
        stockRevision: 0,
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
        stockRevision: snapshot.stockRevision,
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

  it('invalidates an observed revision even when stock returns to its old quantity', () => {
    const { db, inventory } = setup();
    const item = inventory.createItem({ name: 'Revision cycle', kind: 'non_consumable' });
    inventory.addStock(item.id, 5);
    const observed = inventory.listItems('Revision cycle')[0]!;
    inventory.addStock(item.id, 1);
    const increased = inventory.listItems('Revision cycle')[0]!;
    inventory.saveInventoryItem({
      key: 'revision-cycle-1',
      itemId: item.id,
      name: item.name,
      aliases: [],
      lotSize: null,
      locationId: null,
      targetAvailable: 5,
      stockRevision: increased.stockRevision,
    });
    expect(inventory.listItems('Revision cycle')[0]).toMatchObject({ available: 5 });
    expect(() =>
      inventory.saveInventoryItem({
        key: 'revision-cycle-stale',
        itemId: item.id,
        name: 'Uncommitted rename',
        aliases: [],
        lotSize: null,
        locationId: null,
        targetAvailable: 4,
        stockRevision: observed.stockRevision,
      }),
    ).toThrow(expect.objectContaining({ code: 'stale_stock' }));
    expect(inventory.listItems('Revision cycle')[0]).toMatchObject({ available: 5 });
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
      stockRevision: snapshot.stockRevision,
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
    expect(() =>
      inventory.updateLocation(Number(location.id), {
        code: 'store',
        name: 'Store',
        archived: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'location_in_use' }));
    const destination = inventory.createLocation('destination', 'Destination');
    inventory.retireLocationCommand({
      key: 'retire-archived-item-location',
      ledgerEpoch: inventory.inventoryEpoch(),
      locationId: Number(location.id),
      action: 'archive',
      replacementLocationId: Number(destination.id),
      expectedItemIds: [item.id],
      expectedCode: location.code,
      expectedName: location.name,
    });
    expect(() => inventory.archiveItem(item.id, false, Number(location.id))).toThrow(
      expect.objectContaining({ code: 'invalid_location' }),
    );
    inventory.archiveItem(item.id, false);
    expect(inventory.listItems('Rope')[0]).toMatchObject({
      locationId: Number(destination.id),
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

  it('deletes an eligible item atomically, replays its receipt, and never reuses its code or id', () => {
    const { db, inventory } = setup();
    const item = inventory.createItem({ name: 'Reusable name', kind: 'consumable' });
    inventory.addStock(item.id, 3);
    const before = inventory.listItems('Reusable name')[0]!;
    const maxEventIdBeforeDelete = Number(
      (db.prepare('SELECT MAX(id) max_id FROM inventory_events').get() as { max_id: number })
        .max_id,
    );
    const command = {
      key: 'delete-item-0001',
      ledgerEpoch: inventory.inventoryEpoch(),
      itemId: item.id,
      expectedStockRevision: before.stockRevision,
      expectedCode: before.code,
      expectedName: before.name,
      expectedLocationId: before.locationId,
    };

    const committed = inventory.deleteItemCommand(command);
    expect(committed).toEqual({ outcome: 'committed', action: 'delete_item', itemId: item.id });
    expect(inventory.deleteItemCommand(command)).toEqual(committed);
    expect(inventory.listItems('Reusable name', true)).toEqual([]);
    expect(
      db.prepare('SELECT COUNT(*) count FROM inventory_events WHERE item_id=?').get(item.id),
    ).toEqual({ count: 0 });
    expect(
      db.prepare('SELECT COUNT(*) count FROM inventory_baselines WHERE item_id=?').get(item.id),
    ).toEqual({ count: 0 });
    expect(
      db.prepare('SELECT COUNT(*) count FROM item_aliases WHERE item_id=?').get(item.id),
    ).toEqual({ count: 0 });
    expect(
      db.prepare('SELECT result_json FROM inventory_command_receipts WHERE key=?').get(command.key),
    ).toEqual({
      result_json: JSON.stringify(committed),
    });
    expect(() =>
      inventory.deleteItemCommand({
        ...command,
        expectedStockRevision: command.expectedStockRevision + 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));

    const replacement = inventory.createItem({ name: 'Reusable name', kind: 'consumable' });
    inventory.addStock(replacement.id, 1);
    const replacementStockEvent = inventory.listLedger()[0]!;
    expect(replacement.id).toBeGreaterThan(item.id);
    expect(replacement.code).toBeGreaterThan(item.code);
    expect(replacementStockEvent.itemCode).toBe(replacement.code);
    expect(replacementStockEvent.id).toBeGreaterThan(maxEventIdBeforeDelete);
    expect(inventory.deleteItemCommand(command)).toEqual(committed);
    expect(inventory.listItems('Reusable name')[0]).toMatchObject({
      id: replacement.id,
      available: 1,
    });
    db.close();
  });

  it('reports newly ineligible item balances before stale confirmation and leaves deletion state untouched', () => {
    const { db, inventory } = setup();
    const item = inventory.createItem({ name: 'Eligibility race', kind: 'non_consumable' });
    const borrower = inventory.createBorrower({
      username: 'eligibility-race',
      name: 'Race',
      type: 'individual',
    });
    inventory.addStock(item.id, 2);
    const preview = inventory.listItems('Eligibility race')[0]!;
    const checkout = inventory.checkout(item.id, borrower.id, 1);
    const revisionBeforeDelete = Number(
      (
        db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get() as {
          revision: number;
        }
      ).revision,
    );
    const eventCountBeforeDelete = Number(
      (db.prepare('SELECT COUNT(*) count FROM inventory_events').get() as { count: number }).count,
    );
    const command = {
      key: 'delete-item-ineligible',
      ledgerEpoch: inventory.inventoryEpoch(),
      itemId: item.id,
      expectedStockRevision: preview.stockRevision,
      expectedCode: preview.code,
      expectedName: preview.name,
      expectedLocationId: preview.locationId,
    };

    expect(() => inventory.deleteItemCommand(command)).toThrow(
      expect.objectContaining({
        code: 'deletion_ineligible',
        message: expect.stringContaining('מושאל 1'),
      }),
    );
    expect(inventory.listItems('Eligibility race')[0]).toMatchObject({ borrowed: 1 });
    expect(inventory.listLoans()).toMatchObject([{ checkoutId: checkout, outstanding: 1 }]);
    expect(
      db
        .prepare('SELECT COUNT(*) count FROM inventory_command_receipts WHERE key=?')
        .get(command.key),
    ).toEqual({ count: 0 });
    expect(db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get()).toEqual({
      revision: revisionBeforeDelete,
    });
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual({
      count: eventCountBeforeDelete,
    });
    expect(
      db.prepare('SELECT enabled FROM inventory_replacement_guard WHERE singleton=1').get(),
    ).toEqual({ enabled: 0 });
    db.close();
  });

  it.each(['damaged', 'lost'] as const)(
    'blocks item deletion with %s balances without partial writes',
    (blocker) => {
      const { db, inventory } = setup();
      const item = inventory.createItem({ name: `${blocker} blocker`, kind: 'non_consumable' });
      const borrower = inventory.createBorrower({
        username: `${blocker}-blocker`,
        name: 'Blocker',
        type: 'individual',
      });
      inventory.addStock(item.id, 2);
      const checkout = inventory.checkout(item.id, borrower.id, 1);
      if (blocker === 'damaged') inventory.returnCheckout(checkout, 0, 1);
      else inventory.markLost(checkout, 1, true);

      const preview = inventory.listItems(`${blocker} blocker`)[0]!;
      const revisionBefore = db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get();
      const eventsBefore = db.prepare('SELECT COUNT(*) count FROM inventory_events').get();
      const command = {
        key: `delete-item-${blocker}-blocked`,
        ledgerEpoch: inventory.inventoryEpoch(),
        itemId: item.id,
        expectedStockRevision: preview.stockRevision,
        expectedCode: preview.code,
        expectedName: preview.name,
        expectedLocationId: preview.locationId,
      };

      expect(() => inventory.deleteItemCommand(command)).toThrow(
        expect.objectContaining({ code: 'deletion_ineligible' }),
      );
      expect(inventory.listItems(`${blocker} blocker`)[0]).toMatchObject({
        id: item.id,
        [blocker]: 1,
      });
      expect(db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get()).toEqual(
        revisionBefore,
      );
      expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual(eventsBefore);
      expect(
        db
          .prepare('SELECT COUNT(*) count FROM inventory_command_receipts WHERE key=?')
          .get(command.key),
      ).toEqual({ count: 0 });
      db.close();
    },
  );

  it('deletes a settled borrower history while preserving stock and identity on username reuse', () => {
    const { db, inventory } = setup();
    const item = inventory.createItem({ name: 'Surviving stock', kind: 'non_consumable' });
    const borrower = inventory.createBorrower({
      username: 'reusable-user',
      name: 'Old Name',
      type: 'individual',
    });
    inventory.addStock(item.id, 5);
    const checkout = inventory.checkout(item.id, borrower.id, 2);
    inventory.returnCheckout(checkout, 2, 0);
    const balanceBefore = inventory.listItems('Surviving stock')[0]!;
    const status = inventory.borrowerDeletionStatus(borrower.id);
    expect(status).toMatchObject({ outstanding: 0, lost: 0 });
    const command = {
      key: 'delete-borrower-0001',
      ledgerEpoch: inventory.inventoryEpoch(),
      borrowerId: borrower.id,
      expectedStateRevision: status.stateRevision,
      expectedOutstanding: status.outstanding,
      expectedLost: status.lost,
      expectedName: status.borrower.name,
      expectedUsername: status.borrower.username,
    };

    const committed = inventory.deleteBorrowerCommand(command);
    expect(committed).toEqual({
      outcome: 'committed',
      action: 'delete_borrower',
      borrowerId: borrower.id,
    });
    expect(inventory.deleteBorrowerCommand(command)).toEqual(committed);
    expect(inventory.listBorrowers('', true).some((entry) => entry.id === borrower.id)).toBe(false);
    expect(
      db
        .prepare('SELECT COUNT(*) count FROM inventory_events WHERE borrower_id=?')
        .get(borrower.id),
    ).toEqual({ count: 0 });
    expect(
      db.prepare('SELECT COUNT(*) count FROM loan_state WHERE borrower_id=?').get(borrower.id),
    ).toEqual({ count: 0 });
    expect(inventory.listItems('Surviving stock')[0]).toMatchObject({
      available: balanceBefore.available,
      borrowed: balanceBefore.borrowed,
      damaged: balanceBefore.damaged,
      lost: balanceBefore.lost,
    });

    const replacement = inventory.createBorrower({
      username: 'reusable-user',
      name: 'New Name',
      type: 'individual',
    });
    expect(replacement.id).toBeGreaterThan(borrower.id);
    expect(inventory.deleteBorrowerCommand(command)).toEqual(committed);
    expect(
      inventory.listBorrowers('', true).find((entry) => entry.username === 'reusable-user'),
    ).toMatchObject({
      id: replacement.id,
      name: 'New Name',
    });
    db.close();
  });

  it.each(['outstanding', 'lost'] as const)(
    'blocks borrower deletion with %s balances and leaves history untouched',
    (blocker) => {
      const { db, inventory } = setup();
      const item = inventory.createItem({ name: `${blocker} loan`, kind: 'non_consumable' });
      const borrower = inventory.createBorrower({
        username: `${blocker}-borrower`,
        name: 'Borrower blocker',
        type: 'individual',
      });
      inventory.addStock(item.id, 1);
      const checkout = inventory.checkout(item.id, borrower.id, 1);
      if (blocker === 'lost') inventory.markLost(checkout, 1, true);
      const status = inventory.borrowerDeletionStatus(borrower.id);
      const revisionBefore = db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get();
      const eventsBefore = db.prepare('SELECT COUNT(*) count FROM inventory_events').get();
      const command = {
        key: `delete-borrower-${blocker}-blocked`,
        ledgerEpoch: inventory.inventoryEpoch(),
        borrowerId: borrower.id,
        expectedStateRevision: status.stateRevision,
        expectedOutstanding: status.outstanding,
        expectedLost: status.lost,
        expectedName: status.borrower.name,
        expectedUsername: status.borrower.username,
      };

      expect(() => inventory.deleteBorrowerCommand(command)).toThrow(
        expect.objectContaining({ code: 'deletion_ineligible' }),
      );
      expect(inventory.listBorrowers('', true)).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: borrower.id })]),
      );
      expect(db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get()).toEqual(
        revisionBefore,
      );
      expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual(eventsBefore);
      expect(
        db
          .prepare('SELECT COUNT(*) count FROM inventory_command_receipts WHERE key=?')
          .get(command.key),
      ).toEqual({ count: 0 });
      db.close();
    },
  );

  it('rejects a borrower deletion after a stale zero-balance preview without partial writes', () => {
    const { db, inventory } = setup();
    const borrower = inventory.createBorrower({
      username: 'stale-preview-borrower',
      name: 'Stale Preview',
      type: 'individual',
    });
    const unrelated = inventory.createItem({ name: 'Unrelated state change', kind: 'consumable' });
    const status = inventory.borrowerDeletionStatus(borrower.id);
    inventory.addStock(unrelated.id, 1);
    const revisionBeforeDelete = db
      .prepare('SELECT revision FROM state_clock WHERE singleton=1')
      .get();
    const eventsBeforeDelete = db.prepare('SELECT COUNT(*) count FROM inventory_events').get();
    const command = {
      key: 'delete-borrower-stale-preview',
      ledgerEpoch: inventory.inventoryEpoch(),
      borrowerId: borrower.id,
      expectedStateRevision: status.stateRevision,
      expectedOutstanding: status.outstanding,
      expectedLost: status.lost,
      expectedName: status.borrower.name,
      expectedUsername: status.borrower.username,
    };

    expect(() => inventory.deleteBorrowerCommand(command)).toThrow(
      expect.objectContaining({ code: 'confirmation_changed' }),
    );
    expect(inventory.listBorrowers('', true)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: borrower.id })]),
    );
    expect(db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get()).toEqual(
      revisionBeforeDelete,
    );
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual(
      eventsBeforeDelete,
    );
    expect(
      db
        .prepare('SELECT COUNT(*) count FROM inventory_command_receipts WHERE key=?')
        .get(command.key),
    ).toEqual({ count: 0 });
    db.close();
  });

  it('moves active and archived location contents before deleting the location', () => {
    const { db, inventory } = setup();
    const source = inventory.createLocation('source', 'Source');
    const destination = inventory.createLocation('destination', 'Destination');
    const active = inventory.createItem({
      name: 'Active at source',
      kind: 'consumable',
      locationId: Number(source.id),
    });
    const archived = inventory.createItem({
      name: 'Archived at source',
      kind: 'consumable',
      locationId: Number(source.id),
    });
    inventory.addStock(active.id, 4);
    inventory.addStock(archived.id, 3);
    inventory.archiveItem(archived.id, true);
    const expectedItemIds = [active.id, archived.id].sort((left, right) => left - right);
    const eventCount = Number(
      (db.prepare('SELECT COUNT(*) count FROM inventory_events').get() as { count: number }).count,
    );
    const command = {
      key: 'delete-location-0001',
      ledgerEpoch: inventory.inventoryEpoch(),
      locationId: Number(source.id),
      action: 'delete' as const,
      replacementLocationId: Number(destination.id),
      expectedItemIds,
      expectedCode: source.code,
      expectedName: source.name,
    };

    expect(inventory.retireLocationCommand(command)).toEqual({
      action: 'delete',
      locationId: Number(source.id),
      movedItemIds: expectedItemIds,
    });
    expect(inventory.retireLocationCommand(command).movedItemIds).toEqual(expectedItemIds);
    expect(
      inventory.listLocations(true).some((location) => Number(location.id) === Number(source.id)),
    ).toBe(false);
    expect(inventory.listItems('', true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: active.id,
          locationId: Number(destination.id),
          available: 4,
        }),
        expect.objectContaining({
          id: archived.id,
          locationId: Number(destination.id),
          archived: true,
          available: 0,
        }),
      ]),
    );
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual({
      count: eventCount,
    });
    db.close();
  });

  it('rejects missing, unknown, self, and archived relocation destinations without changes', () => {
    const { db, inventory } = setup();
    const source = inventory.createLocation('source-invalid-destinations', 'Source');
    const archivedDestination = inventory.createLocation('archived-destination', 'Old store');
    inventory.updateLocation(Number(archivedDestination.id), {
      code: 'archived-destination',
      name: 'Old store',
      archived: true,
    });
    const item = inventory.createItem({
      name: 'Destination validation item',
      kind: 'consumable',
      locationId: Number(source.id),
    });
    const stateBefore = db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get();
    const expectedItemIds = [item.id];
    const cases = [
      { key: 'retire-destination-missing', destination: undefined, code: 'destination_required' },
      { key: 'retire-destination-unknown', destination: 99_999, code: 'invalid_location' },
      {
        key: 'retire-destination-self',
        destination: Number(source.id),
        code: 'invalid_destination',
      },
      {
        key: 'retire-destination-archived',
        destination: Number(archivedDestination.id),
        code: 'invalid_location',
      },
    ] as const;

    for (const testCase of cases) {
      const command = {
        key: testCase.key,
        ledgerEpoch: inventory.inventoryEpoch(),
        locationId: Number(source.id),
        action: 'delete' as const,
        expectedItemIds,
        expectedCode: source.code,
        expectedName: source.name,
        ...(testCase.destination === undefined
          ? {}
          : { replacementLocationId: testCase.destination }),
      };
      expect(() => inventory.retireLocationCommand(command)).toThrow(
        expect.objectContaining({ code: testCase.code }),
      );
    }

    expect(inventory.listItems('Destination validation item')[0]?.locationId).toBe(source.id);
    expect(
      inventory.listLocations(true).find((location) => location.id === source.id)?.archived,
    ).toBe(false);
    expect(db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get()).toEqual(
      stateBefore,
    );
    expect(
      db
        .prepare('SELECT COUNT(*) count FROM inventory_command_receipts WHERE key LIKE ?')
        .get('retire-destination-%'),
    ).toEqual({ count: 0 });
    db.close();
  });

  it('rejects deletion when previewed item, location, or borrower metadata changed', () => {
    const { db, inventory } = setup();
    const location = inventory.createLocation('metadata-source', 'Original location');
    const destination = inventory.createLocation('metadata-destination', 'Destination');
    const item = inventory.createItem({
      name: 'Original item',
      kind: 'consumable',
      locationId: Number(location.id),
    });
    const borrower = inventory.createBorrower({
      username: 'metadata-user',
      name: 'Original borrower',
      type: 'individual',
    });
    const itemPreview = inventory.listItems('Original item')[0]!;
    const borrowerPreview = inventory.borrowerDeletionStatus(borrower.id);
    inventory.saveInventoryItem({
      key: 'rename-before-delete',
      ledgerEpoch: inventory.inventoryEpoch(),
      itemId: item.id,
      name: 'Renamed item',
      aliases: [],
      lotSize: null,
      locationId: Number(location.id),
    });
    inventory.saveInventoryLocation({
      key: 'rename-location-before-delete',
      ledgerEpoch: inventory.inventoryEpoch(),
      locationId: Number(location.id),
      code: 'metadata-renamed',
      name: 'Renamed location',
    });
    inventory.updateBorrower(borrower.id, {
      username: 'renamed-user',
      name: 'Renamed borrower',
      type: 'individual',
    });

    const deleteItem = {
      key: 'delete-item-after-rename',
      ledgerEpoch: inventory.inventoryEpoch(),
      itemId: item.id,
      expectedStockRevision: itemPreview.stockRevision,
      expectedCode: itemPreview.code,
      expectedName: itemPreview.name,
      expectedLocationId: itemPreview.locationId,
    };
    expect(() => inventory.deleteItemCommand(deleteItem)).toThrow(
      expect.objectContaining({ code: 'confirmation_changed' }),
    );
    const retireLocation = {
      key: 'delete-location-after-rename',
      ledgerEpoch: inventory.inventoryEpoch(),
      locationId: Number(location.id),
      action: 'delete' as const,
      replacementLocationId: Number(destination.id),
      expectedItemIds: [item.id],
      expectedCode: 'metadata-source',
      expectedName: 'Original location',
    };
    expect(() => inventory.retireLocationCommand(retireLocation)).toThrow(
      expect.objectContaining({ code: 'confirmation_changed' }),
    );
    const deleteBorrower = {
      key: 'delete-borrower-after-rename',
      ledgerEpoch: inventory.inventoryEpoch(),
      borrowerId: borrower.id,
      expectedStateRevision: borrowerPreview.stateRevision,
      expectedOutstanding: 0,
      expectedLost: 0,
      expectedName: borrowerPreview.borrower.name,
      expectedUsername: borrowerPreview.borrower.username,
    };
    expect(() => inventory.deleteBorrowerCommand(deleteBorrower)).toThrow(
      expect.objectContaining({ code: 'confirmation_changed' }),
    );
    expect(inventory.listItems('Renamed item')).toHaveLength(1);
    expect(inventory.listLocations(true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: location.id, name: 'Renamed location' }),
      ]),
    );
    expect(inventory.listBorrowers('', true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: borrower.id, name: 'Renamed borrower' }),
      ]),
    );
    for (const key of [deleteItem.key, retireLocation.key, deleteBorrower.key])
      expect(
        db.prepare('SELECT COUNT(*) count FROM inventory_command_receipts WHERE key=?').get(key),
      ).toEqual({ count: 0 });
    db.close();
  });

  it('rolls back location relocation when source deletion fails mid-transaction', () => {
    const { db, inventory } = setup();
    const source = inventory.createLocation('rollback-source', 'Source');
    const destination = inventory.createLocation('rollback-destination', 'Destination');
    const active = inventory.createItem({
      name: 'Active rollback item',
      kind: 'consumable',
      locationId: Number(source.id),
    });
    const archived = inventory.createItem({
      name: 'Archived rollback item',
      kind: 'consumable',
      locationId: Number(source.id),
    });
    inventory.addStock(active.id, 3);
    inventory.archiveItem(archived.id, true);
    const highWaterBefore = db
      .prepare('SELECT result_json FROM inventory_command_receipts WHERE key=?')
      .get('system:identity-high-water');
    const revisionBefore = db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get();
    db.exec(
      `CREATE TRIGGER fail_source_location_delete
        BEFORE DELETE ON locations WHEN OLD.id=${Number(source.id)}
        BEGIN SELECT RAISE(ABORT, 'injected location deletion failure'); END;`,
    );

    const command = {
      key: 'retire-location-rollback-1',
      ledgerEpoch: inventory.inventoryEpoch(),
      locationId: Number(source.id),
      action: 'delete' as const,
      replacementLocationId: Number(destination.id),
      expectedItemIds: [active.id, archived.id].sort((left, right) => left - right),
      expectedCode: source.code,
      expectedName: source.name,
    };
    expect(() => inventory.retireLocationCommand(command)).toThrow(
      /injected location deletion failure/,
    );

    expect(inventory.listLocations(true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: source.id, archived: false }),
        expect.objectContaining({ id: destination.id, archived: false }),
      ]),
    );
    expect(inventory.listItems('', true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: active.id, locationId: source.id, available: 3 }),
        expect.objectContaining({ id: archived.id, locationId: source.id, archived: true }),
      ]),
    );
    expect(db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get()).toEqual(
      revisionBefore,
    );
    expect(
      db
        .prepare('SELECT result_json FROM inventory_command_receipts WHERE key=?')
        .get('system:identity-high-water'),
    ).toEqual(highWaterBefore);
    expect(
      db
        .prepare('SELECT COUNT(*) count FROM inventory_command_receipts WHERE key=?')
        .get(command.key),
    ).toEqual({ count: 0 });
    db.close();
  });
});
