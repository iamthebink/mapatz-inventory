import ExcelJS from 'exceljs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { InventoryTransferService } from '../../src/domain/import-export.js';
import { InventoryService } from '../../src/domain/inventory.js';
import { WORKBOOK_CONTRACT } from '../../src/io/workbook-contract.js';
import { exportWorkbook, parseRecoveryWorkbook } from '../../src/io/workbook.js';
import { createApp } from '../../src/server/index.js';

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
        code: 5,
        name: 'Water',
        kind: 'consumable',
        location: 'Main',
        aliases: ['H2O'],
        lotSize: 12,
        archived: false,
        total: 100,
      },
      {
        code: 101,
        name: 'Tent',
        kind: 'non_consumable',
        location: 'Main',
        aliases: ['Shelter'],
        lotSize: null,
        archived: false,
        total: 6,
      },
      {
        code: 102,
        name: 'Old stock',
        kind: 'consumable',
        location: 'Historic',
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
  inventory.removeStock(water.id, 5, 'count correction');
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
  return { db, transfers, inventory, waterCode: water.code, tentCode: tent.code };
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

describe('complete inventory recovery', () => {
  it('round-trips business state into a clean destination and remains operable', async () => {
    const source = sourceFixture();
    const expected = source.transfers.snapshot();
    const exported = await exportWorkbook(expected);
    const payload = await parseRecoveryWorkbook(exported);

    const destination = database('recovery-destination');
    createApp({
      database: destination,
      operatorPassword: 'destination-operator',
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

    destinationTransfers.replaceWithRecovery(payload);
    expect(destinationTransfers.snapshot()).toEqual(expected);
    expect(
      destination
        .prepare('SELECT role,salt,password_hash,updated_at FROM credentials ORDER BY role')
        .all(),
    ).toEqual(credentialsBefore);

    const water = destinationInventory.listItems(String(source.waterCode), true)[0]!;
    destinationInventory.issue(water.id, 1, 'future issue');
    const loan = destinationInventory.listLoans().find((entry) => entry.code === source.tentCode)!;
    destinationInventory.markLost(loan.checkoutId, 1, false, 'found');
    const restoredLoan = destinationInventory
      .listLoans()
      .find((entry) => entry.checkoutId === loan.checkoutId)!;
    destinationInventory.returnCheckout(restoredLoan.checkoutId, restoredLoan.outstanding, 0);
    const tent = destinationInventory.listItems(String(source.tentCode), true)[0]!;
    destinationInventory.resolveDamage(tent.id, 1, true, 'repaired after recovery');
    expect(destinationInventory.listLoans()).toEqual([]);
    expect(destinationInventory.listItems(String(source.waterCode), true)[0]!.available).toBe(84);
    source.db.close();
    destination.close();
  });

  it('ignores reset edits and rejects incomplete or inconsistent recovery payloads', async () => {
    const source = sourceFixture();
    const original = await exportWorkbook(source.transfers.snapshot());

    const resetEdited = await workbook(original);
    resetEdited.getWorksheet(WORKBOOK_CONTRACT.sheets.resetItems.name)!.getRow(2).getCell(8).value =
      999_999;
    const parsed = await parseRecoveryWorkbook(await save(resetEdited));
    expect(parsed.items.find((item) => item.code === source.waterCode)?.startingStock).toBe(100);

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
    await expect(parseRecoveryWorkbook(await save(missingCode))).rejects.toThrow(/Item Code/);

    const brokenBaseline = await workbook(original);
    brokenBaseline
      .getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryItems.name)!
      .getRow(2)
      .getCell(9).value = 101;
    await expect(parseRecoveryWorkbook(await save(brokenBaseline))).rejects.toThrow(
      /Starting Stock does not match/,
    );

    const brokenReference = await workbook(original);
    const eventSheet = brokenReference.getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryEvents.name)!;
    const checkoutRow = eventSheet
      .getRows(2, eventSheet.rowCount - 1)!
      .find((row) => row.getCell(2).value === 'returned_damaged')!;
    checkoutRow.getCell(6).value = 999_999;
    await expect(parseRecoveryWorkbook(await save(brokenReference))).rejects.toThrow(
      /missing or invalid checkout/,
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

  it('rolls back the destination when recovery commit fails', async () => {
    const source = sourceFixture();
    const payload = await parseRecoveryWorkbook(await exportWorkbook(source.transfers.snapshot()));
    const destination = database('recovery-rollback');
    const inventory = new InventoryService(destination);
    const transfers = new InventoryTransferService(destination);
    const old = inventory.createItem({ name: 'Keep me', kind: 'consumable' });
    inventory.addStock(old.id, 3);
    const before = transfers.snapshot();
    destination.exec(`CREATE TRIGGER reject_recovered_event BEFORE INSERT ON inventory_events
      BEGIN SELECT RAISE(ABORT, 'forced recovery failure'); END;`);

    expect(() => transfers.replaceWithRecovery(payload)).toThrow(/forced recovery failure/);
    expect(transfers.snapshot()).toEqual(before);
    expect(destination.prepare('SELECT enabled FROM inventory_replacement_guard').get()).toEqual({
      enabled: 0,
    });
    source.db.close();
    destination.close();
  });
});
