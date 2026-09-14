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
    username: 'borrower',
    name: 'Borrower',
    type: 'individual',
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
  it('credits checkout-linked lost equipment back to usable stock without marking more lost', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({ name: 'Recovered', kind: 'non_consumable' });
    inventory.addStock(item.id, 2);
    const checkoutId = inventory.checkout(item.id, borrower.id, 2);
    const markedLostId = inventory.markLost(checkoutId, 2, true, 'admin loss');

    expect(
      inventory.commitBorrowerOperations(borrower.id, key(18), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [{ itemId: item.id, lostCredit: [{ quantity: 1, note: 'found' }] }],
      }),
    ).toEqual({ outcome: 'committed', idempotencyKey: key(18), replayed: false });
    expect(
      db
        .prepare(
          `SELECT kind,quantity,related_event_id relatedId,note
           FROM inventory_events WHERE id>? ORDER BY id`,
        )
        .all(markedLostId),
    ).toEqual([
      { kind: 'unmarked_lost', quantity: 1, relatedId: checkoutId, note: 'found' },
      { kind: 'returned_usable', quantity: 1, relatedId: checkoutId, note: 'found' },
    ]);
    expect(inventory.getBorrowerDeskSnapshot(borrower.id)).toMatchObject({
      inventory: [expect.objectContaining({ id: item.id, available: 1 })],
      holdings: [{ itemId: item.id, returnable: 0, lost: 1 }],
    });
    expect(
      db.prepare("SELECT COUNT(*) count FROM inventory_events WHERE kind='marked_lost'").get(),
    ).toEqual({ count: 1 });
  });

  it('rejects a stale lost credit atomically and preserves the staged command envelope', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({ name: 'Stale recovery', kind: 'non_consumable' });
    inventory.addStock(item.id, 2);
    const checkoutId = inventory.checkout(item.id, borrower.id, 2);
    inventory.markLost(checkoutId, 2, true);
    const request: BorrowerOperationRequest = {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [{ itemId: item.id, lostCredit: [{ quantity: 2, note: 'stale' }] }],
    };
    inventory.markLost(checkoutId, 1, false);
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
      snapshot: { holdings: [{ itemId: item.id, returnable: 1, lost: 1 }] },
    });
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual(before);
  });

  it('commits usable, damaged, lost-credit, and borrow parts in deterministic order', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({ name: 'Mixed recovery', kind: 'non_consumable' });
    inventory.addStock(item.id, 4);
    const checkoutId = inventory.checkout(item.id, borrower.id, 4);
    const markedLostId = inventory.markLost(checkoutId, 1, true);

    expect(
      inventory.commitBorrowerOperations(borrower.id, key(20), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          {
            itemId: item.id,
            return: [
              { usable: 1, damaged: 0, note: 'usable' },
              { usable: 0, damaged: 1, note: 'damaged' },
            ],
            lostCredit: [{ quantity: 1, note: 'found' }],
            borrow: [{ quantity: 2, note: 'again' }],
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
      { kind: 'unmarked_lost', quantity: 1, note: 'found' },
      { kind: 'returned_usable', quantity: 1, note: 'found' },
      { kind: 'checked_out', quantity: 2, note: 'again' },
    ]);
    expect(inventory.getBorrowerDeskSnapshot(borrower.id).holdings).toEqual([
      { itemId: item.id, returnable: 3, lost: 0 },
    ]);
  });

  it('opens exactly one write transaction for each public command', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({ name: 'Counted', kind: 'non_consumable' });
    inventory.addStock(item.id, 1);
    const counted = transactionCountingDatabase(db);
    const commands = new InventoryService(counted.wrapped);

    commands.commitBorrowerOperations(borrower.id, key(12), {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [{ itemId: item.id, borrow: [{ quantity: 1, note: '' }] }],
    });
    expect(counted.beginCount()).toBe(1);
    commands.createBorrowerCommand(key(13), {
      contractVersion: 1,
      ledgerEpoch: 1,
      username: 'counted-create',
      name: 'Counted Create',
      contact: '',
      type: 'individual',
    });
    expect(counted.beginCount()).toBe(2);
  });

  it('allocates ordered return parts before ordered borrows without targeting new checkouts', () => {
    const { db, inventory, borrower } = fixture();
    const secondItem = inventory.createItem({ name: 'Second', kind: 'non_consumable' });
    const firstItem = inventory.createItem({ name: 'First', kind: 'non_consumable' });
    inventory.addStock(secondItem.id, 10);
    inventory.addStock(firstItem.id, 10);
    const oldFirst = inventory.checkout(firstItem.id, borrower.id, 1, 'old-first');
    const oldSecond = inventory.checkout(firstItem.id, borrower.id, 4, 'old-second');

    const result = inventory.commitBorrowerOperations(borrower.id, key(1), {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [
        { itemId: secondItem.id, borrow: [{ quantity: 1, note: 'second-borrow' }] },
        {
          itemId: firstItem.id,
          return: [
            { usable: 2, damaged: 1, note: 'part-a' },
            { usable: 2, damaged: 0, note: 'part-b' },
          ],
          borrow: [{ quantity: 2, note: 'first-borrow' }],
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
    const item = inventory.createItem({ name: 'Tie breaker', kind: 'non_consumable' });
    inventory.addStock(item.id, 2);
    const insertCheckout = db.prepare(
      `INSERT INTO inventory_events(kind,item_id,borrower_id,quantity,note,created_at)
       VALUES ('checked_out',?,?,?,?,?)`,
    );
    const first = Number(
      insertCheckout.run(item.id, borrower.id, 1, 'first', '2026-01-01 00:00:00').lastInsertRowid,
    );
    const second = Number(
      insertCheckout.run(item.id, borrower.id, 1, 'second', '2026-01-01 00:00:00').lastInsertRowid,
    );
    expect(second).toBeGreaterThan(first);
    const beforeEvents = Number(
      (db.prepare('SELECT COUNT(*) count FROM inventory_events').get() as { count: number }).count,
    );

    expect(
      inventory.commitBorrowerOperations(borrower.id, key(16), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [{ itemId: item.id, return: [{ usable: 1, damaged: 0, note: 'tie' }] }],
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
    const item = inventory.createItem({ name: 'Damaged only', kind: 'non_consumable' });
    inventory.addStock(item.id, 1);
    inventory.checkout(item.id, borrower.id, 1);
    const beforeEvents = db.prepare('SELECT COUNT(*) count FROM inventory_events').get();

    expect(
      inventory.commitBorrowerOperations(borrower.id, key(17), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          {
            itemId: item.id,
            return: [{ usable: 0, damaged: 1, note: 'damaged' }],
            borrow: [{ quantity: 1, note: 'must not be funded' }],
          },
        ],
      }),
    ).toMatchObject({
      error: 'borrower_operation_conflict',
      conflicts: [
        {
          scope: 'borrow',
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
    const item = inventory.createItem({ name: 'Limited', kind: 'non_consumable' });
    inventory.addStock(item.id, 1);
    const checkout = inventory.checkout(item.id, borrower.id, 1);
    const request = {
      contractVersion: 1 as const,
      ledgerEpoch: 1,
      items: [
        {
          itemId: item.id,
          return: [{ usable: 2, damaged: 0, note: 'too many' }],
          borrow: [{ quantity: 99, note: 'suppressed' }],
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
      snapshot: { asOfEventId: checkout, ledgerEpoch: 1 },
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
          asOfEventId: checkout,
          holdings: [{ itemId: item.id, returnable: 1, lost: 0 }],
        },
      },
    });
    inventory.addStock(item.id, 100);
    const freshConflict = inventory.commitBorrowerOperations(borrower.id, key(2), request);
    expect(freshConflict).toMatchObject({
      currentValidation: {
        status: 'conflicted',
        snapshot: {
          asOfEventId: checkout + 1,
          inventory: [expect.objectContaining({ id: item.id, available: 100 })],
          holdings: [{ itemId: item.id, returnable: 1, lost: 0 }],
        },
      },
    });
    inventory.checkout(item.id, borrower.id, 1);
    const replay = inventory.commitBorrowerOperations(borrower.id, key(2), request);
    expect(replay).toMatchObject({
      error: 'borrower_operation_attempt_rejected',
      replayed: true,
      currentValidation: {
        status: 'now_valid',
        conflicts: [],
        snapshot: {
          asOfEventId: checkout + 2,
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
    const archived = inventory.createItem({ name: 'Archived', kind: 'non_consumable' });
    const consumable = inventory.createItem({ name: 'Consumable', kind: 'consumable' });
    const empty = inventory.createItem({ name: 'Empty', kind: 'non_consumable' });
    inventory.archiveItem(archived.id, true);
    const request = {
      contractVersion: 1 as const,
      ledgerEpoch: 1,
      items: [
        { itemId: empty.id, borrow: [{ quantity: 1, note: '' }] },
        { itemId: 999_999, borrow: [{ quantity: 1, note: '' }] },
        { itemId: archived.id, borrow: [{ quantity: 1, note: '' }] },
        { itemId: consumable.id, borrow: [{ quantity: 1, note: '' }] },
      ],
    };
    expect(inventory.commitBorrowerOperations(borrower.id, key(9), request)).toMatchObject({
      conflicts: [
        { scope: 'item', code: 'item_archived', itemId: archived.id },
        { scope: 'item', code: 'wrong_item_kind', itemId: consumable.id },
        { scope: 'borrow', code: 'insufficient_stock', itemId: empty.id },
        { scope: 'item', code: 'item_not_found', itemId: 999_999 },
      ],
    });

    inventory.archiveBorrower(borrower.id, true);
    expect(inventory.commitBorrowerOperations(borrower.id, key(10), request)).toMatchObject({
      conflicts: [{ scope: 'borrower', code: 'borrower_inactive', borrowerId: borrower.id }],
    });
  });

  it('replays committed operations and rejects changed identity without mutation', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({ name: 'Stock', kind: 'non_consumable' });
    const otherItem = inventory.createItem({ name: 'Other stock', kind: 'non_consumable' });
    const otherBorrower = inventory.createBorrower({
      username: 'other-subject',
      name: 'Other Subject',
      type: 'individual',
    });
    inventory.addStock(item.id, 3);
    inventory.addStock(otherItem.id, 2);
    const firstGroup = {
      itemId: item.id,
      borrow: [
        { quantity: 1, note: 'first' },
        { quantity: 1, note: 'second' },
      ],
    };
    const secondGroup = {
      itemId: otherItem.id,
      borrow: [{ quantity: 1, note: 'other-item' }],
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
        username: 'cross-command',
        name: 'Cross Command',
        contact: '',
        type: 'other',
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
    const item = inventory.createItem({ name: 'Stock', kind: 'non_consumable' });
    inventory.addStock(item.id, 2);
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
        items: [{ itemId: item.id, borrow: [{ quantity: 1, note: '' }] }],
      }),
    ).toMatchObject({ error: 'ledger_epoch_changed' });

    db.exec(
      `CREATE TRIGGER reject_receipt BEFORE INSERT ON idempotency_receipts
       WHEN NEW.key='${key(5)}' BEGIN SELECT RAISE(ABORT, 'receipt failure'); END`,
    );
    const before = db.prepare('SELECT COUNT(*) count FROM inventory_events').get();
    expect(() =>
      inventory.commitBorrowerOperations(borrower.id, key(5), {
        contractVersion: 1,
        ledgerEpoch: 2,
        items: [{ itemId: item.id, borrow: [{ quantity: 1, note: '' }] }],
      }),
    ).toThrow(/receipt failure/);
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual(before);
    expect(db.isTransaction).toBe(false);
  });

  it('rolls back earlier command events and its receipt when a middle append fails', () => {
    const { db, inventory, borrower } = fixture();
    const item = inventory.createItem({ name: 'Rollback item', kind: 'non_consumable' });
    inventory.addStock(item.id, 3);
    inventory.checkout(item.id, borrower.id, 2);
    const before = {
      eventCount: db.prepare('SELECT COUNT(*) count FROM inventory_events').get(),
      receiptCount: db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get(),
      snapshot: inventory.getBorrowerDeskSnapshot(borrower.id),
    };
    db.exec(
      `CREATE TRIGGER abort_middle_command_event BEFORE INSERT ON inventory_events
       WHEN NEW.kind='returned_damaged' AND NEW.note='abort-middle'
       BEGIN SELECT RAISE(ABORT, 'middle append failure'); END`,
    );

    expect(() =>
      inventory.commitBorrowerOperations(borrower.id, key(14), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          {
            itemId: item.id,
            return: [{ usable: 1, damaged: 1, note: 'abort-middle' }],
            borrow: [{ quantity: 1, note: 'not-reached' }],
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
      username: '  New User  ',
      name: ' New Name ',
      contact: ' 050 ',
      type: 'other' as const,
    };
    const created = inventory.createBorrowerCommand(key(6), request);
    expect(created).toMatchObject({ outcome: 'committed', replayed: false });
    const replay = inventory.createBorrowerCommand(key(6), request);
    expect(replay).toEqual({ ...created, replayed: true });

    const conflict = inventory.createBorrowerCommand(key(7), {
      ...request,
      username: 'ＮＥＷ USER',
    });
    expect(conflict).toMatchObject({
      error: 'borrower_conflict',
      fieldErrors: [
        { field: 'username', code: 'username_conflict' },
        { field: 'contact', code: 'contact_conflict' },
        { field: 'name', code: 'full_name_conflict' },
      ],
      matches: [{ status: 'active', matchedBy: 'username' }],
    });
    expect(db.prepare('SELECT COUNT(*) count FROM borrowers').get()).toEqual({ count: 2 });

    const archived = inventory.createBorrower({
      username: 'archived-match',
      name: 'Archived Match',
      contact: 'old-contact',
      type: 'individual',
    });
    inventory.archiveBorrower(archived.id, true);
    expect(
      inventory.createBorrowerCommand(key(11), {
        ...request,
        username: 'archived-match',
        name: 'Different',
        contact: 'different',
      }),
    ).toMatchObject({
      fieldErrors: [{ field: 'username' }],
      matches: [{ borrower: { id: archived.id }, status: 'archived', matchedBy: 'username' }],
    });

    db.exec(
      `CREATE TRIGGER reject_create_receipt BEFORE INSERT ON idempotency_receipts
       WHEN NEW.key='${key(8)}' BEGIN SELECT RAISE(ABORT, 'receipt failure'); END`,
    );
    expect(() =>
      inventory.createBorrowerCommand(key(8), {
        ...request,
        username: 'rolled-back',
        name: 'Rolled Back',
      }),
    ).toThrow(/receipt failure/);
    expect(
      db.prepare("SELECT COUNT(*) count FROM borrowers WHERE username='rolled-back'").get(),
    ).toEqual({
      count: 0,
    });
  });

  it('revalidates rejected borrower creation replays without inserting or changing its receipt', () => {
    const { db, inventory, borrower } = fixture();
    const request = {
      contractVersion: 1 as const,
      ledgerEpoch: 1,
      username: borrower.username,
      name: 'Requested Name',
      contact: 'requested-contact',
      type: 'individual' as const,
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
      username: 'released-username',
      name: borrower.name,
      contact: borrower.contact,
      type: borrower.type,
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
});
