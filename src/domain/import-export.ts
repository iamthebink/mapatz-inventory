import type { InventoryDatabase } from '../db/database.js';
import { transaction } from '../db/database.js';
import type { BorrowerType, EventKind, ItemKind } from './types.js';

type Row = Record<string, unknown>;

export interface TransferLocation {
  name: string;
  archived: boolean;
}

export interface TransferItem {
  code: number;
  name: string;
  kind: ItemKind;
  location: string | null;
  aliases: string[];
  lotSize: number | null;
  archived: boolean;
  createdAt: string;
  startingStock: number;
  baselineThroughEventId: number;
  resetTotal: number;
}

export interface TransferBorrower {
  username: string;
  name: string;
  contact: string;
  type: BorrowerType;
  archived: boolean;
  createdAt: string;
}

export interface TransferEvent {
  id: number;
  kind: EventKind;
  itemCode: number;
  borrowerUsername: string | null;
  quantity: number;
  relatedEventId: number | null;
  note: string;
  createdAt: string;
}

export interface InventoryTransferSnapshot {
  locations: TransferLocation[];
  items: TransferItem[];
  borrowers: TransferBorrower[];
  events: TransferEvent[];
}

export interface ResetItem {
  code: number;
  name: string;
  kind: ItemKind;
  location: string | null;
  aliases: string[];
  lotSize: number | null;
  archived: boolean;
  total: number;
}

export interface ResetPayload {
  locations: TransferLocation[];
  items: ResetItem[];
}

const availableEffect = `CASE kind
  WHEN 'stock_added' THEN quantity WHEN 'returned_usable' THEN quantity WHEN 'repaired' THEN quantity
  WHEN 'stock_removed' THEN -quantity WHEN 'issued' THEN -quantity WHEN 'checked_out' THEN -quantity ELSE 0 END`;
const damagedEffect = `CASE kind WHEN 'returned_damaged' THEN quantity WHEN 'repaired' THEN -quantity WHEN 'written_off' THEN -quantity ELSE 0 END`;

export class InventoryTransferService {
  constructor(private readonly db: InventoryDatabase) {}

  snapshot(): InventoryTransferSnapshot {
    const locations = (
      this.db
        .prepare('SELECT name, archived FROM locations ORDER BY name COLLATE NOCASE')
        .all() as Row[]
    ).map((row) => ({ name: String(row.name), archived: Boolean(row.archived) }));
    const aliases = new Map<number, string[]>();
    for (const row of this.db
      .prepare('SELECT item_id, alias FROM item_aliases ORDER BY item_id, alias COLLATE NOCASE')
      .all() as Row[]) {
      const itemId = Number(row.item_id);
      aliases.set(itemId, [...(aliases.get(itemId) ?? []), String(row.alias)]);
    }
    const items = (
      this.db
        .prepare(
          `SELECT i.*, l.name location_name, COALESCE(b.quantity, 0) starting_stock,
          COALESCE(b.through_event_id, 0) baseline_through_event_id,
          COALESCE((SELECT SUM(${availableEffect}) FROM inventory_events e WHERE e.item_id=i.id),0) available,
          COALESCE((SELECT SUM(${damagedEffect}) FROM inventory_events e WHERE e.item_id=i.id),0) damaged,
          COALESCE((SELECT SUM(e.quantity-COALESCE((SELECT SUM(CASE x.kind
            WHEN 'returned_usable' THEN x.quantity WHEN 'returned_damaged' THEN x.quantity
            WHEN 'marked_lost' THEN x.quantity WHEN 'unmarked_lost' THEN -x.quantity ELSE 0 END)
          FROM inventory_events x WHERE x.related_event_id=e.id),0))
          FROM inventory_events e WHERE e.item_id=i.id AND e.kind='checked_out'),0) outstanding,
          COALESCE((SELECT SUM(CASE e.kind WHEN 'marked_lost' THEN e.quantity WHEN 'unmarked_lost' THEN -e.quantity ELSE 0 END)
          FROM inventory_events e WHERE e.item_id=i.id),0) lost
          FROM items i LEFT JOIN locations l ON l.id=i.location_id
          LEFT JOIN inventory_baselines b ON b.item_id=i.id ORDER BY i.code`,
        )
        .all() as Row[]
    ).map((row) => {
      const available = Number(row.available);
      const resetTotal =
        row.kind === 'consumable'
          ? available
          : available + Number(row.damaged) + Number(row.outstanding) + Number(row.lost);
      return {
        code: Number(row.code),
        name: String(row.name),
        kind: row.kind as ItemKind,
        location: row.location_name == null ? null : String(row.location_name),
        aliases: aliases.get(Number(row.id)) ?? [],
        lotSize: row.lot_size == null ? null : Number(row.lot_size),
        archived: Boolean(row.archived),
        createdAt: String(row.created_at),
        startingStock: Number(row.starting_stock),
        baselineThroughEventId: Number(row.baseline_through_event_id),
        resetTotal,
      };
    });
    const borrowers = (
      this.db.prepare('SELECT * FROM borrowers ORDER BY username COLLATE NOCASE').all() as Row[]
    ).map((row) => ({
      username: String(row.username),
      name: String(row.name),
      contact: String(row.contact),
      type: row.type as BorrowerType,
      archived: Boolean(row.archived),
      createdAt: String(row.created_at),
    }));
    const events = (
      this.db
        .prepare(
          `SELECT e.id,e.kind,i.code item_code,b.username borrower_username,e.quantity,
          e.related_event_id,e.note,e.created_at FROM inventory_events e
          JOIN items i ON i.id=e.item_id LEFT JOIN borrowers b ON b.id=e.borrower_id ORDER BY e.id`,
        )
        .all() as Row[]
    ).map((row) => ({
      id: Number(row.id),
      kind: row.kind as EventKind,
      itemCode: Number(row.item_code),
      borrowerUsername: row.borrower_username == null ? null : String(row.borrower_username),
      quantity: Number(row.quantity),
      relatedEventId: row.related_event_id == null ? null : Number(row.related_event_id),
      note: String(row.note),
      createdAt: String(row.created_at),
    }));
    return { locations, items, borrowers, events };
  }

  replaceWithReset(payload: ResetPayload): void {
    transaction(this.db, () => {
      this.db.prepare('UPDATE inventory_replacement_guard SET enabled=1 WHERE singleton=1').run();
      this.db.prepare('DELETE FROM inventory_events').run();
      this.db.prepare('DELETE FROM inventory_baselines').run();
      this.db.prepare('DELETE FROM item_aliases').run();
      this.db.prepare('DELETE FROM items').run();
      this.db.prepare('DELETE FROM borrowers').run();
      this.db.prepare('DELETE FROM locations').run();

      const locationIds = new Map<string, number>();
      const insertLocation = this.db.prepare(
        'INSERT INTO locations(code,name,archived) VALUES (?,?,?)',
      );
      payload.locations.forEach((location, index) => {
        const result = insertLocation.run(
          `import-location-${index + 1}`,
          location.name,
          Number(location.archived),
        );
        locationIds.set(location.name.toLocaleLowerCase(), Number(result.lastInsertRowid));
      });

      const insertItem = this.db.prepare(
        'INSERT INTO items(code,name,kind,lot_size,location_id,archived) VALUES (?,?,?,?,?,?)',
      );
      const insertAlias = this.db.prepare('INSERT INTO item_aliases(item_id,alias) VALUES (?,?)');
      const insertEvent = this.db.prepare(
        "INSERT INTO inventory_events(kind,item_id,quantity,note) VALUES ('stock_added',?,?,?)",
      );
      const insertBaseline = this.db.prepare(
        'INSERT INTO inventory_baselines(item_id,quantity,through_event_id) VALUES (?,?,?)',
      );
      for (const item of payload.items) {
        const result = insertItem.run(
          item.code,
          item.name,
          item.kind,
          item.lotSize,
          item.location == null ? null : locationIds.get(item.location.toLocaleLowerCase())!,
          Number(item.archived),
        );
        const itemId = Number(result.lastInsertRowid);
        for (const alias of item.aliases) insertAlias.run(itemId, alias);
        const baselineEventId =
          item.total === 0
            ? 0
            : Number(insertEvent.run(itemId, item.total, 'Reset baseline import').lastInsertRowid);
        insertBaseline.run(itemId, item.total, baselineEventId);
      }
      const highestGeneratedRangeCode = payload.items.reduce(
        (highest, item) => (item.code >= 100 ? Math.max(highest, item.code) : highest),
        99,
      );
      this.db
        .prepare('UPDATE code_sequence SET next_code=? WHERE singleton=1')
        .run(Math.max(100, highestGeneratedRangeCode + 1));
      this.db.prepare('UPDATE inventory_replacement_guard SET enabled=0 WHERE singleton=1').run();
    });
  }
}
