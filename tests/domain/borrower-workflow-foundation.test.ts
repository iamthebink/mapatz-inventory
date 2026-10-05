import { normalizeBorrowerText } from '../../src/domain/borrower-profile.js';
import { foundReturned } from '../helpers/found-returned.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, transaction, type InventoryDatabase } from '../../src/db/database.js';
import { InventoryTransferService } from '../../src/domain/import-export.js';
import { InventoryService } from '../../src/domain/inventory.js';
function receipt(db: InventoryDatabase, key: string): void {
  db.prepare(
    `INSERT INTO idempotency_receipts(
      key,command_kind,ledger_epoch,contract_version,request_hash,outcome,subject_id,result_json
    ) VALUES (?,?,?,?,?,?,?,?)`,
  ).run(key, 'borrower_operation', 1, 1, 'hash', 'committed', 1, '{}');
}
function interleaveAfterRead(
  db: InventoryDatabase,
  matches: (sql: string) => boolean,
  interleave: () => void,
): InventoryDatabase {
  let triggered = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!matches(sql)) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              const value = Reflect.get(statementTarget, statementProperty, statementTarget);
              if (
                (statementProperty === 'get' || statementProperty === 'all') &&
                typeof value === 'function'
              )
                return (...parameters: unknown[]) => {
                  const result = value.apply(statementTarget, parameters);
                  if (!triggered) {
                    triggered = true;
                    interleave();
                  }
                  return result;
                };
              return typeof value === 'function' ? value.bind(statementTarget) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as InventoryDatabase;
}
describe('borrower workflow persistence foundation', () => {
  it('normalizes search centrally and separates deterministic exact archived matches', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const activeIdFirst = inventory.createBorrower({
      playaName: 'Ｔie',
      fullName: 'Same',
      phoneNumber: 'order',
      campDepartment: '',
    });
    const activeIdSecond = inventory.createBorrower({
      playaName: 'Tie',
      fullName: 'Same',
      phoneNumber: 'order',
      campDepartment: 'מחנה אחר',
    });
    const activePlayaNameSecond = inventory.createBorrower({
      playaName: 'z-user',
      fullName: 'Ａlpha',
      phoneNumber: 'order',
      campDepartment: '',
    });
    const activePlayaNameFirst = inventory.createBorrower({
      playaName: 'a-user',
      fullName: 'Alpha',
      phoneNumber: 'order',
      campDepartment: 'מחנה אחר',
    });
    const archivedByName = inventory.createBorrower({
      playaName: 'retired-name',
      fullName: '  Alice  ',
      campDepartment: 'מחנה אחר',
    });
    const archivedByPhoneNumber = inventory.createBorrower({
      playaName: 'retired-phoneNumber',
      fullName: 'Yankee',
      phoneNumber: '  Alice  ',
      campDepartment: 'מחנה אחר',
    });
    const archivedByPlayaName = inventory.createBorrower({
      playaName: 'ＡLICE',
      fullName: 'Zulu',
      phoneNumber: 'alice',
      campDepartment: '',
    });
    const archivedSubstring = inventory.createBorrower({
      playaName: 'alice-old',
      fullName: 'Substring Only',
      campDepartment: 'מחנה אחר',
    });
    for (const borrower of [
      archivedByName,
      archivedByPhoneNumber,
      archivedByPlayaName,
      archivedSubstring,
    ])
      inventory.archiveBorrower(borrower.id, true);
    expect(normalizeBorrowerText('  ＡLICE\t Able  ')).toBe('alice able');
    expect(inventory.searchBorrowers('order').active).toEqual([
      activePlayaNameFirst,
      activePlayaNameSecond,
      activeIdFirst,
      activeIdSecond,
    ]);
    expect(inventory.searchBorrowers(' alice ')).toEqual({
      ledgerEpoch: 1,
      active: [],
      archivedMatches: [
        { borrower: { ...archivedByPlayaName, archived: true }, matchedBy: 'playa_name' },
        { borrower: { ...archivedByPhoneNumber, archived: true }, matchedBy: 'phone_number' },
        { borrower: { ...archivedByName, archived: true }, matchedBy: 'full_name' },
      ],
    });
    expect(inventory.searchBorrowers('')).toEqual({
      ledgerEpoch: 1,
      active: [activePlayaNameFirst, activePlayaNameSecond, activeIdFirst, activeIdSecond],
      archivedMatches: [],
    });
    expect(db.isTransaction).toBe(false);
    db.close();
  });
  it('keeps search epoch and borrower rows on one generation when a writer commits between reads', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-search-snapshot-'));
    const filename = join(directory, 'inventory.sqlite');
    const reader = openDatabase(filename);
    const writer = openDatabase(filename);
    const original = new InventoryService(reader).createBorrower({
      playaName: 'old-match',
      fullName: 'Old Match',
      campDepartment: '',
    });
    const interleaved = interleaveAfterRead(
      reader,
      (sql) => sql.includes('SELECT ledger_epoch FROM inventory_replacement_guard'),
      () =>
        transaction(writer, () => {
          writer
            .prepare(
              'UPDATE inventory_replacement_guard SET ledger_epoch=ledger_epoch+1 WHERE singleton=1',
            )
            .run();
          writer.prepare('UPDATE borrowers SET archived=1 WHERE id=?').run(original.id);
          writer
            .prepare('INSERT INTO borrowers(playa_name,full_name,camp_department) VALUES (?,?,?)')
            .run('new-match', 'New Match', 'individual');
        }),
    );
    const snapshot = new InventoryService(interleaved).searchBorrowers('match');
    expect(snapshot).toEqual({ ledgerEpoch: 1, active: [original], archivedMatches: [] });
    expect(writer.prepare('SELECT ledger_epoch FROM inventory_replacement_guard').get()).toEqual({
      ledger_epoch: 2,
    });
    expect(new InventoryService(writer).searchBorrowers('match').active).toEqual([
      expect.objectContaining({ playaName: 'new-match' }),
    ]);
    expect(reader.isTransaction).toBe(false);
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it('keeps desk identity, balances, watermark, and epoch on one generation across replacement', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-desk-snapshot-'));
    const filename = join(directory, 'inventory.sqlite');
    const reader = openDatabase(filename);
    const writer = openDatabase(filename);
    const setup = new InventoryService(reader);
    const borrower = setup.createBorrower({
      playaName: 'old-borrower',
      fullName: 'Old Borrower',
      campDepartment: '',
    });
    const item = setup.createItem({
      name: 'Old Item',
      kind: 'non_consumable',
      locationId: Number(setup.listLocations()[0]!.id),
    });
    setup.addStock(item.id, 2, '', Number(setup.listLocations()[0]!.id));
    setup.checkout(item.id, borrower.id, 1, '', Number(setup.listLocations()[0]!.id));
    const interleaved = interleaveAfterRead(
      reader,
      (sql) => sql.includes('SELECT * FROM borrowers WHERE id=?'),
      () =>
        new InventoryTransferService(writer).replaceWithReset({
          locations: [{ name: 'Main', archived: false, isDefault: false }],
          items: [
            {
              name: 'Replacement Item',
              kind: 'non_consumable',
              location: 'Main',
              aliases: [],
              lotSize: null,
              archived: false,
              total: 5,
            },
          ],
        }),
    );
    const snapshot = new InventoryService(interleaved).getBorrowerDeskSnapshot(borrower.id);
    expect(snapshot).toMatchObject({
      borrower,
      inventory: [expect.objectContaining({ id: item.id, available: 1 })],
      holdings: [{ itemId: item.id, returnable: 1, lost: 0 }],
      stateRevision: 2,
      ledgerEpoch: 1,
      locations: expect.arrayContaining([
        expect.objectContaining({ id: 1, code: 'monster', isDefault: false }),
      ]),
      defaultLocationId: null,
    });
    expect(writer.prepare('SELECT ledger_epoch FROM inventory_replacement_guard').get()).toEqual({
      ledger_epoch: 2,
    });
    expect(new InventoryService(writer).listItems('', true)).toEqual([
      expect.objectContaining({ available: 5 }),
    ]);
    expect(reader.isTransaction).toBe(false);
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it('assembles one name-ordered desk snapshot with returnable, lost-only, and archived truth', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const borrower = inventory.createBorrower({
      playaName: 'desk',
      fullName: 'Desk Borrower',
      campDepartment: '',
    });
    const other = inventory.createBorrower({
      playaName: 'other',
      fullName: 'Other',
      campDepartment: 'מחנה אחר',
    });
    const first = inventory.createItem({
      name: 'First',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    const lostOnly = inventory.createItem({
      name: 'Lost only',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    const returned = inventory.createItem({
      name: 'Returned',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    const consumable = inventory.createItem({
      name: 'Consumable',
      kind: 'consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    const camp = inventory.createItem({
      name: 'Excluded camp item',
      kind: 'camp_equipment',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    for (const item of [first, lostOnly, returned])
      inventory.addStock(
        item.id,
        10,
        '',
        Number(
          (inventory.listLocations().find((l) => l.code === 'monster') ??
            inventory.listLocations()[0])!.id,
        ),
      );
    const firstCheckout = inventory.checkout(
      first.id,
      borrower.id,
      5,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.returnCheckout(
      firstCheckout,
      1,
      1,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.markLost(firstCheckout, 2, true);
    foundReturned(inventory, firstCheckout, 1);
    const secondFirstCheckout = inventory.checkout(
      first.id,
      borrower.id,
      3,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.returnCheckout(
      secondFirstCheckout,
      1,
      0,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.markLost(secondFirstCheckout, 1, true);
    const lostCheckout = inventory.checkout(
      lostOnly.id,
      borrower.id,
      2,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.markLost(lostCheckout, 2, true);
    const returnedCheckout = inventory.checkout(
      returned.id,
      borrower.id,
      1,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.returnCheckout(
      returnedCheckout,
      1,
      0,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.checkout(
      first.id,
      other.id,
      1,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    db.prepare('UPDATE items SET archived=1 WHERE id=?').run(lostOnly.id);
    const unrelated = inventory.createItem({
      name: 'Watermark',
      kind: 'consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    const watermark = inventory.addStock(
      unrelated.id,
      1,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const snapshot = inventory.getBorrowerDeskSnapshot(borrower.id);
    expect(snapshot.borrower).toEqual(borrower);
    expect(
      snapshot.inventory.map(({ id, kind, selectable }) => ({ id, kind, selectable })),
    ).toEqual([
      { id: consumable.id, kind: 'consumable', selectable: true },
      { id: camp.id, kind: 'camp_equipment', selectable: false },
      { id: first.id, kind: 'non_consumable', selectable: true },
      { id: lostOnly.id, kind: 'non_consumable', selectable: false },
      { id: returned.id, kind: 'non_consumable', selectable: true },
      { id: unrelated.id, kind: 'consumable', selectable: true },
    ]);
    expect(snapshot.holdings).toEqual([
      { itemId: first.id, returnable: 2, lost: 2 },
      { itemId: lostOnly.id, returnable: 0, lost: 2 },
    ]);
    expect(snapshot.inventory.find((item) => item.id === first.id)).toMatchObject({ damaged: 1 });
    expect(snapshot.stateRevision).toBe(watermark);
    expect(snapshot.ledgerEpoch).toBe(1);
    expect(db.isTransaction).toBe(false);
    expect(() => inventory.getBorrowerDeskSnapshot(999999)).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
    inventory.archiveBorrower(borrower.id, false);
    db.prepare('UPDATE borrowers SET archived=1 WHERE id=?').run(borrower.id);
    expect(() => inventory.getBorrowerDeskSnapshot(borrower.id)).toThrow(
      expect.objectContaining({ code: 'inactive_borrower' }),
    );
    expect(db.isTransaction).toBe(false);
    db.close();
  });
  it('enforces receipt command and outcome checks', () => {
    const db = openDatabase(':memory:');
    receipt(db, 'valid');
    expect(() =>
      db
        .prepare(
          `INSERT INTO idempotency_receipts(
            key,command_kind,ledger_epoch,contract_version,request_hash,outcome
          ) VALUES ('bad-kind','batch',1,1,'hash','committed')`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO idempotency_receipts(
            key,command_kind,ledger_epoch,contract_version,request_hash,outcome
          ) VALUES ('bad-outcome','borrower_create',1,1,'hash','pending')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });
  it('refuses replacement when the ledger-epoch singleton is missing', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const item = inventory.createItem({
      name: 'Preserved',
      kind: 'consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      item.id,
      2,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    db.prepare('DELETE FROM inventory_replacement_guard').run();
    expect(() =>
      new InventoryTransferService(db).replaceWithReset({
        locations: [{ name: 'Main', archived: false, isDefault: false }],
        items: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'internal_error' }));
    expect(inventory.listItems('', true)).toEqual([expect.objectContaining({ available: 2 })]);
    expect(db.isTransaction).toBe(false);
    db.close();
  });
});
