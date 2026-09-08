import type { InventoryDatabase } from '../db/database.js';
import { transaction } from '../db/database.js';
import { DomainError, type BorrowerType, type EventKind, type ItemKind } from './types.js';

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

export type RecoveryItem = Omit<TransferItem, 'resetTotal'>;

export interface RecoveryPayload {
  locations: TransferLocation[];
  items: RecoveryItem[];
  borrowers: TransferBorrower[];
  events: TransferEvent[];
}

export interface UnresolvedDamageReportRow {
  itemCode: number;
  itemName: string;
  location: string | null;
  unresolvedDamagedQuantity: number;
}

export interface ConsumablesUsageReportRow {
  itemCode: number;
  itemName: string;
  location: string | null;
  startOfCycleStock: number;
  addedDuringCycle: number;
  usage: number;
  left: number;
}

export function unresolvedDamageReport(
  snapshot: InventoryTransferSnapshot,
): UnresolvedDamageReportRow[] {
  const quantities = new Map<number, number>();
  for (const event of snapshot.events) {
    const change =
      event.kind === 'returned_damaged'
        ? event.quantity
        : event.kind === 'repaired' || event.kind === 'written_off'
          ? -event.quantity
          : 0;
    if (change !== 0)
      quantities.set(event.itemCode, (quantities.get(event.itemCode) ?? 0) + change);
  }
  return snapshot.items
    .filter((item) => item.kind === 'non_consumable' && (quantities.get(item.code) ?? 0) > 0)
    .map((item) => ({
      itemCode: item.code,
      itemName: item.name,
      location: item.location,
      unresolvedDamagedQuantity: quantities.get(item.code)!,
    }));
}

export function consumablesUsageReport(
  snapshot: InventoryTransferSnapshot,
): ConsumablesUsageReportRow[] {
  return snapshot.items
    .filter((item) => item.kind === 'consumable')
    .map((item) => {
      let addedDuringCycle = 0;
      let usage = 0;
      for (const event of snapshot.events) {
        if (event.itemCode !== item.code || event.id <= item.baselineThroughEventId) continue;
        if (event.kind === 'stock_added') addedDuringCycle += event.quantity;
        if (event.kind === 'issued') usage += event.quantity;
      }
      return {
        itemCode: item.code,
        itemName: item.name,
        location: item.location,
        startOfCycleStock: item.startingStock,
        addedDuringCycle,
        usage,
        left: item.resetTotal,
      };
    });
}

type RecoveryItemState = {
  available: number;
  damaged: number;
  checkouts: Map<number, RecoveryCheckoutState>;
  baselineVerified: boolean;
};

type RecoveryCheckoutState = {
  itemCode: number;
  borrowerUsername: string;
  quantity: number;
  returned: number;
  lost: number;
};

function invalidWorkbook(message: string): never {
  throw new DomainError('invalid_workbook', message);
}

function recoveryTotal(state: RecoveryItemState): number {
  let checkedOut = 0;
  for (const checkout of state.checkouts.values())
    checkedOut += checkout.quantity - checkout.returned;
  return state.available + state.damaged + checkedOut;
}

export function validateRecoveryPayload(payload: RecoveryPayload): RecoveryPayload {
  const locations = new Map<string, TransferLocation>();
  for (const location of payload.locations) {
    const key = location.name.toLocaleLowerCase();
    if (locations.has(key))
      invalidWorkbook(`Recovery Locations contains duplicate name "${location.name}"`);
    locations.set(key, location);
  }

  const items = new Map<number, RecoveryItem>();
  const states = new Map<number, RecoveryItemState>();
  for (const item of payload.items) {
    if (items.has(item.code))
      invalidWorkbook(`Recovery Items contains duplicate Item Code ${item.code}`);
    if (item.location != null && !locations.has(item.location.toLocaleLowerCase()))
      invalidWorkbook(`Recovery item ${item.code} references unknown Location "${item.location}"`);
    if (item.kind !== 'consumable' && item.lotSize != null)
      invalidWorkbook(`Recovery item ${item.code} defines a Lot Size but is not consumable`);
    if (item.startingStock < 0)
      invalidWorkbook(`Recovery item ${item.code} Starting Stock must be nonnegative`);
    items.set(item.code, item);
    states.set(item.code, {
      available: 0,
      damaged: 0,
      checkouts: new Map(),
      baselineVerified: item.baselineThroughEventId === 0 && item.startingStock === 0,
    });
    if (item.baselineThroughEventId === 0 && item.startingStock !== 0)
      invalidWorkbook(
        `Recovery item ${item.code} has Starting Stock ${item.startingStock} without a baseline event`,
      );
  }

  const borrowers = new Map<string, TransferBorrower>();
  for (const borrower of payload.borrowers) {
    const key = borrower.username.toLocaleLowerCase();
    if (borrowers.has(key))
      invalidWorkbook(`Recovery Borrowers contains duplicate Username "${borrower.username}"`);
    borrowers.set(key, borrower);
  }

  const events = new Map<number, TransferEvent>();
  let previousId = 0;
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (const event of payload.events) {
    if (event.id <= previousId)
      invalidWorkbook(`Recovery Events must be ordered by strictly increasing Event ID`);
    const timestamp = Date.parse(event.createdAt);
    if (timestamp < previousTimestamp)
      invalidWorkbook(`Recovery event ${event.id} occurs before the preceding event timestamp`);
    previousId = event.id;
    previousTimestamp = timestamp;
    const item = items.get(event.itemCode);
    if (!item)
      invalidWorkbook(`Recovery event ${event.id} references unknown Item Code ${event.itemCode}`);
    if (timestamp < Date.parse(item.createdAt))
      invalidWorkbook(
        `Recovery event ${event.id} occurs before item ${event.itemCode} was created`,
      );
    const state = states.get(event.itemCode)!;
    const borrower =
      event.borrowerUsername == null
        ? null
        : borrowers.get(event.borrowerUsername.toLocaleLowerCase());
    if (event.borrowerUsername != null && !borrower)
      invalidWorkbook(
        `Recovery event ${event.id} references unknown Borrower Username "${event.borrowerUsername}"`,
      );
    if (borrower && timestamp < Date.parse(borrower.createdAt))
      invalidWorkbook(`Recovery event ${event.id} occurs before its borrower was created`);

    if (event.kind === 'stock_added') {
      if (event.borrowerUsername != null || event.relatedEventId != null)
        invalidWorkbook(`Recovery stock event ${event.id} cannot reference a borrower or event`);
      state.available += event.quantity;
    } else if (event.kind === 'stock_removed' || event.kind === 'issued') {
      if (event.borrowerUsername != null || event.relatedEventId != null)
        invalidWorkbook(`Recovery stock event ${event.id} cannot reference a borrower or event`);
      if (event.kind === 'issued' && item.kind !== 'consumable')
        invalidWorkbook(`Recovery event ${event.id} issues an item that is not consumable`);
      if (event.quantity > state.available)
        invalidWorkbook(`Recovery event ${event.id} would make available stock negative`);
      state.available -= event.quantity;
    } else if (event.kind === 'checked_out') {
      if (item.kind !== 'non_consumable')
        invalidWorkbook(`Recovery event ${event.id} checks out an item that is not borrowable`);
      if (!borrower || event.relatedEventId != null)
        invalidWorkbook(`Recovery checkout ${event.id} requires a borrower and no related event`);
      if (event.quantity > state.available)
        invalidWorkbook(`Recovery checkout ${event.id} would make available stock negative`);
      state.available -= event.quantity;
      state.checkouts.set(event.id, {
        itemCode: event.itemCode,
        borrowerUsername: borrower.username,
        quantity: event.quantity,
        returned: 0,
        lost: 0,
      });
    } else if (
      event.kind === 'returned_usable' ||
      event.kind === 'returned_damaged' ||
      event.kind === 'marked_lost' ||
      event.kind === 'unmarked_lost'
    ) {
      if (event.relatedEventId == null)
        invalidWorkbook(`Recovery event ${event.id} requires a related checkout`);
      const checkoutEvent = events.get(event.relatedEventId);
      const checkout = state.checkouts.get(event.relatedEventId);
      if (!checkoutEvent || checkoutEvent.kind !== 'checked_out' || !checkout)
        invalidWorkbook(`Recovery event ${event.id} references a missing or invalid checkout`);
      if (
        event.itemCode !== checkout.itemCode ||
        event.borrowerUsername?.toLocaleLowerCase() !==
          checkout.borrowerUsername.toLocaleLowerCase()
      )
        invalidWorkbook(`Recovery event ${event.id} does not match its checkout item and borrower`);
      const outstanding = checkout.quantity - checkout.returned - checkout.lost;
      if (event.kind === 'unmarked_lost') {
        if (event.quantity > checkout.lost)
          invalidWorkbook(`Recovery event ${event.id} unmarks more lost stock than exists`);
        checkout.lost -= event.quantity;
      } else if (event.kind === 'marked_lost') {
        if (event.quantity > outstanding)
          invalidWorkbook(`Recovery event ${event.id} marks more stock lost than is outstanding`);
        checkout.lost += event.quantity;
      } else {
        if (event.quantity > outstanding)
          invalidWorkbook(`Recovery event ${event.id} returns more stock than is outstanding`);
        checkout.returned += event.quantity;
        if (event.kind === 'returned_usable') state.available += event.quantity;
        else state.damaged += event.quantity;
      }
    } else {
      if (event.borrowerUsername != null || event.relatedEventId != null)
        invalidWorkbook(`Recovery damage event ${event.id} cannot reference a borrower or event`);
      if (event.quantity > state.damaged)
        invalidWorkbook(`Recovery event ${event.id} resolves more damaged stock than exists`);
      state.damaged -= event.quantity;
      if (event.kind === 'repaired') state.available += event.quantity;
    }
    events.set(event.id, event);
    if (item.baselineThroughEventId === event.id) {
      if (recoveryTotal(state) !== item.startingStock)
        invalidWorkbook(
          `Recovery item ${item.code} Starting Stock does not match state at its baseline event`,
        );
      state.baselineVerified = true;
    }
  }

  for (const item of payload.items) {
    const state = states.get(item.code)!;
    if (!state.baselineVerified)
      invalidWorkbook(
        `Recovery item ${item.code} references missing Baseline Through Event ID ${item.baselineThroughEventId}`,
      );
    const unresolved = [...state.checkouts.values()].filter(
      (checkout) => checkout.quantity - checkout.returned > 0,
    );
    if (item.archived && (state.damaged > 0 || unresolved.length > 0))
      invalidWorkbook(`Recovery item ${item.code} is archived with unresolved inventory state`);
  }
  for (const borrower of payload.borrowers) {
    if (!borrower.archived) continue;
    const unresolved = [...states.values()].some((state) =>
      [...state.checkouts.values()].some(
        (checkout) =>
          checkout.borrowerUsername.toLocaleLowerCase() === borrower.username.toLocaleLowerCase() &&
          checkout.quantity - checkout.returned > 0,
      ),
    );
    if (unresolved)
      invalidWorkbook(`Recovery borrower "${borrower.username}" is archived with unresolved loans`);
  }
  return payload;
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
      this.rotateLedgerEpoch();
      this.db.prepare('DELETE FROM idempotency_receipts').run();
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

  replaceWithRecovery(payload: RecoveryPayload): void {
    validateRecoveryPayload(payload);
    transaction(this.db, () => {
      this.rotateLedgerEpoch();
      this.db.prepare('DELETE FROM idempotency_receipts').run();
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
          `recovered-location-${index + 1}`,
          location.name,
          Number(location.archived),
        );
        locationIds.set(location.name.toLocaleLowerCase(), Number(result.lastInsertRowid));
      });

      const itemIds = new Map<number, number>();
      const insertItem = this.db.prepare(
        `INSERT INTO items(code,name,kind,lot_size,location_id,archived,created_at)
        VALUES (?,?,?,?,?,?,?)`,
      );
      const insertAlias = this.db.prepare('INSERT INTO item_aliases(item_id,alias) VALUES (?,?)');
      for (const item of payload.items) {
        const result = insertItem.run(
          item.code,
          item.name,
          item.kind,
          item.lotSize,
          item.location == null ? null : locationIds.get(item.location.toLocaleLowerCase())!,
          Number(item.archived),
          item.createdAt,
        );
        const itemId = Number(result.lastInsertRowid);
        itemIds.set(item.code, itemId);
        for (const alias of item.aliases) insertAlias.run(itemId, alias);
      }

      const borrowerIds = new Map<string, number>();
      const insertBorrower = this.db.prepare(
        `INSERT INTO borrowers(username,name,contact,type,archived,created_at)
        VALUES (?,?,?,?,?,?)`,
      );
      for (const borrower of payload.borrowers) {
        const result = insertBorrower.run(
          borrower.username,
          borrower.name,
          borrower.contact,
          borrower.type,
          Number(borrower.archived),
          borrower.createdAt,
        );
        borrowerIds.set(borrower.username.toLocaleLowerCase(), Number(result.lastInsertRowid));
      }

      const insertEvent = this.db.prepare(
        `INSERT INTO inventory_events(id,kind,item_id,borrower_id,quantity,related_event_id,note,created_at)
        VALUES (?,?,?,?,?,?,?,?)`,
      );
      for (const event of payload.events) {
        insertEvent.run(
          event.id,
          event.kind,
          itemIds.get(event.itemCode)!,
          event.borrowerUsername == null
            ? null
            : borrowerIds.get(event.borrowerUsername.toLocaleLowerCase())!,
          event.quantity,
          event.relatedEventId,
          event.note,
          event.createdAt,
        );
      }
      const insertBaseline = this.db.prepare(
        `INSERT INTO inventory_baselines(item_id,quantity,through_event_id,established_at)
        VALUES (?,?,?,?)`,
      );
      for (const item of payload.items) {
        const establishedAt =
          item.baselineThroughEventId === 0
            ? item.createdAt
            : payload.events.find((event) => event.id === item.baselineThroughEventId)!.createdAt;
        insertBaseline.run(
          itemIds.get(item.code)!,
          item.startingStock,
          item.baselineThroughEventId,
          establishedAt,
        );
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

  private rotateLedgerEpoch(): void {
    const result = this.db
      .prepare(
        'UPDATE inventory_replacement_guard SET ledger_epoch=ledger_epoch+1 WHERE singleton=1',
      )
      .run();
    if (result.changes !== 1)
      throw new DomainError('internal_error', 'Inventory replacement guard is missing', 500);
  }
}
