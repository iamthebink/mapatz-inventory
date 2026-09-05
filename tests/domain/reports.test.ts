import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import {
  consumablesUsageReport,
  InventoryTransferService,
  unresolvedDamageReport,
} from '../../src/domain/import-export.js';
import { InventoryService } from '../../src/domain/inventory.js';
import { WORKBOOK_CONTRACT } from '../../src/io/workbook-contract.js';
import {
  exportWorkbook,
  parseRecoveryWorkbook,
  parseResetWorkbook,
} from '../../src/io/workbook.js';

async function load(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  );
  return workbook;
}

describe('inventory workbook reports', () => {
  it('exports only unresolved damage and reconciles it with recovery events', async () => {
    const db = openDatabase(':memory:');
    const transfers = new InventoryTransferService(db);
    transfers.replaceWithReset({
      locations: [{ name: 'Workshop', archived: false }],
      items: [
        {
          code: 201,
          name: 'Still damaged',
          kind: 'non_consumable',
          location: 'Workshop',
          aliases: [],
          lotSize: null,
          archived: false,
          total: 3,
        },
        {
          code: 202,
          name: 'Repaired',
          kind: 'non_consumable',
          location: 'Workshop',
          aliases: [],
          lotSize: null,
          archived: false,
          total: 2,
        },
        {
          code: 203,
          name: 'Written off',
          kind: 'non_consumable',
          location: null,
          aliases: [],
          lotSize: null,
          archived: false,
          total: 2,
        },
      ],
    });
    const inventory = new InventoryService(db);
    const borrower = inventory.createBorrower({
      username: 'field-team',
      name: 'Field Team',
      type: 'other',
    });
    const items = inventory.listItems('', true);
    for (const item of items) {
      const checkout = inventory.checkout(item.id, borrower.id, 2);
      inventory.returnCheckout(checkout, 0, 2);
      if (item.code === 201) inventory.resolveDamage(item.id, 1, true);
      if (item.code === 202) inventory.resolveDamage(item.id, 2, true);
      if (item.code === 203) inventory.resolveDamage(item.id, 2, false);
    }

    const snapshot = transfers.snapshot();
    expect(unresolvedDamageReport(snapshot)).toEqual([
      {
        itemCode: 201,
        itemName: 'Still damaged',
        location: 'Workshop',
        unresolvedDamagedQuantity: 1,
      },
    ]);
    const workbook = await load(await exportWorkbook(snapshot));
    const reportSheet = workbook.getWorksheet(WORKBOOK_CONTRACT.sheets.unresolvedDamage.name)!;
    expect((reportSheet.getRow(2).values as unknown[]).slice(1)).toEqual([
      201,
      'Still damaged',
      'Workshop',
      1,
    ]);
    expect(reportSheet.rowCount).toBe(2);

    const recoveryEvents = workbook.getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryEvents.name)!;
    const unresolvedFromRecovery = new Map<number, number>();
    for (const row of recoveryEvents.getRows(2, recoveryEvents.rowCount - 1) ?? []) {
      const kind = row.getCell(2).value;
      const code = Number(row.getCell(3).value);
      const quantity = Number(row.getCell(5).value);
      if (kind === 'returned_damaged')
        unresolvedFromRecovery.set(code, (unresolvedFromRecovery.get(code) ?? 0) + quantity);
      if (kind === 'repaired' || kind === 'written_off')
        unresolvedFromRecovery.set(code, (unresolvedFromRecovery.get(code) ?? 0) - quantity);
    }
    expect([...unresolvedFromRecovery.entries()].filter(([, quantity]) => quantity > 0)).toEqual([
      [201, 1],
    ]);
    db.close();
  });

  it('reports consumable usage and preserves or rebases the cycle by import mode', async () => {
    const source = openDatabase(':memory:');
    const sourceTransfers = new InventoryTransferService(source);
    sourceTransfers.replaceWithReset({
      locations: [{ name: 'Stores', archived: false }],
      items: [
        {
          code: 100,
          name: 'Correction example',
          kind: 'consumable',
          location: 'Stores',
          aliases: [],
          lotSize: 10,
          archived: false,
          total: 100,
        },
        {
          code: 101,
          name: 'Planning example',
          kind: 'consumable',
          location: null,
          aliases: [],
          lotSize: null,
          archived: false,
          total: 100,
        },
        {
          code: 102,
          name: 'Archived zero stock',
          kind: 'consumable',
          location: 'Stores',
          aliases: [],
          lotSize: null,
          archived: true,
          total: 0,
        },
      ],
    });
    const inventory = new InventoryService(source);
    const correction = inventory.listItems('Correction example', true)[0]!;
    const planning = inventory.listItems('Planning example', true)[0]!;
    inventory.addStock(correction.id, 20);
    inventory.issue(correction.id, 30);
    inventory.removeStock(correction.id, 5);
    inventory.addStock(planning.id, 20);

    const snapshot = sourceTransfers.snapshot();
    expect(consumablesUsageReport(snapshot)).toEqual([
      {
        itemCode: 100,
        itemName: 'Correction example',
        location: 'Stores',
        startOfCycleStock: 100,
        addedDuringCycle: 20,
        usage: 30,
        left: 85,
      },
      {
        itemCode: 101,
        itemName: 'Planning example',
        location: null,
        startOfCycleStock: 100,
        addedDuringCycle: 20,
        usage: 0,
        left: 120,
      },
      {
        itemCode: 102,
        itemName: 'Archived zero stock',
        location: 'Stores',
        startOfCycleStock: 0,
        addedDuringCycle: 0,
        usage: 0,
        left: 0,
      },
    ]);

    const exported = await exportWorkbook(snapshot);
    const workbook = await load(exported);
    const reportSheet = workbook.getWorksheet(WORKBOOK_CONTRACT.sheets.consumablesUsage.name)!;
    expect((reportSheet.getRow(2).values as unknown[]).slice(1)).toEqual([
      100,
      'Correction example',
      'Stores',
      100,
      20,
      30,
      85,
    ]);
    expect(reportSheet.rowCount).toBe(4);

    const recovered = openDatabase(':memory:');
    const recoveredTransfers = new InventoryTransferService(recovered);
    recoveredTransfers.replaceWithRecovery(await parseRecoveryWorkbook(exported));
    expect(consumablesUsageReport(recoveredTransfers.snapshot())).toEqual(
      consumablesUsageReport(snapshot),
    );

    const reset = openDatabase(':memory:');
    const resetTransfers = new InventoryTransferService(reset);
    resetTransfers.replaceWithReset(await parseResetWorkbook(exported));
    expect(consumablesUsageReport(resetTransfers.snapshot())).toEqual([
      expect.objectContaining({
        itemCode: 100,
        startOfCycleStock: 85,
        addedDuringCycle: 0,
        usage: 0,
        left: 85,
      }),
      expect.objectContaining({
        itemCode: 101,
        startOfCycleStock: 120,
        addedDuringCycle: 0,
        usage: 0,
        left: 120,
      }),
      expect.objectContaining({
        itemCode: 102,
        startOfCycleStock: 0,
        addedDuringCycle: 0,
        usage: 0,
        left: 0,
      }),
    ]);
    source.close();
    recovered.close();
    reset.close();
  });
});
