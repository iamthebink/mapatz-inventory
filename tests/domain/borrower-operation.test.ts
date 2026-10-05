import { foundReturned } from '../helpers/found-returned.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { BorrowerOperationRequest } from '../../src/contracts/borrower-workflow.js';
import { openDatabase, type InventoryDatabase } from '../../src/db/database.js';
import { InventoryService } from '../../src/domain/inventory.js';
const databases: InventoryDatabase[] = [];
const key = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = openDatabase(':memory:');
  databases.push(db);
  const inventory = new InventoryService(db);
  const borrower = inventory.createBorrower({
    playaName: 'borrower',
    fullName: 'Borrower',
    campDepartment: '',
  });
  return { db, inventory, borrower };
}
function transactionCountingDatabase(db: InventoryDatabase) {
  let beginCount = 0;
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === 'exec')
        return (sql: string) => {
          if (sql.trim() === 'BEGIN IMMEDIATE') beginCount += 1;
          return target.exec(sql);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as InventoryDatabase;
  return { wrapped, beginCount: () => beginCount };
}
describe('atomic borrower commands', () => {
  it('commits mixed loans and anonymous issuance once, and rejects a stale mixed request atomically', () => {
    const { db, inventory, borrower } = fixture();
    const pliers = inventory.createItem({
      name: 'Pliers',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    const ties = inventory.createItem({
      name: 'Zip ties',
      kind: 'consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      pliers.id,
      2,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.addStock(
      ties.id,
      4,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const body: BorrowerOperationRequest = {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [
        { itemId: pliers.id, borrow: [{ quantity: 1, note: 'tool', locationId: 1 }] },
        { itemId: ties.id, issue: [{ quantity: 3, note: 'supplies', locationId: 1 }] },
      ],
    };
    const committed = inventory.commitBorrowerOperations(borrower.id, key(910), body);
    expect(committed).toMatchObject({ outcome: 'committed', replayed: false });
    expect(inventory.commitBorrowerOperations(borrower.id, key(910), body)).toMatchObject({
      outcome: 'committed',
      replayed: true,
    });
    expect(
      db
        .prepare(
          "SELECT borrower_id borrowerId, related_event_id checkoutId, note FROM inventory_events WHERE kind='issued'",
        )
        .all(),
    ).toEqual([{ borrowerId: null, checkoutId: null, note: 'supplies' }]);
    expect(inventory.getBorrowerDeskSnapshot(borrower.id).holdings).toEqual([
      { itemId: pliers.id, returnable: 1, lost: 0 },
    ]);
    const rejected = inventory.commitBorrowerOperations(borrower.id, key(911), {
      ...body,
      items: [
        body.items[0]!,
        { itemId: ties.id, issue: [{ quantity: 2, note: 'too many', locationId: 1 }] },
      ],
    });
    expect(rejected).toMatchObject({
      outcome: 'rejected',
      conflicts: [{ scope: 'issue', locationId: 1, itemId: ties.id, available: 1 }],
    });
    expect(
      db.prepare("SELECT COUNT(*) count FROM inventory_events WHERE kind='checked_out'").get(),
    ).toEqual({ count: 1 });
  });
  it('rejects issuance when a companion return is invalid or the consumable was archived', () => {
    const { db, inventory, borrower } = fixture();
    const tool = inventory.createItem({
      name: 'Tool',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    const tape = inventory.createItem({
      name: 'Tape',
      kind: 'consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      tape.id,
      3,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const invalidReturn: BorrowerOperationRequest = {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [
        { itemId: tool.id, return: [{ usable: 1, damaged: 0, note: '', locationId: 1 }] },
        { itemId: tape.id, issue: [{ quantity: 1, note: '', locationId: 1 }] },
      ],
    };
    expect(inventory.commitBorrowerOperations(borrower.id, key(912), invalidReturn)).toMatchObject({
      outcome: 'rejected',
      conflicts: [{ scope: 'return', itemId: tool.id }],
    });
    inventory.archiveItem(tape.id, true);
    expect(
      inventory.commitBorrowerOperations(borrower.id, key(913), {
        ...invalidReturn,
        items: [{ itemId: tape.id, issue: [{ quantity: 1, note: '', locationId: 1 }] }],
      }),
    ).toMatchObject({
      outcome: 'rejected',
      conflicts: [{ scope: 'item', code: 'item_archived', itemId: tape.id }],
    });
    expect(
      db.prepare("SELECT COUNT(*) count FROM inventory_events WHERE kind='issued'").get(),
    ).toEqual({ count: 0 });
  });
  it('allocates returns, staged loss, dependent recovery, and borrow atomically in ledger order', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'Mixed equipment',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      item.id,
      5,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const checkoutId = inventory.checkout(
      item.id,
      borrower.id,
      4,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const request: BorrowerOperationRequest = {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [
        {
          itemId: item.id,
          return: [{ usable: 1, damaged: 0, note: 'returned', locationId: 1 }],
          lost: [{ quantity: 2, note: 'missing' }],
          lostCredit: [{ quantity: 2, condition: 'usable', note: 'found again', locationId: 1 }],
          borrow: [{ quantity: 2, note: 'replacement', locationId: 1 }],
        },
      ],
    };
    expect(inventory.commitBorrowerOperations(borrower.id, key(17), request)).toEqual({
      outcome: 'committed',
      idempotencyKey: key(17),
      replayed: false,
    });
    expect(
      db
        .prepare(
          'SELECT kind,quantity,related_event_id relatedId,note FROM inventory_events WHERE id>? ORDER BY id',
        )
        .all(checkoutId),
    ).toEqual([
      { kind: 'returned_usable', quantity: 1, relatedId: checkoutId, note: 'returned' },
      { kind: 'marked_lost', quantity: 2, relatedId: checkoutId, note: 'missing' },
      { kind: 'found_returned', quantity: 2, relatedId: checkoutId, note: 'found again' },
      { kind: 'checked_out', quantity: 2, relatedId: null, note: 'replacement' },
    ]);
    expect(inventory.getBorrowerDeskSnapshot(borrower.id)).toMatchObject({
      inventory: [expect.objectContaining({ id: item.id, available: 2, damaged: 0 })],
      holdings: [{ itemId: item.id, returnable: 3, lost: 0 }],
    });
    expect(inventory.commitBorrowerOperations(borrower.id, key(17), request)).toEqual({
      outcome: 'committed',
      idempotencyKey: key(17),
      replayed: true,
    });
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual({ count: 6 });
  });
  it('rejects combined return and loss beyond held balance without a partial write', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'Shared held balance',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      item.id,
      4,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.checkout(
      item.id,
      borrower.id,
      4,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const before = Number(
      (
        db.prepare('SELECT COUNT(*) count FROM inventory_events').get() as {
          count: number;
        }
      ).count,
    );
    expect(
      inventory.commitBorrowerOperations(borrower.id, key(16), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          {
            itemId: item.id,
            return: [{ usable: 3, damaged: 0, note: '', locationId: 1 }],
            lost: [{ quantity: 2, note: '' }],
          },
        ],
      }),
    ).toMatchObject({
      outcome: 'rejected',
      conflicts: [
        {
          scope: 'held',
          code: 'held_balance_changed',
          itemId: item.id,
          requested: 5,
          returnable: 4,
        },
      ],
    });
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual({
      count: before,
    });
  });
  it('allocates staged loss FIFO across checkouts while preserving each part note', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'FIFO losses',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      item.id,
      4,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const first = inventory.checkout(
      item.id,
      borrower.id,
      2,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const second = inventory.checkout(
      item.id,
      borrower.id,
      2,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    expect(
      inventory.commitBorrowerOperations(borrower.id, key(27), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          {
            itemId: item.id,
            lost: [
              { quantity: 3, note: 'north trail' },
              { quantity: 1, note: 'south trail' },
            ],
          },
        ],
      }),
    ).toMatchObject({ outcome: 'committed' });
    expect(
      db
        .prepare(
          "SELECT kind,quantity,related_event_id checkoutId,note FROM inventory_events WHERE kind='marked_lost' ORDER BY id",
        )
        .all(),
    ).toEqual([
      { kind: 'marked_lost', quantity: 2, checkoutId: first, note: 'north trail' },
      { kind: 'marked_lost', quantity: 1, checkoutId: second, note: 'north trail' },
      { kind: 'marked_lost', quantity: 1, checkoutId: second, note: 'south trail' },
    ]);
    expect(inventory.getBorrowerDeskSnapshot(borrower.id).holdings).toEqual([
      { itemId: item.id, returnable: 0, lost: 4 },
    ]);
  });
  it('credits checkout-linked lost equipment back to usable stock without marking more lost', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'Recovered',
      kind: 'non_consumable',
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
    const checkoutId = inventory.checkout(
      item.id,
      borrower.id,
      2,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const markedLostId = inventory.markLost(checkoutId, 2, true, 'admin loss');
    expect(
      inventory.commitBorrowerOperations(borrower.id, key(18), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          {
            itemId: item.id,
            lostCredit: [{ quantity: 1, condition: 'usable', note: 'found', locationId: 1 }],
          },
        ],
      }),
    ).toEqual({ outcome: 'committed', idempotencyKey: key(18), replayed: false });
    expect(
      db
        .prepare(
          `SELECT kind,quantity,related_event_id relatedId,note
           FROM inventory_events WHERE id>? ORDER BY id`,
        )
        .all(markedLostId),
    ).toEqual([{ kind: 'found_returned', quantity: 1, relatedId: checkoutId, note: 'found' }]);
    expect(inventory.getBorrowerDeskSnapshot(borrower.id)).toMatchObject({
      inventory: [expect.objectContaining({ id: item.id, available: 1 })],
      holdings: [{ itemId: item.id, returnable: 0, lost: 1 }],
    });
    expect(
      db.prepare("SELECT COUNT(*) count FROM inventory_events WHERE kind='marked_lost'").get(),
    ).toEqual({ count: 1 });
  });
  it('receives lost equipment as damaged without funding a borrow or changing held stock', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'Damaged recovery',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      item.id,
      4,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const checkoutId = inventory.checkout(
      item.id,
      borrower.id,
      4,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.markLost(checkoutId, 2, true);
    const request: BorrowerOperationRequest = {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [
        {
          itemId: item.id,
          lostCredit: [
            { quantity: 1, condition: 'damaged', note: 'broken on return', locationId: 1 },
          ],
        },
      ],
    };
    expect(inventory.commitBorrowerOperations(borrower.id, key(23), request)).toMatchObject({
      outcome: 'committed',
      replayed: false,
    });
    expect(
      db
        .prepare(
          "SELECT kind,quantity,related_event_id checkoutId,note FROM inventory_events WHERE kind='found_returned_damaged'",
        )
        .all(),
    ).toEqual([
      {
        kind: 'found_returned_damaged',
        quantity: 1,
        checkoutId,
        note: 'broken on return',
      },
    ]);
    const snapshot = inventory.getBorrowerDeskSnapshot(borrower.id);
    expect(snapshot.inventory).toEqual([
      expect.objectContaining({ id: item.id, available: 0, damaged: 1 }),
    ]);
    expect(snapshot.holdings).toEqual([{ itemId: item.id, returnable: 2, lost: 1 }]);
    expect(inventory.listLoans()).toMatchObject([{ checkoutId, outstanding: 2, lost: 1 }]);
    expect(inventory.commitBorrowerOperations(borrower.id, key(23), request)).toMatchObject({
      outcome: 'committed',
      replayed: true,
    });
    expect(
      db
        .prepare("SELECT COUNT(*) count FROM inventory_events WHERE kind='found_returned_damaged'")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      inventory.commitBorrowerOperations(borrower.id, key(24), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          {
            itemId: item.id,
            lostCredit: [
              { quantity: 1, condition: 'damaged', note: 'another broken return', locationId: 1 },
            ],
            borrow: [{ quantity: 1, note: 'cannot use damaged stock', locationId: 1 }],
          },
        ],
      }),
    ).toMatchObject({
      outcome: 'rejected',
      conflicts: [
        {
          scope: 'borrow',
          locationId: 1,
          code: 'insufficient_stock',
          availableAfterUsableReturns: 0,
        },
      ],
    });
  });
  it('allocates noted recovery parts across tied lost checkouts and replays without new writes', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'Multiple recoveries',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      item.id,
      5,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const first = inventory.checkout(
      item.id,
      borrower.id,
      2,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const second = inventory.checkout(
      item.id,
      borrower.id,
      3,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    db.prepare(
      "UPDATE loan_state SET created_at='2026-01-01 00:00:00' WHERE checkout_id IN (?,?)",
    ).run(first, second);
    inventory.markLost(first, 2, true);
    const lastLoss = inventory.markLost(second, 3, true);
    const request: BorrowerOperationRequest = {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [
        {
          itemId: item.id,
          lostCredit: [
            { quantity: 3, condition: 'usable', note: 'found near stage', locationId: 1 },
            { quantity: 1, condition: 'damaged', note: 'found in van', locationId: 1 },
          ],
        },
      ],
    };
    expect(inventory.commitBorrowerOperations(borrower.id, key(21), request)).toMatchObject({
      outcome: 'committed',
      replayed: false,
    });
    expect(
      db
        .prepare(
          'SELECT kind,quantity,related_event_id checkoutId,borrower_id borrowerId,note FROM inventory_events WHERE id>? ORDER BY id',
        )
        .all(lastLoss),
    ).toEqual([
      {
        kind: 'found_returned',
        quantity: 2,
        checkoutId: first,
        borrowerId: borrower.id,
        note: 'found near stage',
      },
      {
        kind: 'found_returned',
        quantity: 1,
        checkoutId: second,
        borrowerId: borrower.id,
        note: 'found near stage',
      },
      {
        kind: 'found_returned_damaged',
        quantity: 1,
        checkoutId: second,
        borrowerId: borrower.id,
        note: 'found in van',
      },
    ]);
    const ledger = inventory.listLedger();
    const snapshot = inventory.getBorrowerDeskSnapshot(borrower.id);
    expect(snapshot).toMatchObject({
      inventory: [expect.objectContaining({ id: item.id, available: 3, damaged: 1 })],
      holdings: [{ itemId: item.id, returnable: 0, lost: 1 }],
    });
    expect(inventory.commitBorrowerOperations(borrower.id, key(21), request)).toMatchObject({
      outcome: 'committed',
      replayed: true,
    });
    expect(inventory.listLedger()).toEqual(ledger);
    expect(inventory.getBorrowerDeskSnapshot(borrower.id)).toEqual(snapshot);
    expect(db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual({
      count: 1,
    });
  });
  it('rolls back found returns and their funded borrow when receipt insertion fails', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'Recovery rollback',
      kind: 'non_consumable',
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
    const checkout = inventory.checkout(
      item.id,
      borrower.id,
      2,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.markLost(checkout, 2, true);
    const before = {
      ledger: inventory.listLedger(),
      snapshot: inventory.getBorrowerDeskSnapshot(borrower.id),
      receipts: db.prepare('SELECT * FROM idempotency_receipts').all(),
    };
    db.exec(`CREATE TRIGGER reject_recovery_receipt BEFORE INSERT ON idempotency_receipts
      WHEN NEW.key='${key(22)}'
        AND EXISTS (SELECT 1 FROM inventory_events WHERE kind='found_returned' AND note='recovered before failure')
        AND EXISTS (SELECT 1 FROM inventory_events WHERE kind='checked_out' AND note='funded by recovery')
      BEGIN SELECT RAISE(ABORT, 'recovery receipt failure'); END`);
    expect(() =>
      inventory.commitBorrowerOperations(borrower.id, key(22), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          {
            itemId: item.id,
            lostCredit: [
              { quantity: 2, condition: 'usable', note: 'recovered before failure', locationId: 1 },
            ],
            borrow: [{ quantity: 1, note: 'funded by recovery', locationId: 1 }],
          },
        ],
      }),
    ).toThrow('recovery receipt failure');
    expect(inventory.listLedger()).toEqual(before.ledger);
    expect(inventory.getBorrowerDeskSnapshot(borrower.id)).toEqual(before.snapshot);
    expect(db.prepare('SELECT * FROM idempotency_receipts').all()).toEqual(before.receipts);
    expect(db.isTransaction).toBe(false);
  });
  it('rejects a stale lost credit atomically and preserves the staged command envelope', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'Stale recovery',
      kind: 'non_consumable',
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
    const checkoutId = inventory.checkout(
      item.id,
      borrower.id,
      2,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.markLost(checkoutId, 2, true);
    const request: BorrowerOperationRequest = {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [
        {
          itemId: item.id,
          lostCredit: [{ quantity: 2, condition: 'usable', note: 'stale', locationId: 1 }],
        },
      ],
    };
    foundReturned(inventory, checkoutId, 1);
    const before = db.prepare('SELECT COUNT(*) count FROM inventory_events').get();
    expect(inventory.commitBorrowerOperations(borrower.id, key(19), request)).toMatchObject({
      error: 'borrower_operation_conflict',
      conflicts: [
        {
          scope: 'lost-credit',
          code: 'lost_balance_changed',
          itemId: item.id,
          requested: 2,
          lost: 1,
        },
      ],
      snapshot: { holdings: [{ itemId: item.id, returnable: 0, lost: 1 }] },
    });
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual(before);
  });
  it('commits usable, damaged, lost-credit, and borrow parts in deterministic order', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'Mixed recovery',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      item.id,
      4,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const checkoutId = inventory.checkout(
      item.id,
      borrower.id,
      4,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const markedLostId = inventory.markLost(checkoutId, 1, true);
    expect(
      inventory.commitBorrowerOperations(borrower.id, key(20), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          {
            itemId: item.id,
            return: [
              { usable: 1, damaged: 0, note: 'usable', locationId: 1 },
              { usable: 0, damaged: 1, note: 'damaged', locationId: 1 },
            ],
            lostCredit: [{ quantity: 1, condition: 'usable', note: 'found', locationId: 1 }],
            borrow: [{ quantity: 2, note: 'again', locationId: 1 }],
          },
        ],
      }),
    ).toEqual({ outcome: 'committed', idempotencyKey: key(20), replayed: false });
    expect(
      db
        .prepare('SELECT kind,quantity,note FROM inventory_events WHERE id>? ORDER BY id')
        .all(markedLostId),
    ).toEqual([
      { kind: 'returned_usable', quantity: 1, note: 'usable' },
      { kind: 'returned_damaged', quantity: 1, note: 'damaged' },
      { kind: 'found_returned', quantity: 1, note: 'found' },
      { kind: 'checked_out', quantity: 2, note: 'again' },
    ]);
    expect(inventory.getBorrowerDeskSnapshot(borrower.id).holdings).toEqual([
      { itemId: item.id, returnable: 3, lost: 0 },
    ]);
  });
  it('opens exactly one write transaction for each public command', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'Counted',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      item.id,
      1,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const counted = transactionCountingDatabase(db);
    const commands = new InventoryService(counted.wrapped);
    commands.commitBorrowerOperations(borrower.id, key(12), {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [{ itemId: item.id, borrow: [{ quantity: 1, note: '', locationId: 1 }] }],
    });
    expect(counted.beginCount()).toBe(1);
    commands.createBorrowerCommand(key(13), {
      contractVersion: 1,
      ledgerEpoch: 1,
      playaName: 'counted-create',
      fullName: 'Counted Create',
      phoneNumber: '',
      campDepartment: '',
    });
    expect(counted.beginCount()).toBe(2);
  });
  it('allocates ordered return parts before ordered borrows without targeting new checkouts', () => {
    const { db, inventory, borrower } = fixture();
    const secondItem = inventory.createItem({
      name: 'Second',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    const firstItem = inventory.createItem({
      name: 'First',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      secondItem.id,
      10,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.addStock(
      firstItem.id,
      10,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const oldFirst = inventory.checkout(
      firstItem.id,
      borrower.id,
      1,
      'old-first',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const oldSecond = inventory.checkout(
      firstItem.id,
      borrower.id,
      4,
      'old-second',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const result = inventory.commitBorrowerOperations(borrower.id, key(1), {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [
        { itemId: secondItem.id, borrow: [{ quantity: 1, note: 'second-borrow', locationId: 1 }] },
        {
          itemId: firstItem.id,
          return: [
            { usable: 2, damaged: 1, note: 'part-a', locationId: 1 },
            { usable: 2, damaged: 0, note: 'part-b', locationId: 1 },
          ],
          borrow: [{ quantity: 2, note: 'first-borrow', locationId: 1 }],
        },
      ],
    });
    expect(result).toEqual({ outcome: 'committed', idempotencyKey: key(1), replayed: false });
    expect(
      db
        .prepare(
          `SELECT kind,item_id itemId,quantity,related_event_id relatedId,note
          FROM inventory_events WHERE id>? ORDER BY id`,
        )
        .all(oldSecond),
    ).toEqual([
      {
        kind: 'returned_usable',
        itemId: firstItem.id,
        quantity: 1,
        relatedId: oldFirst,
        note: 'part-a',
      },
      {
        kind: 'returned_usable',
        itemId: firstItem.id,
        quantity: 1,
        relatedId: oldSecond,
        note: 'part-a',
      },
      {
        kind: 'returned_damaged',
        itemId: firstItem.id,
        quantity: 1,
        relatedId: oldSecond,
        note: 'part-a',
      },
      {
        kind: 'returned_usable',
        itemId: firstItem.id,
        quantity: 2,
        relatedId: oldSecond,
        note: 'part-b',
      },
      {
        kind: 'checked_out',
        itemId: secondItem.id,
        quantity: 1,
        relatedId: null,
        note: 'second-borrow',
      },
      {
        kind: 'checked_out',
        itemId: firstItem.id,
        quantity: 2,
        relatedId: null,
        note: 'first-borrow',
      },
    ]);
    expect(db.prepare('SELECT outcome FROM idempotency_receipts').all()).toEqual([
      { outcome: 'committed' },
    ]);
  });
  it('breaks equal checkout timestamps by event ID and commits the complete result once', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'Tie breaker',
      kind: 'non_consumable',
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
    const first = inventory.checkout(
      item.id,
      borrower.id,
      1,
      'first',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const second = inventory.checkout(
      item.id,
      borrower.id,
      1,
      'second',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    db.prepare(
      "UPDATE loan_state SET created_at='2026-01-01 00:00:00' WHERE checkout_id IN (?,?)",
    ).run(first, second);
    expect(second).toBeGreaterThan(first);
    const beforeEvents = Number(
      (
        db.prepare('SELECT COUNT(*) count FROM inventory_events').get() as {
          count: number;
        }
      ).count,
    );
    expect(
      inventory.commitBorrowerOperations(borrower.id, key(16), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          { itemId: item.id, return: [{ usable: 1, damaged: 0, note: 'tie', locationId: 1 }] },
        ],
      }),
    ).toEqual({ outcome: 'committed', idempotencyKey: key(16), replayed: false });
    expect(
      db
        .prepare(
          `SELECT related_event_id relatedId,quantity,note FROM inventory_events
           WHERE kind='returned_usable'`,
        )
        .all(),
    ).toEqual([{ relatedId: first, quantity: 1, note: 'tie' }]);
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual({
      count: beforeEvents + 1,
    });
    expect(db.prepare('SELECT outcome FROM idempotency_receipts').all()).toEqual([
      { outcome: 'committed' },
    ]);
    expect(inventory.getBorrowerDeskSnapshot(borrower.id).holdings).toContainEqual({
      itemId: item.id,
      returnable: 1,
      lost: 0,
    });
  });
  it('does not count damaged returns as stock for a same-command borrow', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'Damaged only',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      item.id,
      1,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.checkout(
      item.id,
      borrower.id,
      1,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const beforeEvents = db.prepare('SELECT COUNT(*) count FROM inventory_events').get();
    expect(
      inventory.commitBorrowerOperations(borrower.id, key(17), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          {
            itemId: item.id,
            return: [{ usable: 0, damaged: 1, note: 'damaged', locationId: 1 }],
            borrow: [{ quantity: 1, note: 'must not be funded', locationId: 1 }],
          },
        ],
      }),
    ).toMatchObject({
      error: 'borrower_operation_conflict',
      conflicts: [
        {
          scope: 'borrow',
          locationId: 1,
          code: 'insufficient_stock',
          itemId: item.id,
          requested: 1,
          availableAfterUsableReturns: 0,
        },
      ],
    });
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual(beforeEvents);
    expect(db.prepare('SELECT outcome FROM idempotency_receipts').all()).toEqual([
      { outcome: 'rejected' },
    ]);
  });
  it('records ordered conflicts with direction precedence and revalidates rejected retries', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'Limited',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      item.id,
      1,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const checkout = inventory.checkout(
      item.id,
      borrower.id,
      1,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const request = {
      contractVersion: 1 as const,
      ledgerEpoch: 1,
      items: [
        {
          itemId: item.id,
          return: [{ usable: 2, damaged: 0, note: 'too many', locationId: 1 }],
          borrow: [{ quantity: 99, note: 'suppressed', locationId: 1 }],
        },
      ],
    };
    const counted = transactionCountingDatabase(db);
    const first = new InventoryService(counted.wrapped).commitBorrowerOperations(
      borrower.id,
      key(2),
      request,
    );
    expect(first).toMatchObject({
      error: 'borrower_operation_conflict',
      replayed: false,
      conflicts: [
        {
          scope: 'return',
          code: 'returnable_balance_changed',
          itemId: item.id,
          requested: 2,
          returnable: 1,
        },
      ],
      snapshot: { stateRevision: checkout, ledgerEpoch: 1 },
    });
    expect(counted.beginCount()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual({ count: 2 });
    const rejectedReceipt = db
      .prepare('SELECT * FROM idempotency_receipts WHERE key=?')
      .get(key(2));
    expect(rejectedReceipt).toMatchObject({
      request_hash: expect.any(String),
      outcome: 'rejected',
      result_json: null,
    });
    const unchangedReplay = inventory.commitBorrowerOperations(borrower.id, key(2), request);
    expect(unchangedReplay).toMatchObject({
      error: 'borrower_operation_attempt_rejected',
      replayed: true,
      currentValidation: {
        status: 'conflicted',
        snapshot: {
          stateRevision: checkout,
          holdings: [{ itemId: item.id, returnable: 1, lost: 0 }],
        },
      },
    });
    inventory.addStock(
      item.id,
      100,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const freshConflict = inventory.commitBorrowerOperations(borrower.id, key(2), request);
    expect(freshConflict).toMatchObject({
      currentValidation: {
        status: 'conflicted',
        snapshot: {
          stateRevision: checkout + 1,
          inventory: [expect.objectContaining({ id: item.id, available: 100 })],
          holdings: [{ itemId: item.id, returnable: 1, lost: 0 }],
        },
      },
    });
    inventory.checkout(
      item.id,
      borrower.id,
      1,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const replay = inventory.commitBorrowerOperations(borrower.id, key(2), request);
    expect(replay).toMatchObject({
      error: 'borrower_operation_attempt_rejected',
      replayed: true,
      currentValidation: {
        status: 'now_valid',
        conflicts: [],
        snapshot: {
          stateRevision: checkout + 2,
          inventory: [expect.objectContaining({ id: item.id, available: 99 })],
          holdings: [{ itemId: item.id, returnable: 2, lost: 0 }],
        },
      },
    });
    expect(db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual({
      count: 1,
    });
    expect(db.prepare('SELECT * FROM idempotency_receipts WHERE key=?').get(key(2))).toEqual(
      rejectedReceipt,
    );
  });
  it('orders item prerequisites and stock conflicts while inactive borrowers suppress item detail', () => {
    const { inventory, borrower } = fixture();
    const archived = inventory.createItem({
      name: 'Archived',
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
    const empty = inventory.createItem({
      name: 'Empty',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.archiveItem(archived.id, true);
    const request = {
      contractVersion: 1 as const,
      ledgerEpoch: 1,
      items: [
        { itemId: empty.id, borrow: [{ quantity: 1, note: '', locationId: 1 }] },
        { itemId: 999999, borrow: [{ quantity: 1, note: '', locationId: 1 }] },
        { itemId: archived.id, borrow: [{ quantity: 1, note: '', locationId: 1 }] },
        { itemId: consumable.id, borrow: [{ quantity: 1, note: '', locationId: 1 }] },
      ],
    };
    expect(inventory.commitBorrowerOperations(borrower.id, key(9), request)).toMatchObject({
      conflicts: [
        { scope: 'item', code: 'item_archived', itemId: archived.id },
        { scope: 'item', code: 'wrong_item_kind', itemId: consumable.id },
        { scope: 'borrow', locationId: 1, code: 'insufficient_stock', itemId: empty.id },
        { scope: 'item', code: 'item_not_found', itemId: 999999 },
      ],
    });
    inventory.archiveBorrower(borrower.id, true);
    expect(inventory.commitBorrowerOperations(borrower.id, key(10), request)).toMatchObject({
      conflicts: [{ scope: 'borrower', code: 'borrower_inactive', borrowerId: borrower.id }],
    });
  });
  it('replays committed operations and rejects changed identity without mutation', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'Stock',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    const otherItem = inventory.createItem({
      name: 'Other stock',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    const otherBorrower = inventory.createBorrower({
      playaName: 'other-subject',
      fullName: 'Other Subject',
      campDepartment: '',
    });
    inventory.addStock(
      item.id,
      3,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.addStock(
      otherItem.id,
      2,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const firstGroup = {
      itemId: item.id,
      borrow: [
        { quantity: 1, note: 'first', locationId: 1 },
        { quantity: 1, note: 'second', locationId: 1 },
      ],
    };
    const secondGroup = {
      itemId: otherItem.id,
      borrow: [{ quantity: 1, note: 'other-item', locationId: 1 }],
    };
    const request: BorrowerOperationRequest = {
      contractVersion: 1 as const,
      ledgerEpoch: 1,
      items: [firstGroup, secondGroup],
    };
    inventory.commitBorrowerOperations(borrower.id, key(3), request);
    const afterCommit = {
      borrowers: db.prepare('SELECT COUNT(*) count FROM borrowers').get(),
      events: db.prepare('SELECT COUNT(*) count FROM inventory_events').get(),
      receipts: db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get(),
    };
    expect(inventory.commitBorrowerOperations(borrower.id, key(3), request)).toEqual({
      outcome: 'committed',
      idempotencyKey: key(3),
      replayed: true,
    });
    expect(
      inventory.commitBorrowerOperations(borrower.id, key(3), {
        ...request,
        items: [secondGroup, firstGroup],
      }),
    ).toMatchObject({ error: 'idempotency_key_reused', outcome: 'protocol_error' });
    expect(
      inventory.commitBorrowerOperations(borrower.id, key(3), {
        ...request,
        items: [{ ...firstGroup, borrow: [...firstGroup.borrow].reverse() }, secondGroup],
      }),
    ).toMatchObject({ error: 'idempotency_key_reused' });
    expect(inventory.commitBorrowerOperations(otherBorrower.id, key(3), request)).toMatchObject({
      error: 'idempotency_key_reused',
    });
    expect(
      inventory.createBorrowerCommand(key(3), {
        contractVersion: 1,
        ledgerEpoch: 1,
        playaName: 'cross-command',
        fullName: 'Cross Command',
        phoneNumber: '',
        campDepartment: 'מחנה אחר',
      }),
    ).toMatchObject({ error: 'idempotency_key_reused' });
    expect({
      borrowers: db.prepare('SELECT COUNT(*) count FROM borrowers').get(),
      events: db.prepare('SELECT COUNT(*) count FROM inventory_events').get(),
      receipts: db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get(),
    }).toEqual(afterCommit);
  });
  it('checks epoch before receipt lookup and rolls back events when final receipt insertion fails', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'Stock',
      kind: 'non_consumable',
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
    db.prepare(
      `INSERT INTO idempotency_receipts(
        key,command_kind,ledger_epoch,contract_version,request_hash,outcome,subject_id,result_json
      ) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(key(4), 'borrower_operation', 1, 1, 'old', 'committed', borrower.id, '{}');
    db.prepare('UPDATE inventory_replacement_guard SET ledger_epoch=2 WHERE singleton=1').run();
    expect(
      inventory.commitBorrowerOperations(borrower.id, key(4), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [{ itemId: item.id, borrow: [{ quantity: 1, note: '', locationId: 1 }] }],
      }),
    ).toMatchObject({ error: 'ledger_epoch_changed' });
    db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON idempotency_receipts
       WHEN NEW.key='${key(5)}' BEGIN SELECT RAISE(ABORT, 'receipt failure'); END`);
    const before = db.prepare('SELECT COUNT(*) count FROM inventory_events').get();
    expect(() =>
      inventory.commitBorrowerOperations(borrower.id, key(5), {
        contractVersion: 1,
        ledgerEpoch: 2,
        items: [{ itemId: item.id, borrow: [{ quantity: 1, note: '', locationId: 1 }] }],
      }),
    ).toThrow(/receipt failure/);
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual(before);
    expect(db.isTransaction).toBe(false);
  });
  it('rolls back earlier command events and its receipt when a middle append fails', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({
      name: 'Rollback item',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      item.id,
      3,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.checkout(
      item.id,
      borrower.id,
      2,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const before = {
      eventCount: db.prepare('SELECT COUNT(*) count FROM inventory_events').get(),
      receiptCount: db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get(),
      snapshot: inventory.getBorrowerDeskSnapshot(borrower.id),
    };
    db.exec(`CREATE TRIGGER abort_middle_command_event BEFORE INSERT ON inventory_events
       WHEN NEW.kind='returned_damaged' AND NEW.note='abort-middle'
       BEGIN SELECT RAISE(ABORT, 'middle append failure'); END`);
    expect(() =>
      inventory.commitBorrowerOperations(borrower.id, key(14), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          {
            itemId: item.id,
            return: [{ usable: 1, damaged: 1, note: 'abort-middle', locationId: 1 }],
            borrow: [{ quantity: 1, note: 'not-reached', locationId: 1 }],
          },
        ],
      }),
    ).toThrow(/middle append failure/);
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual(
      before.eventCount,
    );
    expect(db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual(
      before.receiptCount,
    );
    expect(inventory.getBorrowerDeskSnapshot(borrower.id)).toEqual(before.snapshot);
    expect(db.isTransaction).toBe(false);
  });
  it('creates and replays a normalized borrower atomically and reports deterministic collisions', () => {
    const { db, inventory } = fixture();
    const request = {
      contractVersion: 1 as const,
      ledgerEpoch: 1,
      playaName: '  New User  ',
      fullName: ' New Name ',
      phoneNumber: ' 050 ',
      campDepartment: 'מחנה אחר' as const,
    };
    const created = inventory.createBorrowerCommand(key(6), request);
    expect(created).toMatchObject({ outcome: 'committed', replayed: false });
    const replay = inventory.createBorrowerCommand(key(6), request);
    expect(replay).toEqual({ ...created, replayed: true });
    const conflict = inventory.createBorrowerCommand(key(7), {
      ...request,
      playaName: 'ＮＥＷ USER',
    });
    expect(conflict).toMatchObject({
      error: 'borrower_conflict',
      fieldErrors: [{ field: 'fullName', code: 'duplicate_profile' }],
      matches: [{ status: 'active', matchedBy: 'playa_name' }],
    });
    expect(db.prepare('SELECT COUNT(*) count FROM borrowers').get()).toEqual({ count: 2 });
    const archived = inventory.createBorrower({
      playaName: 'archived-match',
      fullName: 'Archived Match',
      phoneNumber: 'old-phoneNumber',
      campDepartment: '',
    });
    inventory.archiveBorrower(archived.id, true);
    expect(
      inventory.createBorrowerCommand(key(11), {
        ...request,
        playaName: 'archived-match',
        fullName: 'Different',
        phoneNumber: 'different',
      }),
    ).toMatchObject({
      outcome: 'committed',
      borrower: { playaName: archived.playaName, fullName: 'Different' },
    });
    db.exec(`CREATE TRIGGER reject_create_receipt BEFORE INSERT ON idempotency_receipts
       WHEN NEW.key='${key(8)}' BEGIN SELECT RAISE(ABORT, 'receipt failure'); END`);
    expect(() =>
      inventory.createBorrowerCommand(key(8), {
        ...request,
        playaName: 'rolled-back',
        fullName: 'Rolled Back',
      }),
    ).toThrow(/receipt failure/);
    expect(
      db.prepare("SELECT COUNT(*) count FROM borrowers WHERE playa_name='rolled-back'").get(),
    ).toEqual({
      count: 0,
    });
  });
  it('revalidates rejected borrower creation replays without inserting or changing its receipt', () => {
    const { db, inventory, borrower } = fixture();
    const request = {
      contractVersion: 1 as const,
      ledgerEpoch: 1,
      playaName: borrower.playaName,
      fullName: borrower.fullName,
      phoneNumber: borrower.phoneNumber,
      campDepartment: '' as const,
    };
    expect(inventory.createBorrowerCommand(key(15), request)).toMatchObject({
      error: 'borrower_conflict',
      replayed: false,
    });
    const afterRejection = {
      borrowers: db.prepare('SELECT COUNT(*) count FROM borrowers').get(),
      receipts: db.prepare('SELECT * FROM idempotency_receipts WHERE key=?').get(key(15)),
    };
    expect(inventory.createBorrowerCommand(key(15), request)).toMatchObject({
      error: 'borrower_create_attempt_rejected',
      replayed: true,
      currentValidation: { status: 'conflicted' },
    });
    inventory.updateBorrower(borrower.id, {
      playaName: 'released-playaName',
      fullName: borrower.fullName,
      phoneNumber: borrower.phoneNumber,
      campDepartment: borrower.campDepartment,
    });
    expect(inventory.createBorrowerCommand(key(15), request)).toMatchObject({
      error: 'borrower_create_attempt_rejected',
      replayed: true,
      currentValidation: { status: 'now_valid', fieldErrors: [], matches: [] },
    });
    expect(db.prepare('SELECT COUNT(*) count FROM borrowers').get()).toEqual(
      afterRejection.borrowers,
    );
    expect(db.prepare('SELECT * FROM idempotency_receipts WHERE key=?').get(key(15))).toEqual(
      afterRejection.receipts,
    );
  });
  it('returns privacy-safe protocol errors when deleted borrower creation and operation receipts are retried', () => {
    const { inventory } = fixture();
    const createKey = key(920);
    const createRequest = {
      contractVersion: 1 as const,
      ledgerEpoch: 1,
      playaName: 'deleted-private-user',
      fullName: 'Deleted Private Name',
      phoneNumber: 'private-phoneNumber',
      campDepartment: '' as const,
    };
    const created = inventory.createBorrowerCommand(createKey, createRequest);
    expect(created).toMatchObject({ outcome: 'committed' });
    if (!('borrower' in created)) throw new Error('Borrower creation did not commit');
    const borrower = created.borrower;
    const item = inventory.createItem({
      name: 'Settled loan',
      kind: 'non_consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      item.id,
      1,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const operationKey = key(921);
    const operation = {
      contractVersion: 1 as const,
      ledgerEpoch: 1,
      items: [{ itemId: item.id, borrow: [{ quantity: 1, note: 'checkout', locationId: 1 }] }],
    };
    expect(inventory.commitBorrowerOperations(borrower.id, operationKey, operation)).toMatchObject({
      outcome: 'committed',
    });
    const returnRequest = {
      contractVersion: 1 as const,
      ledgerEpoch: 1,
      items: [
        { itemId: item.id, return: [{ usable: 1, damaged: 0, note: 'return', locationId: 1 }] },
      ],
    };
    inventory.commitBorrowerOperations(borrower.id, key(922), returnRequest);
    const status = inventory.borrowerDeletionStatus(borrower.id);
    inventory.deleteBorrowerCommand({
      key: 'delete-private-borrower-1',
      ledgerEpoch: 1,
      borrowerId: borrower.id,
      expectedStateRevision: status.stateRevision,
      expectedOutstanding: 0,
      expectedLost: 0,
      expectedFullName: borrower.fullName,
      expectedPlayaName: borrower.playaName,
      expectedPhoneNumber: borrower.phoneNumber,
      expectedCampDepartment: borrower.campDepartment,
    });
    const createRetry = inventory.createBorrowerCommand(createKey, createRequest);
    const operationRetry = inventory.commitBorrowerOperations(borrower.id, operationKey, operation);
    expect(createRetry).toMatchObject({
      error: 'idempotency_key_reused',
      outcome: 'protocol_error',
      idempotencyKey: createKey,
    });
    expect(operationRetry).toMatchObject({
      error: 'idempotency_key_reused',
      outcome: 'protocol_error',
      idempotencyKey: operationKey,
    });
    for (const result of [createRetry, operationRetry]) {
      expect(JSON.stringify(result)).not.toContain(borrower.playaName);
      expect(JSON.stringify(result)).not.toContain(borrower.fullName);
      expect(JSON.stringify(result)).not.toContain(borrower.phoneNumber);
    }
  });
});
