import { transferBusinessState } from '../helpers/transfer-business-state.js';
import { foundReturned } from '../helpers/found-returned.js';
import ExcelJS from 'exceljs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { InventoryTransferService } from '../../src/domain/import-export.js';
import { InventoryService } from '../../src/domain/inventory.js';
import { WORKBOOK_CONTRACT } from '../../src/io/workbook-contract.js';
import {
  exportWorkbook,
  parseRecoveryWorkbook,
  parseResetWorkbook,
} from '../../src/io/workbook.js';
import { createApp } from '../../src/server/index.js';
import { recordHistoricalStockRemoval } from '../helpers/historical-events.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function database(name: string) {
  const directory = mkdtempSync(join(tmpdir(), `mapatz-${name}-`));
  cleanup.push(directory);
  return openDatabase(join(directory, 'inventory.sqlite'));
}

function sourceFixture() {
  const db = database('recovery-source');
  const transfers = new InventoryTransferService(db);
  transfers.replaceWithReset({
    locations: [
      { name: 'Main', archived: false },
      { name: 'Historic', archived: true },
    ],
    items: [
      {
        name: 'Water',
        kind: 'consumable',
        location: 'Main',
        aliases: ['H2O'],
        lotSize: 12,
        archived: false,
        total: 100,
      },
      {
        name: 'Tent',
        kind: 'non_consumable',
        location: 'Main',
        aliases: ['Shelter'],
        lotSize: null,
        archived: false,
        total: 6,
      },
      {
        name: 'Old stock',
        kind: 'consumable',
        location: null,
        aliases: [],
        lotSize: null,
        archived: true,
        total: 0,
      },
    ],
  });
  const inventory = new InventoryService(db);
  const water = inventory.listItems('Water', true)[0]!;
  const tent = inventory.listItems('Tent', true)[0]!;
  inventory.addStock(water.id, 20, 'received');
  inventory.issue(water.id, 30, 'used');
  recordHistoricalStockRemoval(db, water.id, 5, 'historical count correction');
  const borrower = inventory.createBorrower({
    username: 'camp-a',
    name: 'Camp A',
    contact: 'radio 2',
    type: 'camp_organization',
  });
  const oldBorrower = inventory.createBorrower({
    username: 'retired',
    name: 'Retired',
    type: 'other',
  });
  inventory.archiveBorrower(oldBorrower.id, true);
  const checkout = inventory.checkout(tent.id, borrower.id, 4, 'field loan');
  inventory.markLost(checkout, 1, true, 'missing');
  inventory.returnCheckout(checkout, 0, 1, 'damaged return');
  return { db, transfers, inventory, waterId: water.id, tentId: tent.id };
}

async function workbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const result = new ExcelJS.Workbook();
  await result.xlsx.load(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  );
  return result;
}

async function save(workbook: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function expectRecoveredState(
  actual: ReturnType<InventoryTransferService['snapshot']>,
  expected: ReturnType<InventoryTransferService['snapshot']>,
) {
  const { identityHighWater: actualHighWater } = actual;
  const { identityHighWater: expectedHighWater } = expected;
  expect(transferBusinessState(actual)).toEqual(transferBusinessState(expected));
  for (const field of Object.keys(expectedHighWater) as Array<keyof typeof expectedHighWater>)
    expect(actualHighWater[field]).toBeGreaterThanOrEqual(expectedHighWater[field]);
}

describe('complete inventory recovery', () => {
  it('rejects missing, invalid, duplicate, and dangling workbook item identities atomically', async () => {
    const source = sourceFixture();
    const valid = await parseRecoveryWorkbook(await exportWorkbook(source.transfers.snapshot()));
    const destination = database('invalid-identity-destination');
    const transfers = new InventoryTransferService(destination);
    new InventoryService(destination).createItem({
      name: 'Destination survives',
      kind: 'consumable',
    });
    const before = transfers.snapshot();
    const epochBefore = new InventoryService(destination).inventoryEpoch();
    const mutations: Array<(payload: typeof valid) => void> = [
      (payload) => {
        payload.items[0]!.id = undefined as never;
      },
      (payload) => {
        payload.items[0]!.id = 0;
      },
      (payload) => {
        payload.items[0]!.id = 1.5;
      },
      (payload) => {
        payload.items[1]!.id = payload.items[0]!.id;
      },
      (payload) => {
        payload.events[0]!.itemId = 999999;
      },
      (payload) => {
        payload.loans[0]!.itemId = 999999;
      },
    ];
    for (const mutate of mutations) {
      const invalid = structuredClone(valid);
      mutate(invalid);
      expect(() => transfers.replaceWithRecovery(invalid)).toThrow(
        expect.objectContaining({ code: 'invalid_workbook' }),
      );
      expect(transfers.snapshot()).toEqual(before);
      expect(new InventoryService(destination).inventoryEpoch()).toBe(epochBefore);
    }
    source.db.close();
    destination.close();
  });

  it('preserves deleted report anchors and identity high-water marks in a new recovery workbook', async () => {
    const source = openDatabase(':memory:');
    const sourceInventory = new InventoryService(source);
    const sourceTransfers = new InventoryTransferService(source);
    const removed = sourceInventory.createItem({ name: 'Deleted name', kind: 'consumable' });
    sourceInventory.addStock(removed.id, 1);
    const survivor = sourceInventory.createItem({ name: 'Surviving loan', kind: 'non_consumable' });
    const borrower = sourceInventory.createBorrower({
      username: 'removed-borrower',
      name: 'Removed Borrower',
      type: 'individual',
    });
    sourceInventory.addStock(survivor.id, 4);
    const checkoutId = sourceInventory.checkout(survivor.id, borrower.id, 1);
    sourceInventory.returnCheckout(checkoutId, 1, 0);
    source
      .prepare('UPDATE inventory_baselines SET quantity=4,through_event_id=? WHERE item_id=?')
      .run(checkoutId, survivor.id);
    const status = sourceInventory.borrowerDeletionStatus(borrower.id);
    sourceInventory.deleteBorrowerCommand({
      key: 'delete-borrower-recovery',
      ledgerEpoch: sourceInventory.inventoryEpoch(),
      borrowerId: borrower.id,
      expectedStateRevision: status.stateRevision,
      expectedOutstanding: status.outstanding,
      expectedLost: status.lost,
      expectedName: status.borrower.name,
      expectedUsername: status.borrower.username,
    });
    sourceInventory.deleteItemCommand({
      key: 'delete-item-recovery',
      ledgerEpoch: sourceInventory.inventoryEpoch(),
      itemId: removed.id,
      expectedStockRevision: sourceInventory.listItems('Deleted name', true)[0]!.stockRevision,
      expectedName: removed.name,
      expectedLocationId: removed.locationId,
    });

    const snapshot = sourceTransfers.snapshot();
    const survivorSnapshot = snapshot.items.find((item) => item.id === survivor.id)!;
    expect(survivorSnapshot.baselineThroughEventId).toBe(checkoutId);
    expect(snapshot.events.some((event) => event.id === checkoutId)).toBe(false);
    expect(snapshot.borrowers.some((entry) => entry.username === 'removed-borrower')).toBe(false);
    expect(snapshot.items.some((item) => item.id === removed.id)).toBe(false);
    const payload = await parseRecoveryWorkbook(await exportWorkbook(snapshot));

    const destination = openDatabase(':memory:');
    const destinationTransfers = new InventoryTransferService(destination);
    destinationTransfers.replaceWithRecovery(payload);
    expectRecoveredState(destinationTransfers.snapshot(), snapshot);
    expect(
      destinationTransfers.snapshot().items.find((item) => item.name === survivor.name),
    ).toMatchObject({
      baselineThroughEventId: checkoutId,
      available: 4,
    });

    const recoveredInventory = new InventoryService(destination);
    const nextItem = recoveredInventory.createItem({ name: 'After recovery', kind: 'consumable' });
    recoveredInventory.addStock(nextItem.id, 1);
    const newEvent = recoveredInventory.listLedger()[0]!;
    expect(nextItem.id).toBeGreaterThan(removed.id);
    expect(newEvent.id).toBeGreaterThanOrEqual(snapshot.identityHighWater.nextEventId);
    expect(newEvent.id).toBeGreaterThan(checkoutId);
    source.close();
    destination.close();
  });

  it('round-trips business state into a clean destination and remains operable', async () => {
    const source = sourceFixture();
    const expected = source.transfers.snapshot();
    const exported = await exportWorkbook(expected);
    const payload = await parseRecoveryWorkbook(exported);

    const destination = database('recovery-destination');
    createApp({
      database: destination,
      adminPassword: 'destination-admin',
      serveWeb: false,
    });
    const destinationInventory = new InventoryService(destination);
    const destinationTransfers = new InventoryTransferService(destination);
    const disposable = destinationInventory.createItem({
      name: 'Destination old data',
      kind: 'consumable',
    });
    destinationInventory.addStock(disposable.id, 99);
    const credentialsBefore = destination
      .prepare('SELECT role,salt,password_hash,updated_at FROM credentials ORDER BY role')
      .all();
    destination
      .prepare(
        `INSERT INTO idempotency_receipts(
          key,command_kind,ledger_epoch,contract_version,request_hash,outcome,subject_id,result_json
        ) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('obsolete-recovery', 'borrower_operation', 1, 1, 'hash', 'committed', 1, '{}');
    destinationInventory.saveInventoryLocation({
      key: 'obsolete-inventory-1',
      ledgerEpoch: destinationInventory.inventoryEpoch(),
      code: 'obsolete',
      name: 'Obsolete',
    });
    const epochBefore = destination
      .prepare('SELECT ledger_epoch FROM inventory_replacement_guard')
      .get();

    destinationTransfers.replaceWithRecovery(payload);
    expectRecoveredState(destinationTransfers.snapshot(), expected);
    expect(destinationTransfers.snapshot().items.find((item) => item.name === 'Tent')!.id).not.toBe(
      source.tentId,
    );
    expect(
      destination.prepare('SELECT ledger_epoch FROM inventory_replacement_guard').get(),
    ).toEqual({
      ledger_epoch: (epochBefore as { ledger_epoch: number }).ledger_epoch + 1,
    });
    expect(destination.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual({
      count: 0,
    });
    expect(
      destination.prepare('SELECT COUNT(*) count FROM inventory_command_receipts').get(),
    ).toEqual({
      count: 1,
    });
    expect(destination.prepare('SELECT key FROM inventory_command_receipts').get()).toEqual({
      key: 'system:identity-high-water',
    });
    expect(
      destination
        .prepare('SELECT role,salt,password_hash,updated_at FROM credentials ORDER BY role')
        .all(),
    ).toEqual(credentialsBefore);
    destination
      .prepare(
        `INSERT INTO idempotency_receipts(
          key,command_kind,ledger_epoch,contract_version,request_hash,outcome,subject_id,result_json
        ) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('obsolete-second-recovery', 'borrower_operation', 2, 1, 'hash', 'committed', 1, '{}');
    destinationTransfers.replaceWithRecovery(payload);
    expectRecoveredState(destinationTransfers.snapshot(), expected);
    expect(
      destination.prepare('SELECT ledger_epoch FROM inventory_replacement_guard').get(),
    ).toEqual({ ledger_epoch: 3 });
    expect(destination.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual({
      count: 0,
    });

    const water = destinationInventory.listItems('Water', true)[0]!;
    destinationInventory.issue(water.id, 1, 'future issue');
    const loan = destinationInventory.listLoans().find((entry) => entry.itemName === 'Tent')!;
    foundReturned(destinationInventory, loan.checkoutId, 1);
    const restoredLoan = destinationInventory
      .listLoans()
      .find((entry) => entry.checkoutId === loan.checkoutId)!;
    destinationInventory.returnCheckout(restoredLoan.checkoutId, restoredLoan.outstanding, 0);
    const tent = destinationInventory.listItems('Tent', true)[0]!;
    destinationInventory.resolveDamage(tent.id, 1, true, 'repaired after recovery');
    expect(destinationInventory.listLoans()).toEqual([]);
    expect(destinationInventory.listItems('Water', true)[0]!.available).toBe(89);
    source.db.close();
    destination.close();
  });

  it('ignores reset edits and rejects incomplete or inconsistent recovery payloads', async () => {
    const source = sourceFixture();
    const original = await exportWorkbook(source.transfers.snapshot());

    const resetEdited = await workbook(original);
    const resetItems = resetEdited.getWorksheet(WORKBOOK_CONTRACT.sheets.resetItems.name)!;
    const headers = resetItems.getRow(1).values as string[];
    const nameColumn = headers.indexOf('Name');
    const totalColumn = headers.indexOf('Total');
    const waterRow = resetItems
      .getRows(2, resetItems.rowCount - 1)!
      .find((row) => row.getCell(nameColumn).value === 'Water')!;
    waterRow.getCell(totalColumn).value = 999_999;
    const editedBytes = await save(resetEdited);
    const resetPayload = await parseResetWorkbook(editedBytes);
    expect(resetPayload.items.find((item) => item.name === 'Water')!.total).toBe(999_999);
    expect(await parseRecoveryWorkbook(editedBytes)).toEqual(await parseRecoveryWorkbook(original));

    const missingSheet = await workbook(original);
    missingSheet.removeWorksheet(
      missingSheet.getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryEvents.name)!.id,
    );
    await expect(parseRecoveryWorkbook(await save(missingSheet))).rejects.toThrow(
      /Missing required sheet/,
    );

    const missingCode = await workbook(original);
    missingCode
      .getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryItems.name)!
      .getRow(2)
      .getCell(1).value = null;
    await expect(parseRecoveryWorkbook(await save(missingCode))).rejects.toThrow(/Item ID/);

    const brokenBaseline = await workbook(original);
    brokenBaseline
      .getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryItems.name)!
      .getRow(2)
      .getCell(9).value = 101;
    const independentBaseline = await parseRecoveryWorkbook(await save(brokenBaseline));
    expect(independentBaseline.items[0]).toMatchObject({ startingStock: 101 });

    const brokenReference = await workbook(original);
    const eventSheet = brokenReference.getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryEvents.name)!;
    const checkoutRow = eventSheet
      .getRows(2, eventSheet.rowCount - 1)!
      .find((row) => row.getCell(2).value === 'returned_damaged')!;
    checkoutRow.getCell(6).value = 999_999;
    await expect(parseRecoveryWorkbook(await save(brokenReference))).rejects.toThrow(
      /missing or mismatched checkout/,
    );

    const brokenChronology = await workbook(original);
    brokenChronology
      .getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryEvents.name)!
      .getRow(3)
      .getCell(8).value = '2000-01-01T00:00:00.000Z';
    await expect(parseRecoveryWorkbook(await save(brokenChronology))).rejects.toThrow(
      /occurs before/,
    );
    source.db.close();
  });

  it('rejects missing and inconsistent authoritative state without changing the destination', async () => {
    const source = sourceFixture();
    const original = await exportWorkbook(source.transfers.snapshot());
    const destination = database('invalid-stored-state');
    const transfers = new InventoryTransferService(destination);
    const before = transfers.snapshot();
    const epoch = destination.prepare('SELECT ledger_epoch FROM inventory_replacement_guard').get();
    const edits: Array<(book: ExcelJS.Workbook) => void> = [
      (book) => {
        book
          .getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryItems.name)!
          .getRow(2)
          .getCell(11).value = null;
      },
      (book) => {
        book.removeWorksheet(book.getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryLoans.name)!.id);
      },
      (book) => {
        book.getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryLoans.name)!.getRow(2).getCell(6).value =
          99;
      },
      (book) => {
        book
          .getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryItems.name)!
          .getRow(3)
          .getCell(12).value = 0;
      },
      (book) => {
        book
          .getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryItems.name)!
          .getRow(3)
          .getCell(15).value = 999;
      },
    ];
    for (const edit of edits) {
      const book = await workbook(original);
      edit(book);
      await expect(parseRecoveryWorkbook(await save(book))).rejects.toThrow();
      expect(transfers.snapshot()).toEqual(before);
      expect(
        destination.prepare('SELECT ledger_epoch FROM inventory_replacement_guard').get(),
      ).toEqual(epoch);
    }
    source.db.close();
    destination.close();
  });

  it('rejects active or archived recovered items at archived locations before replacing inventory', async () => {
    const source = sourceFixture();
    const payload = await parseRecoveryWorkbook(await exportWorkbook(source.transfers.snapshot()));

    const destination = database('active-item-archived-location');
    const transfers = new InventoryTransferService(destination);
    const before = transfers.snapshot();
    const epoch = destination.prepare('SELECT ledger_epoch FROM inventory_replacement_guard').get();

    for (const archived of [false, true]) {
      const invalid = structuredClone(payload);
      const item = invalid.items.find((entry) => entry.name === 'Old stock')!;
      item.archived = archived;
      item.location = 'Historic';
      expect(() => transfers.replaceWithRecovery(invalid)).toThrow(
        /references an archived location/,
      );
      expect(transfers.snapshot()).toEqual(before);
      expect(
        destination.prepare('SELECT ledger_epoch FROM inventory_replacement_guard').get(),
      ).toEqual(epoch);
    }
    source.db.close();
    destination.close();
  });

  it('rejects an unsafe combined recovery reset total before replacing inventory', async () => {
    const source = sourceFixture();
    const payload = await parseRecoveryWorkbook(await exportWorkbook(source.transfers.snapshot()));
    payload.items.find((item) => item.id === source.tentId)!.available = Number.MAX_SAFE_INTEGER;

    const destination = database('unsafe-recovery-reset-total');
    const transfers = new InventoryTransferService(destination);
    const before = transfers.snapshot();
    const epoch = destination.prepare('SELECT ledger_epoch FROM inventory_replacement_guard').get();

    expect(() => transfers.replaceWithRecovery(payload)).toThrow(
      /reset total exceeds safe integer/,
    );
    expect(transfers.snapshot()).toEqual(before);
    expect(
      destination.prepare('SELECT ledger_epoch FROM inventory_replacement_guard').get(),
    ).toEqual(epoch);
    source.db.close();
    destination.close();
  });

  it('rolls back the destination when recovery commit fails', async () => {
    const source = sourceFixture();
    const payload = await parseRecoveryWorkbook(await exportWorkbook(source.transfers.snapshot()));
    const destination = database('recovery-rollback');
    const inventory = new InventoryService(destination);
    const transfers = new InventoryTransferService(destination);
    const old = inventory.createItem({ name: 'Keep me', kind: 'consumable' });
    inventory.addStock(old.id, 3);
    destination
      .prepare(
        `INSERT INTO idempotency_receipts(
          key,command_kind,ledger_epoch,contract_version,request_hash,outcome,subject_id,result_json
        ) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('preserved-recovery', 'borrower_operation', 1, 1, 'hash', 'committed', 1, '{}');
    const before = transfers.snapshot();
    const protocolBefore = {
      guard: destination
        .prepare('SELECT enabled,ledger_epoch FROM inventory_replacement_guard')
        .get(),
      receipts: destination.prepare('SELECT * FROM idempotency_receipts').all(),
    };
    destination.exec(`CREATE TRIGGER reject_recovered_event BEFORE INSERT ON inventory_events
      BEGIN SELECT RAISE(ABORT, 'forced recovery failure'); END;`);

    expect(() => transfers.replaceWithRecovery(payload)).toThrow(/forced recovery failure/);
    expect(transfers.snapshot()).toEqual(before);
    expect({
      guard: destination
        .prepare('SELECT enabled,ledger_epoch FROM inventory_replacement_guard')
        .get(),
      receipts: destination.prepare('SELECT * FROM idempotency_receipts').all(),
    }).toEqual(protocolBefore);
    source.db.close();
    destination.close();
  });
});

it('round-trips mixed ordinary and found returns and rejects malformed recoveries atomically', async () => {
  const source = sourceFixture();
  const loan = source.inventory.listLoans()[0]!;
  source.inventory.returnCheckout(loan.checkoutId, 1, 0, 'ordinary');
  foundReturned(source.inventory, loan.checkoutId, 1, 'found separately');
  const snapshot = source.transfers.snapshot();
  const bytes = await exportWorkbook(snapshot);
  const payload = await parseRecoveryWorkbook(bytes);
  const destination = database('mixed-found-returned');
  const transfers = new InventoryTransferService(destination);
  transfers.replaceWithRecovery(payload);
  expectRecoveredState(transfers.snapshot(), snapshot);
  const totals = destination
    .prepare(
      "SELECT kind,SUM(quantity) quantity FROM inventory_events WHERE kind IN ('returned_usable','returned_damaged','found_returned') GROUP BY kind ORDER BY kind",
    )
    .all();
  expect(totals).toEqual([
    { kind: 'found_returned', quantity: 1 },
    { kind: 'returned_damaged', quantity: 1 },
    { kind: 'returned_usable', quantity: 1 },
  ]);
  expect(new InventoryService(destination).listLoans()[0]).toMatchObject({
    outstanding: 1,
    lost: 0,
  });
  const before = transfers.snapshot();
  const epoch = destination.prepare('SELECT ledger_epoch FROM inventory_replacement_guard').get();
  for (const changes of [
    { relatedEventId: null },
    { relatedEventId: 999999 },
    { relatedEventId: payload.events[0]!.id },
    { borrowerUsername: 'retired' },
    { itemId: source.waterId },
    { kind: 'unmarked_lost' },
  ]) {
    const malformed = structuredClone(payload);
    Object.assign(
      malformed.events.find((event) => event.kind === 'found_returned')!,
      changes,
    );
    expect(() => transfers.replaceWithRecovery(malformed)).toThrow();
    expect(transfers.snapshot()).toEqual(before);
    expect(
      destination.prepare('SELECT ledger_epoch FROM inventory_replacement_guard').get(),
    ).toEqual(epoch);
  }
  const legacy = await workbook(bytes);
  const events = legacy.getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryEvents.name)!;
  events.eachRow((row) => {
    if (row.getCell(2).value === 'found_returned') row.getCell(2).value = 'unmarked_lost';
  });
  await expect(parseRecoveryWorkbook(await save(legacy))).rejects.toThrow(/unsupported Kind/);
  source.db.close();
  destination.close();
});

it('round-trips damaged lost recovery and rejects an over-recovery workbook', async () => {
  const source = sourceFixture();
  const loan = source.inventory.listLoans()[0]!;
  expect(
    source.inventory.commitBorrowerOperations(
      loan.borrowerId,
      '00000000-0000-4000-8000-000000000026',
      {
        contractVersion: 1,
        ledgerEpoch: 2,
        items: [
          {
            itemId: loan.itemId,
            lostCredit: [{ quantity: 1, condition: 'damaged', note: 'found broken' }],
          },
        ],
      },
    ),
  ).toMatchObject({ outcome: 'committed' });
  const snapshot = source.transfers.snapshot();
  const bytes = await exportWorkbook(snapshot);
  const payload = await parseRecoveryWorkbook(bytes);
  const destination = database('damaged-found-returned');
  const transfers = new InventoryTransferService(destination);
  transfers.replaceWithRecovery(payload);
  expectRecoveredState(transfers.snapshot(), snapshot);
  expect(new InventoryService(destination).listLoans()[0]).toMatchObject({
    outstanding: 2,
    lost: 0,
  });

  const independentlyEditedAudit = structuredClone(payload);
  independentlyEditedAudit.events.find(
    (event) => event.kind === 'found_returned_damaged',
  )!.quantity = 2;
  expect(() => transfers.replaceWithRecovery(independentlyEditedAudit)).not.toThrow();
  expect(transferBusinessState(transfers.snapshot()).items).toEqual(
    transferBusinessState(snapshot).items,
  );
  expect(transferBusinessState(transfers.snapshot()).loans).toEqual(
    transferBusinessState(snapshot).loans,
  );

  const editedWorkbook = await workbook(bytes);
  const events = editedWorkbook.getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryEvents.name)!;
  events.eachRow((row) => {
    if (row.getCell(2).value === 'found_returned_damaged') row.getCell(5).value = 2;
  });
  await expect(parseRecoveryWorkbook(await save(editedWorkbook))).resolves.toMatchObject({
    items: expect.any(Array),
  });
  source.db.close();
  destination.close();
});
