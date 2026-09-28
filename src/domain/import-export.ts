import type { InventoryDatabase } from '../db/database.js';
import { readTransaction, transaction } from '../db/database.js';
import { normalizeItemName } from './item-name.js';
import { DomainError, type BorrowerType, type EventKind, type ItemKind } from './types.js';
import type { Radio } from './types.js';
import { RadioService, validateRadioFleet } from './radios.js';

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
  available: number;
  borrowed: number;
  damaged: number;
  lost: number;
  revision: number;
  resetTotal: number;
}

export interface TransferLoan {
  checkoutId: number;
  itemCode: number;
  borrowerUsername: string;
  quantity: number;
  createdAt: string;
  outstanding: number;
  lost: number;
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
  loans: TransferLoan[];
  stateRevision: number;
  radioCount: number;
  radios: Radio[];
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
  loans: TransferLoan[];
  stateRevision: number;
  radioCount: number;
  radios: Radio[];
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
  return snapshot.items
    .filter((item) => item.kind === 'non_consumable' && item.damaged > 0)
    .map((item) => ({
      itemCode: item.code,
      itemName: item.name,
      location: item.location,
      unresolvedDamagedQuantity: item.damaged,
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
        left: item.available,
      };
    });
}

function invalidWorkbook(message: string): never {
  throw new DomainError('invalid_workbook', message);
}

function canonicalUtcTimestamp(value: string): string {
  // Existing exports use SQLite UTC text. Date.parse treats that form as device-local time.
  const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value);
  const instant = Date.parse(sqliteUtc ? `${value.replace(' ', 'T')}Z` : value);
  if (!Number.isFinite(instant)) invalidWorkbook(`Invalid recovery timestamp "${value}"`);
  const iso = new Date(instant).toISOString();
  return iso.endsWith('.000Z')
    ? iso.slice(0, 19).replace('T', ' ')
    : iso.slice(0, 23).replace('T', ' ');
}

function normalizeRecoveryTimestamps(payload: RecoveryPayload): RecoveryPayload {
  return {
    ...payload,
    items: payload.items.map((item) => ({
      ...item,
      createdAt: canonicalUtcTimestamp(item.createdAt),
    })),
    borrowers: payload.borrowers.map((borrower) => ({
      ...borrower,
      createdAt: canonicalUtcTimestamp(borrower.createdAt),
    })),
    events: payload.events.map((event) => ({
      ...event,
      createdAt: canonicalUtcTimestamp(event.createdAt),
    })),
    loans: payload.loans.map((loan) => ({
      ...loan,
      createdAt: canonicalUtcTimestamp(loan.createdAt),
    })),
  };
}

function utcTimestamp(value: string): number {
  return Date.parse(`${value.replace(' ', 'T')}Z`);
}

export function validateRecoveryPayload(payload: RecoveryPayload): RecoveryPayload {
  if (
    !payload ||
    !Array.isArray(payload.locations) ||
    !Array.isArray(payload.items) ||
    !Array.isArray(payload.borrowers) ||
    !Array.isArray(payload.events) ||
    !Array.isArray(payload.loans) ||
    !Number.isSafeInteger(payload.stateRevision) ||
    payload.stateRevision < 0
  )
    invalidWorkbook('Recovery is missing authoritative state or required tables');
  payload = normalizeRecoveryTimestamps(payload);
  validateRadioFleet(payload.radioCount, payload.radios);
  const safe = (value: number, label: string, positive = false): void => {
    if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0))
      invalidWorkbook(`${label} must be a ${positive ? 'positive' : 'nonnegative'} safe integer`);
  };
  const locations = new Map<string, TransferLocation>();
  for (const location of payload.locations) {
    const key = location.name.toLocaleLowerCase();
    if (locations.has(key))
      invalidWorkbook(`Recovery Locations contains duplicate name "${location.name}"`);
    locations.set(key, location);
  }
  const items = new Map<number, RecoveryItem>();
  const itemNames = new Set<string>();
  for (const item of payload.items) {
    safe(item.code, 'Item Code', true);
    for (const field of [
      'available',
      'borrowed',
      'damaged',
      'lost',
      'revision',
      'startingStock',
      'baselineThroughEventId',
    ] as const)
      safe(item[field], `Recovery item ${item.code} ${field}`);
    if (item.revision > payload.stateRevision)
      invalidWorkbook(`Recovery item ${item.code} revision exceeds the state revision`);
    if (items.has(item.code))
      invalidWorkbook(`Recovery Items contains duplicate Item Code ${item.code}`);
    const nameKey = normalizeItemName(item.name);
    if (itemNames.has(nameKey))
      invalidWorkbook(`Recovery Items contains duplicate Name "${item.name}"`);
    const location =
      item.location == null ? undefined : locations.get(item.location.toLocaleLowerCase());
    if (item.location != null && !location)
      invalidWorkbook(`Recovery item ${item.code} references unknown Location "${item.location}"`);
    if (!item.archived && location?.archived)
      invalidWorkbook(`Recovery item ${item.code} is active at an archived location`);
    const resetTotal =
      item.kind === 'consumable'
        ? item.available
        : item.available + item.borrowed + item.damaged + item.lost;
    if (!Number.isSafeInteger(resetTotal))
      invalidWorkbook(`Recovery item ${item.code} reset total exceeds safe integer range`);
    if (item.kind !== 'consumable' && item.lotSize != null)
      invalidWorkbook(`Recovery item ${item.code} defines a Lot Size but is not consumable`);
    if (
      item.kind === 'consumable' &&
      (item.borrowed !== 0 || item.damaged !== 0 || item.lost !== 0)
    )
      invalidWorkbook(`Recovery consumable ${item.code} has unsupported balances`);
    if (
      item.archived &&
      (item.available !== 0 || item.borrowed !== 0 || item.damaged !== 0 || item.lost !== 0)
    )
      invalidWorkbook(`Recovery item ${item.code} is archived with unresolved inventory state`);
    items.set(item.code, item);
    itemNames.add(nameKey);
  }
  const borrowers = new Map<string, TransferBorrower>();
  for (const borrower of payload.borrowers) {
    const key = borrower.username.toLocaleLowerCase();
    if (borrowers.has(key))
      invalidWorkbook(`Recovery Borrowers contains duplicate Username "${borrower.username}"`);
    borrowers.set(key, borrower);
  }
  const eventKinds = new Set<EventKind>([
    'stock_added',
    'stock_removed',
    'issued',
    'checked_out',
    'returned_usable',
    'returned_damaged',
    'marked_lost',
    'found_returned',
    'found_returned_damaged',
    'repaired',
    'written_off',
  ]);
  const relatedKinds = new Set<EventKind>([
    'returned_usable',
    'returned_damaged',
    'marked_lost',
    'found_returned',
    'found_returned_damaged',
  ]);
  const events = new Map<number, TransferEvent>();
  let previousId = 0;
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (const event of payload.events) {
    safe(event.id, 'Recovery Event ID', true);
    safe(event.quantity, `Recovery event ${event.id} Quantity`, true);
    if (!eventKinds.has(event.kind))
      invalidWorkbook(`Recovery event ${event.id} has unsupported Kind`);
    if (event.id <= previousId)
      invalidWorkbook('Recovery Events must be ordered by strictly increasing Event ID');
    const timestamp = utcTimestamp(event.createdAt);
    if (timestamp < previousTimestamp)
      invalidWorkbook(`Recovery event ${event.id} occurs before the preceding event timestamp`);
    previousId = event.id;
    previousTimestamp = timestamp;
    const item = items.get(event.itemCode);
    if (!item)
      invalidWorkbook(`Recovery event ${event.id} references unknown Item Code ${event.itemCode}`);
    if (timestamp < utcTimestamp(item.createdAt))
      invalidWorkbook(
        `Recovery event ${event.id} occurs before item ${event.itemCode} was created`,
      );
    const borrower =
      event.borrowerUsername == null
        ? null
        : borrowers.get(event.borrowerUsername.toLocaleLowerCase());
    if (event.borrowerUsername != null && !borrower)
      invalidWorkbook(
        `Recovery event ${event.id} references unknown Borrower Username "${event.borrowerUsername}"`,
      );
    if (borrower && timestamp < utcTimestamp(borrower.createdAt))
      invalidWorkbook(`Recovery event ${event.id} occurs before its borrower was created`);
    if (event.kind === 'checked_out') {
      if (item.kind !== 'non_consumable' || !borrower || event.relatedEventId != null)
        invalidWorkbook(
          `Recovery checkout ${event.id} has invalid item, borrower, or related event`,
        );
    } else if (relatedKinds.has(event.kind)) {
      const related = event.relatedEventId == null ? undefined : events.get(event.relatedEventId);
      if (
        !related ||
        related.kind !== 'checked_out' ||
        related.itemCode !== event.itemCode ||
        related.borrowerUsername?.toLocaleLowerCase() !==
          event.borrowerUsername?.toLocaleLowerCase()
      )
        invalidWorkbook(`Recovery event ${event.id} references a missing or mismatched checkout`);
    } else if (event.borrowerUsername != null || event.relatedEventId != null)
      invalidWorkbook(`Recovery event ${event.id} cannot reference a borrower or checkout`);
    if (event.kind === 'issued' && item.kind !== 'consumable')
      invalidWorkbook(`Recovery event ${event.id} issues an item that is not consumable`);
    events.set(event.id, event);
  }
  for (const item of payload.items)
    if (
      item.baselineThroughEventId !== 0 &&
      events.get(item.baselineThroughEventId)?.itemCode !== item.code
    )
      invalidWorkbook(
        `Recovery item ${item.code} references missing Baseline Through Event ID ${item.baselineThroughEventId}`,
      );

  const loans = new Set<number>();
  const totals = new Map<number, { borrowed: number; lost: number }>();
  for (const loan of payload.loans) {
    safe(loan.checkoutId, 'Recovery Loan Checkout ID', true);
    safe(loan.itemCode, `Recovery loan ${loan.checkoutId} Item Code`, true);
    safe(loan.quantity, `Recovery loan ${loan.checkoutId} Quantity`, true);
    safe(loan.outstanding, `Recovery loan ${loan.checkoutId} Outstanding`);
    safe(loan.lost, `Recovery loan ${loan.checkoutId} Lost`);
    if (loans.has(loan.checkoutId))
      invalidWorkbook(`Recovery Loans contains duplicate checkout ${loan.checkoutId}`);
    loans.add(loan.checkoutId);
    const item = items.get(loan.itemCode);
    const borrower = borrowers.get(loan.borrowerUsername.toLocaleLowerCase());
    const checkout = events.get(loan.checkoutId);
    if (
      !item ||
      !borrower ||
      !checkout ||
      checkout.kind !== 'checked_out' ||
      checkout.itemCode !== loan.itemCode ||
      checkout.borrowerUsername?.toLocaleLowerCase() !==
        loan.borrowerUsername.toLocaleLowerCase() ||
      checkout.quantity !== loan.quantity
    )
      invalidWorkbook(`Recovery loan ${loan.checkoutId} has an invalid checkout identity`);
    if (
      utcTimestamp(loan.createdAt) < utcTimestamp(item.createdAt) ||
      utcTimestamp(loan.createdAt) < utcTimestamp(borrower.createdAt)
    )
      invalidWorkbook(`Recovery loan ${loan.checkoutId} precedes its item or borrower`);
    if (loan.outstanding + loan.lost > loan.quantity)
      invalidWorkbook(`Recovery loan ${loan.checkoutId} exceeds its original quantity`);
    if (borrower.archived && loan.outstanding > 0)
      invalidWorkbook(`Recovery borrower "${borrower.username}" is archived with unresolved loans`);
    const aggregate = totals.get(loan.itemCode) ?? { borrowed: 0, lost: 0 };
    aggregate.borrowed += loan.outstanding;
    aggregate.lost += loan.lost;
    if (!Number.isSafeInteger(aggregate.borrowed) || !Number.isSafeInteger(aggregate.lost))
      invalidWorkbook(`Recovery item ${loan.itemCode} loan totals exceed safe integer range`);
    totals.set(loan.itemCode, aggregate);
  }
  for (const event of payload.events)
    if (event.kind === 'checked_out' && !loans.has(event.id))
      invalidWorkbook(`Recovery checkout ${event.id} has no operational loan state`);
  for (const item of payload.items) {
    const aggregate = totals.get(item.code) ?? { borrowed: 0, lost: 0 };
    if (item.borrowed !== aggregate.borrowed || item.lost !== aggregate.lost)
      invalidWorkbook(`Recovery item ${item.code} balances do not match operational loans`);
  }
  return payload;
}

export class InventoryTransferService {
  constructor(private readonly db: InventoryDatabase) {}

  snapshot(): InventoryTransferSnapshot {
    return readTransaction(this.db, () => this.snapshotInTransaction());
  }

  private snapshotInTransaction(): InventoryTransferSnapshot {
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
          `SELECT i.*, l.name location_name,b.quantity starting_stock,
          b.through_event_id baseline_through_event_id,
          s.available,s.borrowed,s.damaged,s.lost,s.revision
          FROM items i LEFT JOIN locations l ON l.id=i.location_id
          LEFT JOIN inventory_baselines b ON b.item_id=i.id
          LEFT JOIN item_state s ON s.item_id=i.id ORDER BY i.code`,
        )
        .all() as Row[]
    ).map((row) => {
      for (const field of [
        'available',
        'borrowed',
        'damaged',
        'lost',
        'revision',
        'starting_stock',
        'baseline_through_event_id',
      ])
        if (
          typeof row[field] !== 'number' ||
          !Number.isSafeInteger(row[field]) ||
          Number(row[field]) < 0
        )
          throw new DomainError(
            'integrity_error',
            `Missing or invalid ${field} for item ${row.code}`,
            500,
          );
      const available = Number(row.available);
      const resetTotal =
        row.kind === 'consumable'
          ? available
          : available + Number(row.borrowed) + Number(row.damaged) + Number(row.lost);
      if (!Number.isSafeInteger(resetTotal))
        throw new DomainError('integrity_error', 'Reset total exceeds safe integer range', 500);
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
        available,
        borrowed: Number(row.borrowed),
        damaged: Number(row.damaged),
        lost: Number(row.lost),
        revision: Number(row.revision),
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
    const loans = (
      this.db
        .prepare(
          `SELECT l.checkout_id,i.code item_code,b.username borrower_username,
        l.quantity,l.created_at,l.outstanding,l.lost
        FROM loan_state l JOIN items i ON i.id=l.item_id
        JOIN borrowers b ON b.id=l.borrower_id ORDER BY l.checkout_id`,
        )
        .all() as Row[]
    ).map((row) => ({
      checkoutId: Number(row.checkout_id),
      itemCode: Number(row.item_code),
      borrowerUsername: String(row.borrower_username),
      quantity: Number(row.quantity),
      createdAt: String(row.created_at),
      outstanding: Number(row.outstanding),
      lost: Number(row.lost),
    }));
    const clock = this.db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get() as
      Row | undefined;
    if (!clock || typeof clock.revision !== 'number' || !Number.isSafeInteger(clock.revision))
      throw new DomainError('integrity_error', 'State revision is missing or invalid', 500);
    const fleet = new RadioService(this.db).fleet();
    return {
      locations,
      items,
      borrowers,
      events,
      loans,
      stateRevision: Number(clock.revision),
      radioCount: fleet.count,
      radios: fleet.radios,
    };
  }

  replaceWithReset(payload: ResetPayload): void {
    for (const item of payload.items)
      if (!Number.isSafeInteger(item.total) || item.total < 0 || (item.archived && item.total > 0))
        invalidWorkbook(`Reset item ${item.code} has invalid total or archived stock`);
    transaction(this.db, () => {
      this.rotateLedgerEpoch();
      this.db.prepare('DELETE FROM idempotency_receipts').run();
      this.db.prepare('DELETE FROM inventory_command_receipts').run();
      this.db.prepare('UPDATE inventory_replacement_guard SET enabled=1 WHERE singleton=1').run();
      this.db.prepare('DELETE FROM loan_state').run();
      this.db.prepare('DELETE FROM item_state').run();
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
      const insertState = this.db.prepare('INSERT INTO item_state(item_id,available) VALUES (?,?)');
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
        insertState.run(itemId, item.total);
        for (const alias of item.aliases) insertAlias.run(itemId, alias);
        const baselineEventId =
          item.total === 0
            ? 0
            : Number(insertEvent.run(itemId, item.total, 'Reset baseline import').lastInsertRowid);
        insertBaseline.run(itemId, item.total, baselineEventId);
      }
      this.db.prepare('UPDATE state_clock SET revision=0 WHERE singleton=1').run();
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
    payload = validateRecoveryPayload(payload);
    transaction(this.db, () => {
      new RadioService(this.db).restore(payload.radioCount, payload.radios);
      this.rotateLedgerEpoch();
      this.db.prepare('DELETE FROM idempotency_receipts').run();
      this.db.prepare('DELETE FROM inventory_command_receipts').run();
      this.db.prepare('UPDATE inventory_replacement_guard SET enabled=1 WHERE singleton=1').run();
      this.db.prepare('DELETE FROM loan_state').run();
      this.db.prepare('DELETE FROM item_state').run();
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
      const insertState = this.db
        .prepare(`INSERT INTO item_state(item_id,available,borrowed,damaged,lost,revision)
        VALUES (?,?,?,?,?,?)`);
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
        insertState.run(
          itemId,
          item.available,
          item.borrowed,
          item.damaged,
          item.lost,
          item.revision,
        );
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
      const insertLoan = this.db.prepare(`INSERT INTO loan_state(
        checkout_id,item_id,borrower_id,quantity,created_at,outstanding,lost
      ) VALUES (?,?,?,?,?,?,?)`);
      for (const loan of payload.loans)
        insertLoan.run(
          loan.checkoutId,
          itemIds.get(loan.itemCode)!,
          borrowerIds.get(loan.borrowerUsername.toLocaleLowerCase())!,
          loan.quantity,
          loan.createdAt,
          loan.outstanding,
          loan.lost,
        );
      this.db
        .prepare('UPDATE state_clock SET revision=? WHERE singleton=1')
        .run(payload.stateRevision);
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
