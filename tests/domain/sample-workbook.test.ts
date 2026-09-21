import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import {
  consumablesUsageReport,
  InventoryTransferService,
  unresolvedDamageReport,
} from '../../src/domain/import-export.js';
import { InventoryService } from '../../src/domain/inventory.js';
import { parseRecoveryWorkbook, parseResetWorkbook } from '../../src/io/workbook.js';

const samplePath = fileURLToPath(
  new URL('../../sample_data/mapatz-full-recovery-sample.xlsx', import.meta.url),
);

async function sampleWorkbook(): Promise<Buffer> {
  return readFile(samplePath);
}

describe('field-scale sample workbook', () => {
  it('fully recovers the authoritative business state', async () => {
    const payload = await parseRecoveryWorkbook(await sampleWorkbook());
    expect(payload).toMatchObject({
      locations: expect.arrayContaining([
        { name: 'צוללת', archived: false },
        { name: 'צהובה', archived: false },
        { name: 'מפלצת', archived: false },
      ]),
    });
    expect(payload.items).toHaveLength(72);
    expect(payload.borrowers).toHaveLength(12);
    expect(payload.events).toHaveLength(221);
    // Three deliberately authored histories each return one outstanding and recover one lost unit.
    for (const [checkout, recovered, ordinary] of [
      [135, 137, 138],
      [167, 169, 170],
      [199, 201, 202],
    ]) {
      expect(payload.events.find((event) => event.id === recovered)).toMatchObject({
        kind: 'found_returned',
        quantity: 1,
        relatedEventId: checkout,
      });
      expect(payload.events.find((event) => event.id === ordinary)).toMatchObject({
        kind: 'returned_usable',
        quantity: 1,
        relatedEventId: checkout,
      });
    }
    expect(
      payload.events
        .filter((event) => event.kind === 'found_returned')
        .reduce((sum, event) => sum + event.quantity, 0),
    ).toBe(3);

    const db = openDatabase(':memory:');
    const transfers = new InventoryTransferService(db);
    transfers.replaceWithRecovery(payload);
    const snapshot = transfers.snapshot();

    expect(snapshot.locations).toEqual(payload.locations);
    expect(snapshot.borrowers).toEqual(payload.borrowers);
    expect(snapshot.events).toEqual(payload.events);
    expect(new Set(snapshot.events.map((event) => event.kind))).toEqual(
      new Set([
        'stock_added',
        'stock_removed',
        'issued',
        'checked_out',
        'returned_usable',
        'returned_damaged',
        'marked_lost',
        'found_returned',
        'repaired',
        'written_off',
      ]),
    );
    expect(
      snapshot.items.map((item) => ({
        code: item.code,
        name: item.name,
        kind: item.kind,
        location: item.location,
        aliases: item.aliases,
        lotSize: item.lotSize,
        archived: item.archived,
        createdAt: item.createdAt,
        startingStock: item.startingStock,
        baselineThroughEventId: item.baselineThroughEventId,
      })),
    ).toEqual(payload.items);

    const inventory = new InventoryService(db);
    const items = inventory.listItems('', true);
    const loans = inventory.listLoans();
    expect(items.filter((item) => item.kind === 'consumable')).toHaveLength(36);
    expect(items.filter((item) => item.kind === 'non_consumable')).toHaveLength(36);
    expect(items.filter((item) => item.archived)).toHaveLength(8);
    expect(loans).toHaveLength(18);
    expect(loans.reduce((total, loan) => total + loan.outstanding, 0)).toBe(39);
    expect(unresolvedDamageReport(snapshot)).toHaveLength(6);
    expect(consumablesUsageReport(snapshot)).toHaveLength(36);
    db.close();
  });

  it('rebases the editable reset totals into clean opening stock', async () => {
    const payload = await parseResetWorkbook(await sampleWorkbook());
    expect(payload.locations).toHaveLength(3);
    expect(payload.items).toHaveLength(72);
    expect(payload.items.reduce((total, item) => total + item.total, 0)).toBe(5_299);

    const db = openDatabase(':memory:');
    const transfers = new InventoryTransferService(db);
    transfers.replaceWithReset(payload);
    const snapshot = transfers.snapshot();

    expect(snapshot.locations).toEqual(payload.locations);
    expect(snapshot.borrowers).toEqual([]);
    expect(snapshot.items).toHaveLength(payload.items.length);
    expect(snapshot.events).toHaveLength(payload.items.length);
    expect(snapshot.events.every((event) => event.kind === 'stock_added')).toBe(true);
    expect(snapshot.items).toEqual(
      payload.items.map(({ total, ...item }, index) => ({
        ...item,
        createdAt: snapshot.items[index]!.createdAt,
        startingStock: total,
        baselineThroughEventId: snapshot.items[index]!.baselineThroughEventId,
        resetTotal: total,
      })),
    );
    expect(new InventoryService(db).listLoans()).toEqual([]);
    expect(unresolvedDamageReport(snapshot)).toEqual([]);
    expect(consumablesUsageReport(snapshot)).toEqual(
      expect.arrayContaining(
        payload.items
          .filter((item) => item.kind === 'consumable')
          .map((item) =>
            expect.objectContaining({
              itemCode: item.code,
              startOfCycleStock: item.total,
              addedDuringCycle: 0,
              usage: 0,
              left: item.total,
            }),
          ),
      ),
    );
    db.close();
  });
});
