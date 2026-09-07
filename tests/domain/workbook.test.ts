import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import {
  InventoryTransferService,
  type InventoryTransferSnapshot,
} from '../../src/domain/import-export.js';
import { InventoryService } from '../../src/domain/inventory.js';
import { WORKBOOK_CONTRACT } from '../../src/io/workbook-contract.js';
import {
  exportWorkbook,
  parseRecoveryWorkbook,
  parseResetWorkbook,
} from '../../src/io/workbook.js';
import { recordHistoricalStockRemoval } from '../helpers/historical-events.js';

async function load(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  );
  return workbook;
}

async function save(workbook: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const emptySnapshot: InventoryTransferSnapshot = {
  locations: [],
  items: [],
  borrowers: [],
  events: [],
};

describe('inventory XLSX workbook', () => {
  it('round-trips camp equipment through reset and recovery workbooks', async () => {
    const db = openDatabase(':memory:');
    const transfers = new InventoryTransferService(db);
    transfers.replaceWithReset({
      locations: [{ name: 'Main', archived: false }],
      items: [
        {
          code: 100,
          name: 'Permanent table',
          kind: 'camp_equipment',
          location: 'Main',
          aliases: ['Table'],
          lotSize: null,
          archived: false,
          total: 6,
        },
      ],
    });
    const item = new InventoryService(db).listItems('Permanent')[0]!;
    recordHistoricalStockRemoval(db, item.id, 1, 'historical count correction');
    const snapshot = transfers.snapshot();
    const exported = await exportWorkbook(snapshot);

    await expect(parseResetWorkbook(exported)).resolves.toEqual({
      locations: [{ name: 'Main', archived: false }],
      items: [
        {
          code: 100,
          name: 'Permanent table',
          kind: 'camp_equipment',
          location: 'Main',
          aliases: ['Table'],
          lotSize: null,
          archived: false,
          total: 5,
        },
      ],
    });
    const recovery = await parseRecoveryWorkbook(exported);
    const destination = openDatabase(':memory:');
    new InventoryTransferService(destination).replaceWithRecovery(recovery);
    expect(new InventoryTransferService(destination).snapshot()).toEqual(snapshot);

    const impossibleIssue = await load(exported);
    impossibleIssue
      .getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryEvents.name)!
      .getRow(2)
      .getCell(2).value = 'issued';
    await expect(parseRecoveryWorkbook(await save(impossibleIssue))).rejects.toThrow(
      /not consumable/,
    );
    const impossibleCheckout = await load(exported);
    impossibleCheckout
      .getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryEvents.name)!
      .getRow(2)
      .getCell(2).value = 'checked_out';
    await expect(parseRecoveryWorkbook(await save(impossibleCheckout))).rejects.toThrow(
      /not borrowable/,
    );
    const invalidLot = await load(exported);
    invalidLot
      .getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryItems.name)!
      .getRow(2)
      .getCell(6).value = 2;
    await expect(parseRecoveryWorkbook(await save(invalidLot))).rejects.toThrow(/not consumable/);
    db.close();
    destination.close();
  });

  it('exports the fixed reset/recovery structure and state-complete mixed inventory without secrets', async () => {
    const db = openDatabase(':memory:');
    const transfers = new InventoryTransferService(db);
    transfers.replaceWithReset({
      locations: [
        { name: 'מחסן ראשי', archived: false },
        { name: 'מחסן ישן', archived: true },
      ],
      items: [
        {
          code: 7,
          name: 'מים',
          kind: 'consumable',
          location: 'מחסן ראשי',
          aliases: ['Water'],
          lotSize: 12,
          archived: false,
          total: 100,
        },
        {
          code: 101,
          name: 'אוהל',
          kind: 'non_consumable',
          location: 'מחסן ישן',
          aliases: ['Tent'],
          lotSize: null,
          archived: false,
          total: 10,
        },
        {
          code: 102,
          name: 'ישן',
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
    const water = inventory.listItems('מים', true)[0]!;
    const tent = inventory.listItems('אוהל', true)[0]!;
    inventory.addStock(water.id, 20, 'receipt');
    inventory.issue(water.id, 30, 'issued');
    recordHistoricalStockRemoval(db, water.id, 5, 'historical correction');
    const borrower = inventory.createBorrower({
      username: 'camp-a',
      name: 'מחנה א',
      contact: '050',
      type: 'camp_organization',
    });
    const checkout = inventory.checkout(tent.id, borrower.id, 5, 'loan');
    inventory.markLost(checkout, 1, true, 'lost');
    inventory.returnCheckout(checkout, 0, 1, 'damaged');

    const snapshot = transfers.snapshot();
    expect(snapshot.items.find((item) => item.code === 7)).toMatchObject({
      startingStock: 100,
      resetTotal: 85,
    });
    expect(snapshot.items.find((item) => item.code === 101)).toMatchObject({ resetTotal: 10 });
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      'stock_added',
      'stock_added',
      'stock_added',
      'issued',
      'stock_removed',
      'checked_out',
      'marked_lost',
      'returned_damaged',
    ]);

    const workbook = await load(await exportWorkbook(snapshot));
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(
      Object.values(WORKBOOK_CONTRACT.sheets).map((sheet) => sheet.name),
    );
    for (const definition of Object.values(WORKBOOK_CONTRACT.sheets)) {
      expect(
        Array.from(
          { length: definition.columns.length },
          (_, index) =>
            workbook
              .getWorksheet(definition.name)!
              .getRow(1)
              .getCell(index + 1).value,
        ),
      ).toEqual([...definition.columns]);
    }
    const resetItems = workbook.getWorksheet(WORKBOOK_CONTRACT.sheets.resetItems.name)!;
    expect((resetItems.getRow(2).values as unknown[]).slice(1)).toEqual([
      7,
      'מים',
      'consumable',
      'מחסן ראשי',
      '["Water"]',
      12,
      false,
      85,
    ]);
    const serialized = workbook.worksheets
      .flatMap((sheet) => sheet.getSheetValues())
      .join(' ')
      .toLowerCase();
    expect(serialized).not.toContain('credential');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('admin-pass');
    expect(serialized).not.toContain('operator-pass');
    db.close();
  });

  it('parses only reset sheets, applies blank defaults, preserves low codes, and avoids generated collisions', async () => {
    const workbook = await load(await exportWorkbook(emptySnapshot));
    const locations = workbook.getWorksheet(WORKBOOK_CONTRACT.sheets.resetLocations.name)!;
    locations.addRow(['North', '']);
    const items = workbook.getWorksheet(WORKBOOK_CONTRACT.sheets.resetItems.name)!;
    items.addRow([100, 'Explicit', 'consumable', 'North', '', '', '', 0]);
    items.addRow(['', 'Generated', 'non_consumable', '', '', '', '', 3]);
    items.addRow([4, 'Low', 'consumable', '', '["alias"]', 5, true, 2]);
    workbook.removeWorksheet(
      workbook.getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryItems.name)!.id,
    );

    await expect(parseResetWorkbook(await save(workbook))).resolves.toEqual({
      locations: [{ name: 'North', archived: false }],
      items: [
        {
          code: 100,
          name: 'Explicit',
          kind: 'consumable',
          location: 'North',
          aliases: [],
          lotSize: null,
          archived: false,
          total: 0,
        },
        {
          code: 101,
          name: 'Generated',
          kind: 'non_consumable',
          location: null,
          aliases: [],
          lotSize: null,
          archived: false,
          total: 3,
        },
        {
          code: 4,
          name: 'Low',
          kind: 'consumable',
          location: null,
          aliases: ['alias'],
          lotSize: 5,
          archived: true,
          total: 2,
        },
      ],
    });
  });

  it.each([
    [
      'duplicate codes',
      [8, 'One', 'consumable', '', '', '', '', 1],
      [8, 'Two', 'consumable', '', '', '', '', 1],
    ],
    ['blank total', [8, 'One', 'consumable', '', '', '', '', ''], null],
    ['invalid explicit archive', [8, 'One', 'consumable', '', '', '', 'maybe', 1], null],
    ['unknown location', [8, 'One', 'consumable', 'Missing', '', '', '', 1], null],
    ['invalid non-consumable lot', [8, 'One', 'non_consumable', '', '', 2, '', 1], null],
    ['duplicate aliases', [8, 'One', 'consumable', '', '["Alias","alias"]', '', '', 1], null],
  ])('rejects %s before producing a reset payload', async (_name, first, second) => {
    const workbook = await load(await exportWorkbook(emptySnapshot));
    const items = workbook.getWorksheet(WORKBOOK_CONTRACT.sheets.resetItems.name)!;
    items.addRow(first!);
    if (second) items.addRow(second);
    await expect(parseResetWorkbook(await save(workbook))).rejects.toMatchObject({
      code: 'invalid_workbook',
    });
  });

  it('rejects missing sheets and altered column contracts with legible errors', async () => {
    const missing = await load(await exportWorkbook(emptySnapshot));
    missing.removeWorksheet(missing.getWorksheet(WORKBOOK_CONTRACT.sheets.resetLocations.name)!.id);
    await expect(parseResetWorkbook(await save(missing))).rejects.toThrow(/Missing required sheet/);

    const altered = await load(await exportWorkbook(emptySnapshot));
    altered.getWorksheet(WORKBOOK_CONTRACT.sheets.resetItems.name)!.getRow(1).getCell(9).value =
      'Unexpected';
    await expect(parseResetWorkbook(await save(altered))).rejects.toThrow(/exact exported columns/);
  });

  it('accepts trailing styled blank columns added by Apple Numbers', async () => {
    const workbook = await load(await exportWorkbook(emptySnapshot));
    const locations = workbook.getWorksheet(WORKBOOK_CONTRACT.sheets.resetLocations.name)!;
    locations.addRow(['North', false]);
    locations.getRow(1).getCell(5).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFFFFF' },
    };
    const items = workbook.getWorksheet(WORKBOOK_CONTRACT.sheets.resetItems.name)!;
    items.addRow([1, 'Edited in Numbers', 'consumable', 'North', '', '', '', 17]);

    const numbersRoundTrip = await save(await load(await save(workbook)));
    await expect(parseResetWorkbook(numbersRoundTrip)).resolves.toMatchObject({
      locations: [{ name: 'North', archived: false }],
      items: [{ code: 1, name: 'Edited in Numbers', total: 17 }],
    });
  });

  it('atomically replaces only inventory-domain data and rolls back a commit failure', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const transfers = new InventoryTransferService(db);
    const old = inventory.createItem({ name: 'Old', kind: 'consumable' });
    inventory.addStock(old.id, 9);
    const credentialsBefore = db
      .prepare('SELECT role,salt,password_hash,updated_at FROM credentials ORDER BY role')
      .all();
    const payload = {
      locations: [{ name: 'Named Location', archived: false }],
      items: [
        {
          code: 5,
          name: 'New',
          kind: 'consumable' as const,
          location: 'Named Location',
          aliases: [],
          lotSize: null,
          archived: false,
          total: 6,
        },
      ],
    };
    transfers.replaceWithReset(payload);
    expect(inventory.listItems('', true)[0]).toMatchObject({ code: 5, name: 'New', available: 6 });
    expect(inventory.listLedger()).toHaveLength(1);
    expect(transfers.snapshot().items[0]).toMatchObject({ startingStock: 6, resetTotal: 6 });
    expect(
      db.prepare('SELECT role,salt,password_hash,updated_at FROM credentials ORDER BY role').all(),
    ).toEqual(credentialsBefore);

    db.exec(`CREATE TRIGGER reject_reset_baseline BEFORE INSERT ON inventory_baselines
      BEGIN SELECT RAISE(ABORT, 'test commit failure'); END;`);
    expect(() =>
      transfers.replaceWithReset({ ...payload, items: [{ ...payload.items[0]!, name: 'Broken' }] }),
    ).toThrow(/test commit failure/);
    expect(inventory.listItems('', true)[0]).toMatchObject({ name: 'New', available: 6 });
    expect(db.prepare('SELECT enabled FROM inventory_replacement_guard').get()).toMatchObject({
      enabled: 0,
    });
    db.close();
  });
});
