import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { InventoryService } from '../../src/domain/inventory.js';
import { periodBounds, todayInIsrael } from '../../src/domain/period-summary.js';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = openDatabase(':memory:');
  databases.push(db);
  db.prepare(
    "INSERT INTO borrowers(id,username,name,contact,type) VALUES (1,'one','Alpha','555','individual'),(2,'two','Beta','','individual')",
  ).run();
  db.prepare(
    "INSERT INTO items(id,code,name,kind) VALUES (1,100,'Chairs','non_consumable'),(2,101,'Drills','non_consumable')",
  ).run();
  const add = (kind: string, itemId: number, borrowerId: number, quantity: number, at: string) =>
    db
      .prepare(
        'INSERT INTO inventory_events(kind,item_id,borrower_id,quantity,created_at) VALUES (?,?,?,?,?)',
      )
      .run(kind, itemId, borrowerId, quantity, at);
  return { db, service: new InventoryService(db), add };
}

describe('period summary ledger arithmetic', () => {
  const monday = '2026-09-21 09:00:00';
  const tuesday = '2026-09-22 09:00:00';
  const now = new Date('2026-09-24T12:00:00Z');

  it('aggregates whole periods and excludes prior holdings from today', () => {
    const { service, add } = fixture();
    add('checked_out', 1, 1, 5, monday);
    add('checked_out', 1, 1, 2, tuesday);
    add('returned_usable', 1, 1, 2, tuesday);
    expect(service.periodSummary('2026-09-22', '2026-09-22', now).borrowers).toEqual([]);
    expect(
      service.periodSummary('2026-09-21', '2026-09-21', now).borrowers[0]?.items[0]?.quantity,
    ).toBe(5);
    expect(
      service.periodSummary('2026-09-21', '2026-09-22', now).borrowers[0]?.items[0]?.quantity,
    ).toBe(5);
  });

  it('keeps Monday borrowing 2 when Tuesday returns 2, but omits the combined interval', () => {
    const { service, add } = fixture();
    add('checked_out', 1, 1, 2, monday);
    add('returned_usable', 1, 1, 2, tuesday);
    expect(service.periodSummary('2026-09-21', '2026-09-21', now).borrowers[0]?.total).toBe(2);
    expect(service.periodSummary('2026-09-22', '2026-09-22', now).borrowers).toEqual([]);
    expect(service.periodSummary('2026-09-21', '2026-09-22', now).borrowers).toEqual([]);
  });

  it('counts only the four signed kinds, combines checkouts, and clamps each item before totals', () => {
    const { service, add, db } = fixture();
    add('checked_out', 1, 1, 2, monday);
    add('checked_out', 1, 1, 3, monday);
    add('returned_usable', 1, 1, 1, monday);
    add('returned_damaged', 1, 1, 1, monday);
    add('marked_lost', 1, 1, 2, monday);
    add('found_returned', 1, 1, 1, monday);
    add('found_returned_damaged', 1, 1, 1, monday);
    add('repaired', 1, 1, 1, monday);
    add('written_off', 1, 1, 1, monday);
    add('checked_out', 2, 1, 2, monday);
    add('returned_usable', 1, 2, 3, monday);
    db.prepare('UPDATE borrowers SET archived=1,name=? WHERE id=1').run('Archived Alpha');
    db.prepare('UPDATE items SET archived=1,name=? WHERE id=2').run('Archived Drill');
    const rows = service.periodSummary('2026-09-21', '2026-09-21', now).borrowers;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.borrower).toMatchObject({ id: 1, name: 'Archived Alpha', archived: true });
    expect(rows[0]?.total).toBe(3);
    expect(rows[0]?.items).toEqual([
      { itemId: 1, code: 100, name: 'Chairs', quantity: 1 },
      { itemId: 2, code: 101, name: 'Archived Drill', quantity: 2 },
    ]);
  });

  it('omits negative item movement without canceling a different item or borrower', () => {
    const { service, add } = fixture();
    add('returned_usable', 1, 1, 3, monday);
    add('checked_out', 2, 1, 2, monday);
    add('checked_out', 1, 2, 2, monday);
    expect(
      service
        .periodSummary('2026-09-21', '2026-09-21', now)
        .borrowers.map((row) => [row.borrower.id, row.total]),
    ).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

describe('Israel calendar boundaries', () => {
  it('accepts valid early Gregorian years', () => {
    expect(() =>
      periodBounds('0001-01-01', '0099-12-31', new Date('2026-09-24T12:00:00Z')),
    ).not.toThrow();
    expect(() =>
      periodBounds('0000-01-01', '0001-01-01', new Date('2026-09-24T12:00:00Z')),
    ).toThrow();
  });
  it('uses local midnight, including both daylight-saving transitions', () => {
    expect(periodBounds('2026-03-27', '2026-03-27', new Date('2026-09-24T12:00:00Z'))).toEqual({
      startUtc: '2026-03-26 22:00:00',
      endExclusiveUtc: '2026-03-27 21:00:00',
    });
    expect(periodBounds('2026-10-25', '2026-10-25', new Date('2026-11-01T12:00:00Z'))).toEqual({
      startUtc: '2026-10-24 21:00:00',
      endExclusiveUtc: '2026-10-25 22:00:00',
    });
  });

  it('includes start midnight and excludes next midnight while rejecting invalid ranges', () => {
    const { service, add } = fixture();
    add('checked_out', 1, 1, 1, '2026-09-20 21:00:00');
    add('checked_out', 1, 1, 5, '2026-09-21 21:00:00');
    expect(
      service.periodSummary('2026-09-21', '2026-09-21', new Date('2026-09-24T12:00:00Z'))
        .borrowers[0]?.total,
    ).toBe(1);
    for (const [start, end] of [
      ['2026-02-30', '2026-03-01'],
      ['2026-09-22', '2026-09-21'],
      ['2026-09-25', '2026-09-25'],
    ])
      expect(() => periodBounds(start!, end!, new Date('2026-09-24T12:00:00Z'))).toThrow();
    expect(todayInIsrael(new Date('2026-09-23T21:00:00Z'))).toBe('2026-09-24');
  });

  it('selects the same ledger events regardless of device timezone', () => {
    const { service, add } = fixture();
    add('checked_out', 1, 1, 1, '2026-09-20 20:59:59');
    add('checked_out', 1, 1, 2, '2026-09-20 21:00:00');
    add('returned_usable', 1, 1, 1, '2026-09-21 20:59:59');
    add('checked_out', 1, 1, 9, '2026-09-21 21:00:00');
    const previous = process.env.TZ;
    try {
      for (const timezone of ['Pacific/Honolulu', 'Asia/Tokyo', 'UTC']) {
        process.env.TZ = timezone;
        expect(
          service.periodSummary('2026-09-21', '2026-09-21', new Date('2026-09-24T12:00:00Z'))
            .borrowers[0]?.total,
        ).toBe(1);
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
