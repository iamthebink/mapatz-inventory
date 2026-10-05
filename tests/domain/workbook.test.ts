import { transferBusinessState } from '../helpers/transfer-business-state.js';
import { foundReturned } from '../helpers/found-returned.js';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import {
  InventoryTransferService,
  type InventoryTransferSnapshot,
  validateRecoveryPayload,
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
function expectRecoveredState(
  actual: InventoryTransferSnapshot,
  expected: InventoryTransferSnapshot,
) {
  const { identityHighWater: actualHighWater } = actual;
  const { identityHighWater: expectedHighWater } = expected;
  expect(transferBusinessState(actual)).toEqual(transferBusinessState(expected));
  for (const field of Object.keys(expectedHighWater) as Array<keyof typeof expectedHighWater>)
    expect(actualHighWater[field]).toBeGreaterThanOrEqual(expectedHighWater[field]);
}
const emptySnapshot: InventoryTransferSnapshot = {
  radioCount: 0,
  radios: [],
  locations: [],
  items: [],
  borrowers: [],
  events: [],
  loans: [],
  stateRevision: 0,
  identityHighWater: {
    nextItemId: 1,
    nextBorrowerId: 1,
    nextLocationId: 1,
    nextEventId: 1,
  },
};
describe('inventory XLSX workbook', () => {
  it('accepts genuinely empty optional recovery borrower cells', async () => {
    const snapshot: InventoryTransferSnapshot = {
      ...emptySnapshot,
      borrowers: [
        {
          id: 1,
          fullName: 'Ada',
          playaName: '',
          phoneNumber: '',
          campDepartment: '',
          archived: false,
          createdAt: '2026-01-01 00:00:00',
        },
      ],
      identityHighWater: { ...emptySnapshot.identityHighWater, nextBorrowerId: 2 },
    };
    const workbook = await load(
      await exportWorkbook(snapshot, snapshot.locations.find((l) => !l.archived)?.name),
    );
    const sheet = workbook.getWorksheet('Recovery Borrowers')!;
    for (const column of [2, 4, 5]) sheet.getRow(2).getCell(column).value = null;
    expect((await parseRecoveryWorkbook(await save(workbook))).borrowers).toEqual(
      snapshot.borrowers,
    );
    sheet.getRow(2).getCell(3).value = null;
    await expect(parseRecoveryWorkbook(await save(workbook))).rejects.toThrow();
  });
  it('requires exactly four positive safe identity high-water fields in recovery payloads', () => {
    const valid = structuredClone(emptySnapshot);
    expect(validateRecoveryPayload(valid)).toEqual(valid);
    const malformed = [
      {
        ...valid,
        identityHighWater: {
          nextItemId: 1,
          nextBorrowerId: 1,
          nextLocationId: 1,
        },
      },
      {
        ...valid,
        identityHighWater: { ...valid.identityHighWater, nextEventId: 1, unexpected: 1 },
      },
      {
        ...valid,
        identityHighWater: { ...valid.identityHighWater, nextEventId: 0 },
      },
      {
        ...valid,
        identityHighWater: {
          ...valid.identityHighWater,
          nextEventId: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    ];
    for (const payload of malformed)
      expect(() => validateRecoveryPayload(payload as never)).toThrow(
        expect.objectContaining({ code: 'invalid_workbook' }),
      );
  });
  it('normalizes accepted offset timestamps before storing a recovery ledger and summarizing Israel days', async () => {
    const exported = await exportWorkbook(
      {
        radioCount: 0,
        radios: [],
        locations: [{ name: 'Main', archived: false, isDefault: false }],
        items: [
          {
            id: 100,
            name: 'Boundary chairs',
            kind: 'non_consumable',
            location: 'Main',
            aliases: [],
            lotSize: null,
            archived: false,
            createdAt: '2026-09-20T17:00:00+03:00',
            startingStock: 0,
            baselineThroughEventId: 0,
            available: 0,
            borrowed: 3,
            damaged: 0,
            lost: 0,
            revision: 3,
            resetTotal: 0,
          },
        ],
        borrowers: [
          {
            id: 1,
            playaName: 'boundary',
            fullName: 'Boundary borrower',
            phoneNumber: '',
            campDepartment: '',
            archived: false,
            createdAt: '2026-09-20T17:00:00+03:00',
          },
        ],
        events: [
          {
            id: 1,
            kind: 'stock_added',
            itemId: 100,
            borrowerId: null,
            quantity: 3,
            relatedEventId: null,
            note: '',
            createdAt: '2026-09-20T18:00:00+03:00',
            locationName: '\u05DE\u05E4\u05DC\u05E6\u05EA',
            locationCode: 'monster',
          },
          {
            id: 2,
            kind: 'checked_out',
            itemId: 100,
            borrowerId: 1,
            quantity: 1,
            relatedEventId: null,
            note: '',
            createdAt: '2026-09-20T23:59:59.999+03:00',
            locationName: '\u05DE\u05E4\u05DC\u05E6\u05EA',
            locationCode: 'monster',
          },
          {
            id: 3,
            kind: 'checked_out',
            itemId: 100,
            borrowerId: 1,
            quantity: 2,
            relatedEventId: null,
            note: '',
            createdAt: '2026-09-21T00:00:00+03:00',
            locationName: '\u05DE\u05E4\u05DC\u05E6\u05EA',
            locationCode: 'monster',
          },
        ],
        loans: [
          {
            checkoutId: 2,
            itemId: 100,
            borrowerId: 1,
            quantity: 1,
            createdAt: '2026-09-20T23:59:59.999+03:00',
            outstanding: 1,
            lost: 0,
          },
          {
            checkoutId: 3,
            itemId: 100,
            borrowerId: 1,
            quantity: 2,
            createdAt: '2026-09-21T00:00:00+03:00',
            outstanding: 2,
            lost: 0,
          },
        ],
        stateRevision: 3,
        identityHighWater: {
          nextItemId: 2,
          nextBorrowerId: 2,
          nextLocationId: 1,
          nextEventId: 4,
        },
      },
      'Main',
    );
    const recovery = await parseRecoveryWorkbook(exported);
    const db = openDatabase(':memory:');
    try {
      new InventoryTransferService(db).replaceWithRecovery(recovery);
      expect(db.prepare("SELECT created_at FROM items WHERE name='Boundary chairs'").get()).toEqual(
        {
          created_at: '2026-09-20 14:00:00',
        },
      );
      expect(
        db.prepare("SELECT created_at FROM borrowers WHERE playa_name='boundary'").get(),
      ).toEqual({ created_at: '2026-09-20 14:00:00' });
      expect(db.prepare('SELECT created_at FROM inventory_events ORDER BY id').all()).toEqual([
        { created_at: '2026-09-20 15:00:00' },
        { created_at: '2026-09-20 20:59:59.999' },
        { created_at: '2026-09-20 21:00:00' },
      ]);
      expect(
        db
          .prepare(
            "SELECT established_at FROM inventory_baselines WHERE item_id=(SELECT id FROM items WHERE name='Boundary chairs')",
          )
          .get(),
      ).toEqual({ established_at: '2026-09-20 14:00:00' });
      const service = new InventoryService(db);
      const now = new Date('2026-09-24T12:00:00Z');
      expect(service.periodSummary('2026-09-20', '2026-09-20', now).borrowers[0]?.total).toBe(1);
      expect(service.periodSummary('2026-09-21', '2026-09-21', now).borrowers[0]?.total).toBe(2);
    } finally {
      db.close();
    }
  });
  it('round-trips camp equipment through reset and recovery workbooks', async () => {
    const db = openDatabase(':memory:');
    const transfers = new InventoryTransferService(db);
    transfers.replaceWithReset({
      locations: [{ name: 'Main', archived: false, isDefault: false }],
      items: [
        {
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
    const exported = await exportWorkbook(
      snapshot,
      snapshot.locations.find((l) => !l.archived)?.name,
    );
    await expect(parseResetWorkbook(exported)).resolves.toEqual({
      locations: [{ name: 'Main', archived: false, isDefault: false }],
      items: [
        {
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
    const recovery = await parseRecoveryWorkbook(exported);
    const destination = openDatabase(':memory:');
    new InventoryTransferService(destination).replaceWithRecovery(recovery);
    expectRecoveredState(new InventoryTransferService(destination).snapshot(), snapshot);
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
      /invalid item, borrower, or related event/,
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
        { name: 'מחסן ראשי', archived: false, isDefault: false },
        { name: 'מחסן ישן', archived: true, isDefault: false },
      ],
      items: [
        {
          name: 'מים',
          kind: 'consumable',
          location: 'מחסן ראשי',
          aliases: ['Water'],
          lotSize: 12,
          archived: false,
          total: 100,
        },
        {
          name: 'אוהל',
          kind: 'non_consumable',
          location: 'מחסן ראשי',
          aliases: ['Tent'],
          lotSize: null,
          archived: false,
          total: 10,
        },
        {
          name: 'ישן',
          kind: 'consumable',
          location: 'מחסן ראשי',
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
    inventory.addStock(
      water.id,
      20,
      'receipt',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.issue(
      water.id,
      30,
      'issued',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    recordHistoricalStockRemoval(db, water.id, 5, 'historical correction');
    const borrower = inventory.createBorrower({
      playaName: 'camp-a',
      fullName: 'מחנה א',
      phoneNumber: '050',
      campDepartment: 'מחנה א',
    });
    const checkout = inventory.checkout(
      tent.id,
      borrower.id,
      5,
      'loan',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    inventory.markLost(checkout, 2, true, 'lost');
    inventory.returnCheckout(
      checkout,
      0,
      1,
      'damaged',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    foundReturned(inventory, checkout, 1);
    expect(
      inventory.commitBorrowerOperations(borrower.id, '00000000-0000-4000-8000-000000000027', {
        contractVersion: 1,
        ledgerEpoch: 2,
        items: [
          {
            itemId: tent.id,
            lostCredit: [
              {
                quantity: 1,
                condition: 'damaged',
                note: 'found broken',
                locationId: inventory.listItems('', true).find((item) => item.id === tent.id)!
                  .balances[0]!.locationId,
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ outcome: 'committed' });
    db.prepare(
      `INSERT INTO idempotency_receipts(
        key,command_kind,ledger_epoch,contract_version,request_hash,outcome,subject_id,result_json
      ) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      'never-export-this-receipt',
      'borrower_operation',
      2,
      1,
      'hash',
      'committed',
      borrower.id,
      '{}',
    );
    const snapshot = transfers.snapshot();
    expect(snapshot).not.toHaveProperty('ledgerEpoch');
    expect(snapshot).not.toHaveProperty('receipts');
    expect(snapshot.items.find((item) => item.name === 'מים')).toMatchObject({
      startingStock: 100,
      resetTotal: 90,
    });
    expect(snapshot.items.find((item) => item.name === 'אוהל')).toMatchObject({ resetTotal: 10 });
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      'stock_added',
      'stock_added',
      'stock_added',
      'issued',
      'stock_removed',
      'checked_out',
      'marked_lost',
      'returned_damaged',
      'found_returned',
      'found_returned_damaged',
    ]);
    const workbook = await load(
      await exportWorkbook(snapshot, snapshot.locations.find((l) => !l.archived)?.name),
    );
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
    expect((resetItems.getRow(4).values as unknown[]).slice(1)).toEqual([
      'מים',
      'consumable',
      'מחסן ראשי',
      '["Water"]',
      12,
      false,
      90,
    ]);
    const serialized = workbook.worksheets
      .flatMap((sheet) => sheet.getSheetValues())
      .join(' ')
      .toLowerCase();
    expect(serialized).not.toContain('credential');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('admin-pass');
    expect(serialized).not.toContain('operator-pass');
    expect(serialized).not.toContain('never-export-this-receipt');
    db.close();
  });
  it('parses identity-free reset sheets and applies blank defaults', async () => {
    const workbook = await load(await exportWorkbook(emptySnapshot));
    const locations = workbook.getWorksheet(WORKBOOK_CONTRACT.sheets.resetLocations.name)!;
    locations.addRow(['North', '']);
    const items = workbook.getWorksheet(WORKBOOK_CONTRACT.sheets.resetItems.name)!;
    items.addRow(['Explicit', 'consumable', 'North', '', '', '', 0]);
    items.addRow(['Generated', 'non_consumable', 'North', '', '', '', 3]);
    items.addRow(['Low', 'consumable', 'North', '["alias"]', 5, true, 0]);
    workbook.removeWorksheet(
      workbook.getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryItems.name)!.id,
    );
    await expect(parseResetWorkbook(await save(workbook))).resolves.toEqual({
      locations: [{ name: 'North', archived: false, isDefault: false }],
      items: [
        {
          name: 'Explicit',
          kind: 'consumable',
          location: 'North',
          aliases: [],
          lotSize: null,
          archived: false,
          total: 0,
        },
        {
          name: 'Generated',
          kind: 'non_consumable',
          location: 'North',
          aliases: [],
          lotSize: null,
          archived: false,
          total: 3,
        },
        {
          name: 'Low',
          kind: 'consumable',
          location: 'North',
          aliases: ['alias'],
          lotSize: 5,
          archived: true,
          total: 0,
        },
      ],
    });
  });
  it.each([
    [
      'duplicate names',
      ['Duplicate', 'consumable', '', '', '', '', 1],
      [' duplicate ', 'non_consumable', '', '', '', '', 1],
    ],
    ['blank total', ['One', 'consumable', '', '', '', '', ''], null],
    ['invalid explicit archive', ['One', 'consumable', '', '', '', 'maybe', 1], null],
    ['unknown location', ['One', 'consumable', 'Missing', '', '', '', 1], null],
    ['invalid non-consumable lot', ['One', 'non_consumable', '', '', 2, '', 1], null],
    ['duplicate aliases', ['One', 'consumable', '', '["Alias","alias"]', '', '', 1], null],
  ])('rejects %s before producing a reset payload', async (_name, first, second) => {
    const workbook = await load(await exportWorkbook(emptySnapshot));
    const items = workbook.getWorksheet(WORKBOOK_CONTRACT.sheets.resetItems.name)!;
    items.addRow(first!);
    if (second) items.addRow(second);
    await expect(parseResetWorkbook(await save(workbook))).rejects.toMatchObject({
      code: 'invalid_workbook',
    });
  });
  it('rejects reset items assigned to an archived location', async () => {
    const workbook = await load(
      await exportWorkbook({
        ...emptySnapshot,
        locations: [{ name: 'Old storage', archived: true, isDefault: false }],
      }),
    );
    workbook
      .getWorksheet(WORKBOOK_CONTRACT.sheets.resetItems.name)!
      .addRow(['Archived location item', 'consumable', 'Old storage', '', '', '', 0]);
    await expect(parseResetWorkbook(await save(workbook))).rejects.toMatchObject({
      code: 'invalid_workbook',
      message: expect.stringContaining('archived location'),
    });
  });
  it('rejects case-insensitive duplicate item names in recovery workbooks', async () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    inventory.createItem({
      name: 'Récovery item',
      kind: 'consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    const workbook = await load(await exportWorkbook(new InventoryTransferService(db).snapshot()));
    const items = workbook.getWorksheet(WORKBOOK_CONTRACT.sheets.recoveryItems.name)!;
    const duplicate = [...(items.getRow(2).values as unknown[])];
    duplicate[1] = 101;
    duplicate[2] = ' RE\u0301COVERY ITEM ';
    items.addRow(duplicate.slice(1));
    await expect(parseRecoveryWorkbook(await save(workbook))).rejects.toMatchObject({
      code: 'invalid_workbook',
      message: expect.stringContaining('duplicate Name'),
    });
    db.close();
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
    items.addRow(['Edited in Numbers', 'consumable', 'North', '', '', '', 17]);
    const numbersRoundTrip = await save(await load(await save(workbook)));
    await expect(parseResetWorkbook(numbersRoundTrip)).resolves.toMatchObject({
      locations: [{ name: 'North', archived: false, isDefault: false }],
      items: [{ name: 'Edited in Numbers', total: 17 }],
    });
  });
  it('atomically replaces only inventory-domain data and rolls back a commit failure', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const transfers = new InventoryTransferService(db);
    const old = inventory.createItem({
      name: 'Old',
      kind: 'consumable',
      locationId: Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    });
    inventory.addStock(
      old.id,
      9,
      '',
      Number(
        (inventory.listLocations().find((l) => l.code === 'monster') ??
          inventory.listLocations()[0])!.id,
      ),
    );
    const credentialsBefore = db
      .prepare('SELECT role,salt,password_hash,updated_at FROM credentials ORDER BY role')
      .all();
    db.prepare(
      `INSERT INTO idempotency_receipts(
        key,command_kind,ledger_epoch,contract_version,request_hash,outcome,subject_id,result_json
      ) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('obsolete-reset', 'borrower_operation', 1, 1, 'hash', 'committed', 1, '{}');
    const payload = {
      locations: [{ name: 'Named Location', archived: false, isDefault: false }],
      items: [
        {
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
    expect(inventory.listItems('', true)[0]).toMatchObject({ name: 'New', available: 6 });
    expect(inventory.listLedger()).toHaveLength(1);
    expect(transfers.snapshot().items[0]).toMatchObject({ startingStock: 6, resetTotal: 6 });
    expect(
      db.prepare('SELECT enabled,ledger_epoch FROM inventory_replacement_guard').get(),
    ).toEqual({
      enabled: 0,
      ledger_epoch: 2,
    });
    expect(db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual({
      count: 0,
    });
    expect(
      db.prepare('SELECT role,salt,password_hash,updated_at FROM credentials ORDER BY role').all(),
    ).toEqual(credentialsBefore);
    db.prepare(
      `INSERT INTO idempotency_receipts(
        key,command_kind,ledger_epoch,contract_version,request_hash,outcome,subject_id,result_json
      ) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('obsolete-second-reset', 'borrower_operation', 2, 1, 'hash', 'committed', 1, '{}');
    transfers.replaceWithReset(payload);
    expect(
      db.prepare('SELECT enabled,ledger_epoch FROM inventory_replacement_guard').get(),
    ).toEqual({
      enabled: 0,
      ledger_epoch: 3,
    });
    expect(db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual({
      count: 0,
    });
    db.prepare(
      `INSERT INTO idempotency_receipts(
        key,command_kind,ledger_epoch,contract_version,request_hash,outcome,subject_id,result_json
      ) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('preserved-reset', 'borrower_operation', 3, 1, 'hash', 'committed', 1, '{}');
    const beforeFailure = {
      snapshot: transfers.snapshot(),
      guard: db.prepare('SELECT enabled,ledger_epoch FROM inventory_replacement_guard').get(),
      receipts: db.prepare('SELECT * FROM idempotency_receipts').all(),
    };
    db.exec(`CREATE TRIGGER reject_reset_baseline BEFORE INSERT ON inventory_baselines
      BEGIN SELECT RAISE(ABORT, 'test commit failure'); END;`);
    expect(() =>
      transfers.replaceWithReset({ ...payload, items: [{ ...payload.items[0]!, name: 'Broken' }] }),
    ).toThrow(/test commit failure/);
    expect({
      snapshot: transfers.snapshot(),
      guard: db.prepare('SELECT enabled,ledger_epoch FROM inventory_replacement_guard').get(),
      receipts: db.prepare('SELECT * FROM idempotency_receipts').all(),
    }).toEqual(beforeFailure);
    db.close();
  });
});
