import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type InventoryDatabase } from '../../src/db/database.js';
import { InventoryService } from '../../src/domain/inventory.js';
import { InventoryTransferService } from '../../src/domain/import-export.js';
import {
  exportWorkbook,
  parseRecoveryWorkbook,
  parseResetWorkbook,
} from '../../src/io/workbook.js';
const databases: InventoryDatabase[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture(path = ':memory:', kind: 'non_consumable' | 'consumable' = 'non_consumable') {
  const db = openDatabase(path);
  databases.push(db);
  const service = new InventoryService(db);
  const a = service.createLocation('a', 'A');
  const b = service.createLocation('b', 'B');
  const item = service.createItem({ name: 'Shared', kind, locationId: a.id });
  service.addStock(item.id, 20, '', a.id);
  service.addStock(item.id, 30, '', b.id);
  const borrower = service.createBorrower({
    playaName: 'holder',
    fullName: 'Holder',
    campDepartment: '',
  });
  return { db, service, a, b, item, borrower };
}
function contents(service: InventoryService, locationId: number) {
  return service
    .listItems('', true)
    .filter((item) => item.balances.some((p) => p.locationId === locationId))
    .map((item) => {
      const p = item.balances.find((p) => p.locationId === locationId)!;
      return {
        itemId: item.id,
        available: p.available,
        damaged: p.damaged,
        stockRevision: item.stockRevision,
      };
    });
}
function failInsert(db: InventoryDatabase, sqlPattern: string): InventoryDatabase {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          if (sql.includes(sqlPattern)) throw new Error('injected write failure');
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
function operation(
  service: InventoryService,
  borrowerId: number,
  items: Parameters<InventoryService['commitBorrowerOperations']>[2]['items'],
) {
  return service.commitBorrowerOperations(borrowerId, randomUUID(), {
    contractVersion: 1,
    ledgerEpoch: service.inventoryEpoch(),
    items,
  });
}
describe('multi-location invariants', () => {
  it('cross-container return keeps loans item-wide and records both locations', () => {
    const { db, service, a, b, item, borrower } = fixture();
    const checkout = service.checkout(item.id, borrower.id, 5, '', a.id);
    const before = new InventoryTransferService(db).snapshot();
    expect(() => service.returnCheckout(checkout, 1, 0, '', 9999)).toThrow(
      expect.objectContaining({ code: 'invalid_location' }),
    );
    expect(new InventoryTransferService(db).snapshot()).toEqual(before);
    service.returnCheckout(checkout, 5, 0, '', b.id);
    expect(service.listItems()[0]!.balances).toEqual([
      { locationId: a.id, available: 15, damaged: 0 },
      { locationId: b.id, available: 35, damaged: 0 },
    ]);
    expect(service.getBorrowerDeskSnapshot(borrower.id).holdings).toEqual([]);
    expect(service.listLedger().slice(0, 2)).toMatchObject([
      { kind: 'returned_usable', location_name: 'B' },
      { kind: 'checked_out', location_name: 'A' },
    ]);
  });
  it('mixed save cannot use B returns to fund A and preserves balances, history and revision', () => {
    const { db, service, a, b, item, borrower } = fixture();
    service.checkout(item.id, borrower.id, 20, '', a.id);
    const before = new InventoryTransferService(db).snapshot();
    const key = randomUUID();
    const request = {
      contractVersion: 1 as const,
      ledgerEpoch: 1,
      items: [
        {
          itemId: item.id,
          return: [{ usable: 5, damaged: 0, note: '', locationId: b.id }],
          borrow: [{ quantity: 5, note: '', locationId: a.id }],
        },
      ],
    };
    expect(service.commitBorrowerOperations(borrower.id, key, request)).toMatchObject({
      outcome: 'rejected',
      conflicts: [{ scope: 'borrow', locationId: a.id, availableAfterUsableReturns: 0 }],
    });
    expect(new InventoryTransferService(db).snapshot()).toEqual(before);
    expect(db.prepare('SELECT outcome FROM idempotency_receipts WHERE key=?').get(key)).toEqual({
      outcome: 'rejected',
    });
    request.items[0]!.return[0]!.locationId = a.id;
    expect(service.commitBorrowerOperations(borrower.id, randomUUID(), request)).toMatchObject({
      outcome: 'committed',
    });
  });
  it('returns and lost recovery create a previously unused active destination', () => {
    const { service, a, item, borrower } = fixture();
    const c = service.createLocation('c', 'C');
    const loan = service.checkout(item.id, borrower.id, 3, '', a.id);
    service.markLost(loan, 1, true);
    expect(
      operation(service, borrower.id, [
        {
          itemId: item.id,
          return: [{ usable: 1, damaged: 1, note: '', locationId: c.id }],
          lostCredit: [{ quantity: 1, condition: 'usable', note: '', locationId: c.id }],
        },
      ]),
    ).toMatchObject({ outcome: 'committed' });
    expect(service.listItems()[0]!.balances).toContainEqual({
      locationId: c.id,
      available: 2,
      damaged: 1,
    });
    expect(service.getBorrowerDeskSnapshot(borrower.id).holdings).toEqual([]);
  });
  it('administrative transfer conserves totals, repair is local, and stale commands fail', () => {
    const { service, a, b, item, borrower } = fixture();
    const loan = service.checkout(item.id, borrower.id, 4, '', a.id);
    service.returnCheckout(loan, 0, 4, '', a.id);
    const revision = service.listItems()[0]!.stockRevision;
    const command = {
      key: 'transfer-damaged',
      ledgerEpoch: 1,
      itemId: item.id,
      sourceLocationId: a.id,
      destinationLocationId: b.id,
      quantity: 3,
      condition: 'damaged' as const,
      stockRevision: revision,
      note: '',
    };
    const first = service.transferStockCommand(command);
    expect(service.transferStockCommand(command)).toEqual(first);
    expect(first).toMatchObject({ available: 46, damaged: 4 });
    expect(() => service.transferStockCommand({ ...command, key: 'stale-transfer' })).toThrow(
      expect.objectContaining({ code: 'stale_stock' }),
    );
    expect(() =>
      service.resolveDamageCommand({
        key: 'repair-too-many',
        ledgerEpoch: 1,
        itemId: item.id,
        locationId: a.id,
        quantity: 2,
        repaired: true,
        note: '',
        stockRevision: first.stockRevision,
      }),
    ).toThrow(expect.objectContaining({ code: 'excessive_quantity' }));
    service.resolveDamageCommand({
      key: 'repair-b',
      ledgerEpoch: 1,
      itemId: item.id,
      locationId: b.id,
      quantity: 2,
      repaired: true,
      note: '',
      stockRevision: first.stockRevision,
    });
    expect(service.listItems()[0]!.balances).toEqual([
      { locationId: a.id, available: 16, damaged: 1 },
      { locationId: b.id, available: 32, damaged: 1 },
    ]);
    expect(() =>
      service.transferStockCommand({ ...command, key: 'system:identity-high-water' }),
    ).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));
  });
  it.each(['transfer', 'retirement'] as const)(
    'rolls back %s after a destination write fails',
    (action) => {
      const { db, service, a, b, item } = fixture();
      const before = new InventoryTransferService(db).snapshot();
      // Fail the second event after the source movement has already changed its balance and clock.
      let inserts = 0;
      const failing = new Proxy(db, {
        get(target, property) {
          if (property === 'prepare')
            return (sql: string) => {
              if (sql.includes('INSERT INTO inventory_events') && ++inserts === 2)
                throw new Error('injected write failure');
              return target.prepare(sql);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const broken = new InventoryService(failing);
      expect(() =>
        action === 'transfer'
          ? broken.transferStockCommand({
              key: 'rollback-transfer',
              ledgerEpoch: 1,
              itemId: item.id,
              sourceLocationId: a.id,
              destinationLocationId: b.id,
              quantity: 5,
              condition: 'usable',
              stockRevision: service.listItems()[0]!.stockRevision,
              note: '',
            })
          : broken.retireLocationCommand({
              key: 'rollback-retirement',
              ledgerEpoch: 1,
              locationId: a.id,
              action: 'delete',
              replacementLocationId: b.id,
              expectedCode: a.code,
              expectedName: a.name,
              expectedItemIds: [item.id],
              expectedBalances: contents(service, a.id),
            }),
      ).toThrow('injected write failure');
      expect(new InventoryTransferService(db).snapshot()).toEqual(before);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) count FROM inventory_command_receipts WHERE key LIKE 'rollback-%'",
          )
          .get(),
      ).toEqual({ count: 0 });
    },
  );
  it('retirement merges local contents, invalidates changed confirmation, clears default and preserves deleted attribution', () => {
    const { service, a, b, item } = fixture();
    service.saveInventoryLocation({
      key: 'default-a',
      ledgerEpoch: 1,
      locationId: a.id,
      code: a.code,
      name: a.name,
      isDefault: true,
    });
    const command = {
      key: 'retire-a',
      ledgerEpoch: 1,
      locationId: a.id,
      action: 'delete' as const,
      replacementLocationId: b.id,
      expectedCode: a.code,
      expectedName: a.name,
      expectedItemIds: [item.id],
      expectedBalances: contents(service, a.id),
    };
    service.addStock(item.id, 1, '', a.id);
    expect(() => service.retireLocationCommand(command)).toThrow(
      expect.objectContaining({ code: 'confirmation_changed' }),
    );
    service.retireLocationCommand({ ...command, expectedBalances: contents(service, a.id) });
    expect(service.listItems()[0]!.balances).toEqual([
      { locationId: b.id, available: 51, damaged: 0 },
    ]);
    expect(service.defaultLocationId()).toBeNull();
    expect(service.listLedger()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'transferred_out',
          location_name: 'A',
          location_code: 'a',
        }),
      ]),
    );
  });
  it('consumable shortage is local and frozen replay preserves selected source exactly once', () => {
    const { db, service, a, b, item } = fixture(':memory:', 'consumable');
    const before = new InventoryTransferService(db).snapshot();
    expect(
      service.issueBatch({
        key: 'shortage',
        ledgerEpoch: 1,
        items: [{ itemId: item.id, locationId: a.id, quantity: 21, note: '' }],
      }),
    ).toMatchObject({ outcome: 'rejected', conflicts: [{ locationId: a.id, available: 20 }] });
    expect(new InventoryTransferService(db).snapshot()).toEqual(before);
    const command = {
      key: 'issue-b',
      ledgerEpoch: 1,
      items: [{ itemId: item.id, locationId: b.id, quantity: 3, note: '' }],
    };
    const result = service.issueBatch(command);
    expect(service.issueBatch(command)).toMatchObject({ ...result, replayed: true });
    expect(service.listItems()[0]!.balances).toEqual([
      { locationId: a.id, available: 20, damaged: 0 },
      { locationId: b.id, available: 27, damaged: 0 },
    ]);
  });
  it('workbook groups balances, restores exact state, allocates borrowed/lost once, and rejects inconsistent repeated metadata atomically', async () => {
    const { db, service, a, b, item, borrower } = fixture();
    service.saveInventoryLocation({
      key: 'default-b',
      ledgerEpoch: 1,
      locationId: b.id,
      code: b.code,
      name: b.name,
      isDefault: true,
    });
    const loan = service.checkout(item.id, borrower.id, 5, '', a.id);
    service.markLost(loan, 2, true);
    const snapshot = new InventoryTransferService(db).snapshot();
    await expect(exportWorkbook(snapshot)).rejects.toThrow(/allocation destination/);
    const bytes = await exportWorkbook(snapshot, 'B');
    const reset = await parseResetWorkbook(bytes);
    expect(reset.items.map((row) => [row.location, row.total])).toEqual([
      ['A', 15],
      ['B', 35],
    ]);
    const recovery = await parseRecoveryWorkbook(bytes);
    const target = openDatabase(':memory:');
    databases.push(target);
    const transfers = new InventoryTransferService(target);
    transfers.replaceWithRecovery(recovery);
    const recovered = new InventoryService(target);
    expect(recovered.listItems()).toHaveLength(1);
    expect(recovered.listItems()[0]).toMatchObject({ available: 45, borrowed: 3, lost: 2 });
    expect(recovered.defaultLocationId()).not.toBeNull();
    expect(transfers.snapshot().events.map((event) => [event.kind, event.locationName])).toEqual(
      snapshot.events.map((event) => [event.kind, event.locationName]),
    );
    const before = transfers.snapshot();
    const bad = {
      ...recovery,
      items: recovery.items.map((row, index) =>
        index === 1 ? { ...row, borrowed: row.borrowed + 1 } : row,
      ),
    };
    expect(() => transfers.replaceWithRecovery(bad)).toThrow(
      expect.objectContaining({ code: 'invalid_workbook' }),
    );
    expect(transfers.snapshot()).toEqual(before);
    expect(() =>
      new InventoryTransferService(
        failInsert(target, 'INSERT INTO item_location_balances'),
      ).replaceWithRecovery(recovery),
    ).toThrow('injected write failure');
    expect(transfers.snapshot()).toEqual(before);
  });
  it('eligibility after restart uses stored local balances with operational audit reads blocked', () => {
    const directory = mkdtempSync(join(tmpdir(), 'multi-location-'));
    const path = join(directory, 'inventory.sqlite');
    const { db, a, b, item, borrower } = fixture(path);
    db.close();
    databases.splice(databases.indexOf(db), 1);
    const reopened = openDatabase(path);
    databases.push(reopened);
    const guarded = new InventoryService(
      new Proxy(reopened, {
        get(target, property) {
          if (property === 'prepare')
            return (sql: string) => {
              if (/SELECT.*inventory_events/is.test(sql)) throw new Error('audit replay forbidden');
              return target.prepare(sql);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
    expect(
      operation(guarded, borrower.id, [
        { itemId: item.id, borrow: [{ quantity: 21, note: '', locationId: a.id }] },
      ]),
    ).toMatchObject({ outcome: 'rejected' });
    expect(
      operation(guarded, borrower.id, [
        { itemId: item.id, borrow: [{ quantity: 21, note: '', locationId: b.id }] },
      ]),
    ).toMatchObject({ outcome: 'committed' });
    reopened.close();
    databases.splice(databases.indexOf(reopened), 1);
    rmSync(directory, { recursive: true, force: true });
  });
  it('default checkbox replaces, unchecks and retires the nullable setting', () => {
    const { service, a, b } = fixture();
    const save = (key: string, location: typeof a, isDefault: boolean) =>
      service.saveInventoryLocation({
        key,
        ledgerEpoch: 1,
        locationId: location.id,
        code: location.code,
        name: location.name,
        isDefault,
      });
    expect(service.defaultLocationId()).toBeNull();
    save('choose-a', a, true);
    expect(service.defaultLocationId()).toBe(a.id);
    save('choose-b', b, true);
    expect(service.defaultLocationId()).toBe(b.id);
    save('uncheck-a', a, false);
    expect(service.defaultLocationId()).toBe(b.id);
    save('uncheck-b', b, false);
    expect(service.defaultLocationId()).toBeNull();
    const empty = service.createLocation('empty', 'Empty');
    save('choose-empty', empty, true);
    service.retireLocationCommand({
      key: 'archive-empty',
      ledgerEpoch: 1,
      locationId: empty.id,
      action: 'archive',
      expectedCode: empty.code,
      expectedName: empty.name,
      expectedItemIds: [],
      expectedBalances: [],
    });
    expect(service.defaultLocationId()).toBeNull();
  });
  it('reset grouping uses normalized identity and alias order while composite placement keys remain unambiguous', () => {
    const { db } = fixture();
    const transfer = new InventoryTransferService(db);
    const metadata = {
      kind: 'non_consumable' as const,
      aliases: ['One', 'Two'],
      lotSize: null,
      archived: false,
    };
    transfer.replaceWithReset({
      locations: [
        { name: 'C', archived: false, isDefault: false },
        { name: 'B:C', archived: false, isDefault: false },
      ],
      items: [
        { ...metadata, name: 'A:B', location: 'C', total: 1 },
        { ...metadata, name: 'A', location: 'B:C', total: 2 },
        { ...metadata, name: 'ＳＨＡＲＥＤ', location: 'C', total: 3 },
        { ...metadata, name: 'shared', location: 'B:C', aliases: ['Two', 'One'], total: 4 },
      ],
    });
    expect(new InventoryService(db).listItems()).toHaveLength(3);
    expect(
      new InventoryService(db).listItems().find((item) => item.name === 'ＳＨＡＲＥＤ'),
    ).toMatchObject({ available: 7 });
    const before = transfer.snapshot();
    expect(() =>
      transfer.replaceWithReset({
        locations: [{ name: 'C', archived: false, isDefault: false }],
        items: [
          { ...metadata, name: 'same', location: 'C', total: 1 },
          { ...metadata, name: 'Same', location: 'C', total: 2 },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_workbook' }));
    expect(transfer.snapshot()).toEqual(before);
  });
});
