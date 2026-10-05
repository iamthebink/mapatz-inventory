import { transferBusinessState } from '../helpers/transfer-business-state.js';
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
        { name: 'צוללת', archived: false, isDefault: false },
        { name: 'צהובה', archived: false, isDefault: false },
        { name: 'מפלצת', archived: false, isDefault: false },
      ]),
    });
    expect(payload.items).toHaveLength(72);
    expect(payload.radioCount).toBe(40);
    expect(payload.radios).toHaveLength(40);
    expect(payload.radios.slice(15)).toEqual(
      Array.from({ length: 25 }, (_, index) => ({
        number: index + 16,
        holder: 'צוללת',
        team: '',
        lost: false,
      })),
    );
    expect(payload.borrowers).toHaveLength(12);
    expect(payload.events).toHaveLength(483);
    const eventsByDay = new Map<string, number>();
    for (const event of payload.events) {
      const day = event.createdAt.slice(0, 10);
      eventsByDay.set(day, (eventsByDay.get(day) ?? 0) + 1);
    }
    expect(eventsByDay.size).toBe(14);
    expect([...eventsByDay.values()].every((count) => count >= 25)).toBe(true);
    expect(payload.events.at(-1)).toMatchObject({
      id: 483,
      kind: 'stock_removed',
      createdAt: '2026-01-14 14:46:00',
    });
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
    expect(snapshot.radioCount).toBe(40);
    expect(snapshot.radios).toEqual(payload.radios);
    expect(transferBusinessState(snapshot).borrowers).toEqual(
      transferBusinessState(payload).borrowers,
    );
    expect(transferBusinessState(snapshot).events).toEqual(transferBusinessState(payload).events);
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
    expect(transferBusinessState(snapshot).items).toMatchObject(
      transferBusinessState(payload).items,
    );
    expect(transferBusinessState(snapshot).loans).toEqual(transferBusinessState(payload).loans);
    expect(snapshot.stateRevision).toBe(payload.stateRevision);
    const inventory = new InventoryService(db);
    const items = inventory.listItems('', true);
    const loans = inventory.listLoans();
    expect(items.filter((item) => item.kind === 'consumable')).toHaveLength(36);
    expect(items.filter((item) => item.kind === 'non_consumable')).toHaveLength(36);
    expect(items.filter((item) => item.archived)).toHaveLength(8);
    expect(loans).toHaveLength(34);
    expect(loans.reduce((total, loan) => total + loan.outstanding, 0)).toBe(55);
    expect(unresolvedDamageReport(snapshot)).toHaveLength(6);
    expect(consumablesUsageReport(snapshot)).toHaveLength(36);
    db.close();
  });
  it('rebases the editable reset totals into clean opening stock', async () => {
    const payload = await parseResetWorkbook(await sampleWorkbook());
    expect(payload.locations).toHaveLength(3);
    expect(new Set(payload.items.map((item) => item.name)).size).toBe(72);
    expect(payload.items).toHaveLength(94);
    expect(payload.items.reduce((total, item) => total + item.total, 0)).toBe(4093);
    const db = openDatabase(':memory:');
    const transfers = new InventoryTransferService(db);
    transfers.replaceWithReset(payload);
    const snapshot = transfers.snapshot();
    expect(snapshot.locations).toEqual(payload.locations);
    expect(snapshot.borrowers).toEqual([]);
    expect(snapshot.items).toHaveLength(payload.items.length);
    expect(snapshot.events).toHaveLength(payload.items.filter((item) => item.total > 0).length);
    expect(snapshot.events.every((event) => event.kind === 'stock_added')).toBe(true);
    expect(snapshot.items).toEqual(
      snapshot.items
        .map((actual) =>
          payload.items.find(
            (item) => item.name === actual.name && item.location === actual.location,
          )!,
        )
        .map(({ total, ...item }, index) => ({
          id: snapshot.items[index]!.id,
          ...item,
          createdAt: snapshot.items[index]!.createdAt,
          startingStock: payload.items
            .filter((row) => row.name === item.name)
            .reduce((sum, row) => sum + row.total, 0),
          baselineThroughEventId: snapshot.items[index]!.baselineThroughEventId,
          available: total,
          borrowed: 0,
          damaged: 0,
          lost: 0,
          revision: 0,
          resetTotal: total,
        })),
    );
    expect(new InventoryService(db).listLoans()).toEqual([]);
    expect(unresolvedDamageReport(snapshot)).toEqual([]);
    for (const name of new Set(
      payload.items.filter((item) => item.kind === 'consumable').map((item) => item.name),
    )) {
      const total = payload.items
        .filter((item) => item.name === name)
        .reduce((sum, item) => sum + item.total, 0);
      expect(consumablesUsageReport(snapshot)).toContainEqual(
        expect.objectContaining({
          itemName: name,
          startOfCycleStock: total,
          addedDuringCycle: 0,
          usage: 0,
          left: total,
        }),
      );
    }
    db.close();
  });
});
