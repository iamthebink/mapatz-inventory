import type { InventoryDatabase } from '../db/database.js';
import { readTransaction, transaction } from '../db/database.js';
import {
  allocateIdentity,
  getIdentityHighWater,
  persistIdentityHighWater,
  type IdentityHighWater,
} from '../db/identity-high-water.js';
import {
  borrowerIdentity,
  isValidBorrowerProfile,
  trimBorrowerProfile,
} from './borrower-profile.js';
import { normalizeItemName } from './item-name.js';
import { DomainError, type EventKind, type ItemKind } from './types.js';
import type { Radio } from './types.js';
import { RadioService, validateRadioFleet } from './radios.js';

type Row = Record<string, unknown>;

export interface TransferLocation {
  name: string;
  archived: boolean;
  isDefault: boolean;
}

export interface TransferItem {
  id: number;
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
  itemId: number;
  borrowerId: number;
  quantity: number;
  createdAt: string;
  outstanding: number;
  lost: number;
}

export interface TransferBorrower {
  id: number;
  playaName: string;
  fullName: string;
  phoneNumber: string;
  campDepartment: string;
  archived: boolean;
  createdAt: string;
}

export interface TransferEvent {
  locationName: string | null;
  locationCode: string | null;
  id: number;
  kind: EventKind;
  itemId: number;
  borrowerId: number | null;
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
  identityHighWater: IdentityHighWater;
  radioCount: number;
  radios: Radio[];
}

export interface ResetItem {
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
  identityHighWater: IdentityHighWater;
  radioCount: number;
  radios: Radio[];
}

export interface UnresolvedDamageReportRow {
  itemName: string;
  location: string | null;
  unresolvedDamagedQuantity: number;
}

export interface ConsumablesUsageReportRow {
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
      itemName: item.name,
      location: item.location,
      unresolvedDamagedQuantity: item.damaged,
    }));
}

export function consumablesUsageReport(
  snapshot: InventoryTransferSnapshot,
): ConsumablesUsageReportRow[] {
  const identities = new Map<number, TransferItem[]>();
  for (const item of snapshot.items)
    if (item.kind === 'consumable')
      identities.set(item.id, [...(identities.get(item.id) ?? []), item]);
  return [...identities.values()].map((placements) => {
    const item = placements[0]!;
    const events = snapshot.events.filter(
      (e) => e.itemId === item.id && e.id > item.baselineThroughEventId,
    );
    return {
      itemName: item.name,
      location: placements.map((p) => p.location).join(', '),
      startOfCycleStock: item.startingStock,
      addedDuringCycle: events
        .filter((e) => e.kind === 'stock_added')
        .reduce((t, e) => t + e.quantity, 0),
      usage: events.filter((e) => e.kind === 'issued').reduce((t, e) => t + e.quantity, 0),
      left: placements.reduce((t, p) => t + p.available, 0),
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

function identityMetadata(item: ResetItem | RecoveryItem): string {
  const common = {
    name: normalizeItemName(item.name),
    kind: item.kind,
    aliases: [...item.aliases].sort(),
    lotSize: item.lotSize,
    archived: item.archived,
  };
  return JSON.stringify(
    'id' in item
      ? {
          ...common,
          id: item.id,
          createdAt: item.createdAt,
          startingStock: item.startingStock,
          baselineThroughEventId: item.baselineThroughEventId,
          borrowed: item.borrowed,
          lost: item.lost,
          revision: item.revision,
        }
      : common,
  );
}

export function validateResetPayload(payload: ResetPayload): ResetPayload {
  const locations = new Map(payload.locations.map((l) => [l.name.toLocaleLowerCase(), l]));
  if (
    locations.size !== payload.locations.length ||
    payload.locations.filter((l) => l.isDefault).length > 1 ||
    payload.locations.some((l) => l.isDefault && l.archived)
  )
    invalidWorkbook('Invalid or duplicate reset locations/default');
  const identities = new Map<string, ResetItem>();
  const placements = new Set<string>();
  const totals = new Map<string, number>();
  for (const item of payload.items) {
    if (!Number.isSafeInteger(item.total) || item.total < 0 || (item.archived && item.total > 0))
      invalidWorkbook('Invalid reset quantity');
    const location = locations.get(item.location?.toLocaleLowerCase() ?? '');
    if (!location || location.archived) invalidWorkbook('Reset items require an active location');
    const key = normalizeItemName(item.name);
    const placement = JSON.stringify([key, location.name.toLocaleLowerCase()]);
    if (placements.has(placement)) invalidWorkbook('Duplicate reset placement');
    placements.add(placement);
    const identity = identities.get(key);
    if (identity && identityMetadata(identity) !== identityMetadata(item))
      invalidWorkbook('Reset identity metadata disagrees');
    identities.set(key, item);
    const total = (totals.get(key) ?? 0) + item.total;
    if (!Number.isSafeInteger(total)) invalidWorkbook('Reset totals exceed safe integer range');
    totals.set(key, total);
  }
  return payload;
}

export function validateRecoveryPayload(payload: RecoveryPayload): RecoveryPayload {
  const identityFields = ['nextItemId', 'nextBorrowerId', 'nextLocationId', 'nextEventId'] as const;
  if (
    !payload ||
    !Array.isArray(payload.locations) ||
    !Array.isArray(payload.items) ||
    !Array.isArray(payload.borrowers) ||
    !Array.isArray(payload.events) ||
    !Array.isArray(payload.loans) ||
    !Number.isSafeInteger(payload.stateRevision) ||
    payload.stateRevision < 0 ||
    !payload.identityHighWater ||
    typeof payload.identityHighWater !== 'object' ||
    Array.isArray(payload.identityHighWater) ||
    Object.keys(payload.identityHighWater).length !== identityFields.length ||
    identityFields.some((field) => !Object.hasOwn(payload.identityHighWater, field))
  )
    invalidWorkbook('Recovery is missing authoritative state or required tables');
  payload = normalizeRecoveryTimestamps(payload);
  validateRadioFleet(payload.radioCount, payload.radios);
  const safe = (value: number, label: string, positive = false): void => {
    if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0))
      invalidWorkbook(`${label} must be a ${positive ? 'positive' : 'nonnegative'} safe integer`);
  };
  for (const field of identityFields)
    safe(payload.identityHighWater[field], `Recovery ${field}`, true);
  const locations = new Map<string, TransferLocation>();
  for (const location of payload.locations) {
    const key = location.name.toLocaleLowerCase();
    if (locations.has(key))
      invalidWorkbook(`Recovery Locations contains duplicate name "${location.name}"`);
    locations.set(key, location);
  }
  if (
    payload.locations.filter((l) => l.isDefault).length > 1 ||
    payload.locations.some((l) => l.isDefault && l.archived)
  )
    invalidWorkbook('Invalid recovery default');
  const items = new Map<number, RecoveryItem>();
  const placements = new Set<string>();
  const physicalTotals = new Map<number, number>();
  const itemNames = new Set<string>();
  for (const item of payload.items) {
    safe(item.id, 'Item ID', true);
    for (const field of [
      'available',
      'borrowed',
      'damaged',
      'lost',
      'revision',
      'startingStock',
      'baselineThroughEventId',
    ] as const)
      safe(item[field], `Recovery item ${item.id} ${field}`);
    if (item.revision > payload.stateRevision)
      invalidWorkbook(`Recovery item ${item.id} revision exceeds the state revision`);
    const existing = items.get(item.id);
    if (existing && identityMetadata(existing) !== identityMetadata(item))
      invalidWorkbook(`Recovery item ${item.id} metadata disagrees`);
    const placement = JSON.stringify([item.id, item.location?.toLocaleLowerCase()]);
    if (placements.has(placement)) invalidWorkbook('Recovery Items contains duplicate placement');
    placements.add(placement);
    const physical = (physicalTotals.get(item.id) ?? 0) + item.available + item.damaged;
    if (!Number.isSafeInteger(physical + item.borrowed + item.lost))
      invalidWorkbook('Recovery total exceeds safe integer range');
    physicalTotals.set(item.id, physical);
    const nameKey = normalizeItemName(item.name);
    if (!existing && itemNames.has(nameKey))
      invalidWorkbook(`Recovery Items contains duplicate Name "${item.name}"`);
    const location =
      item.location == null ? undefined : locations.get(item.location.toLocaleLowerCase());
    if (!location)
      invalidWorkbook(`Recovery item ${item.id} references unknown Location "${item.location}"`);
    if (location?.archived)
      invalidWorkbook(`Recovery item ${item.id} references an archived location`);
    const resetTotal =
      item.kind === 'consumable'
        ? item.available
        : item.available + item.borrowed + item.damaged + item.lost;
    if (!Number.isSafeInteger(resetTotal))
      invalidWorkbook(`Recovery item ${item.id} reset total exceeds safe integer range`);
    if (item.kind !== 'consumable' && item.lotSize != null)
      invalidWorkbook(`Recovery item ${item.id} defines a Lot Size but is not consumable`);
    if (
      item.kind === 'consumable' &&
      (item.borrowed !== 0 || item.damaged !== 0 || item.lost !== 0)
    )
      invalidWorkbook(`Recovery consumable ${item.id} has unsupported balances`);
    if (
      item.archived &&
      (item.available !== 0 || item.borrowed !== 0 || item.damaged !== 0 || item.lost !== 0)
    )
      invalidWorkbook(`Recovery item ${item.id} is archived with unresolved inventory state`);
    items.set(item.id, item);
    itemNames.add(nameKey);
  }
  const borrowers = new Map<number, TransferBorrower>();
  const borrowerProfiles = new Set<string>();
  for (const borrower of payload.borrowers) {
    safe(borrower.id, 'Recovery Borrower ID', true);
    if (!isValidBorrowerProfile(borrower))
      invalidWorkbook('Recovery Borrowers contains invalid profile');
    if (typeof borrower.archived !== 'boolean')
      invalidWorkbook('Recovery Borrowers contains invalid Archived value');
    utcTimestamp(borrower.createdAt);
    const key = borrowerIdentity(borrower);
    if (borrowers.has(borrower.id))
      invalidWorkbook(`Recovery Borrowers contains duplicate Borrower ID ${borrower.id}`);
    if (borrowerProfiles.has(key))
      invalidWorkbook(`Recovery Borrowers contains duplicate profile "${borrower.fullName}"`);
    if (borrower.id >= payload.identityHighWater.nextBorrowerId)
      invalidWorkbook('Recovery Borrower ID exceeds high-water mark');
    borrowerProfiles.add(key);
    borrowers.set(borrower.id, borrower);
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
    'transferred_out',
    'transferred_in',
    'damaged_transferred_out',
    'damaged_transferred_in',
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
    if (event.borrowerId != null) safe(event.borrowerId, 'Recovery Event Borrower ID', true);
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
    const item = items.get(event.itemId);
    if (!item)
      invalidWorkbook(`Recovery event ${event.id} references unknown Item ID ${event.itemId}`);
    if (timestamp < utcTimestamp(item.createdAt))
      invalidWorkbook(`Recovery event ${event.id} occurs before item ${event.itemId} was created`);
    const borrower = event.borrowerId == null ? null : borrowers.get(event.borrowerId);
    if (event.borrowerId != null && !borrower)
      invalidWorkbook(
        `Recovery event ${event.id} references unknown Borrower ID "${event.borrowerId}"`,
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
        related.itemId !== event.itemId ||
        related.borrowerId !== event.borrowerId
      )
        invalidWorkbook(`Recovery event ${event.id} references a missing or mismatched checkout`);
    } else if (event.borrowerId != null || event.relatedEventId != null)
      invalidWorkbook(`Recovery event ${event.id} cannot reference a borrower or checkout`);
    if (event.kind === 'issued' && item.kind !== 'consumable')
      invalidWorkbook(`Recovery event ${event.id} issues an item that is not consumable`);
    if (event.kind !== 'marked_lost' && (!event.locationName || !event.locationCode))
      invalidWorkbook('Recovery physical event is missing location attribution');
    events.set(event.id, event);
  }
  if (payload.identityHighWater.nextEventId <= previousId)
    invalidWorkbook('Recovery Event ID high-water mark must be greater than every retained event');
  for (const item of payload.items) {
    const anchor = events.get(item.baselineThroughEventId);
    if (item.baselineThroughEventId !== 0 && anchor && anchor.itemId !== item.id)
      invalidWorkbook(
        `Recovery item ${item.id} references Baseline Through Event ID ${item.baselineThroughEventId} for another item`,
      );
    // A deleted event may leave a numeric reporting cursor. It is not a foreign key:
    // its value remains the exact cutoff and event ids are never allocated below it.
    if (
      item.baselineThroughEventId !== 0 &&
      !anchor &&
      item.baselineThroughEventId >= payload.identityHighWater.nextEventId
    )
      invalidWorkbook(
        `Recovery item ${item.id} has Baseline Through Event ID beyond the event high-water mark`,
      );
  }

  const loans = new Set<number>();
  const totals = new Map<number, { borrowed: number; lost: number }>();
  for (const loan of payload.loans) {
    safe(loan.checkoutId, 'Recovery Loan Checkout ID', true);
    safe(loan.borrowerId, 'Recovery Loan Borrower ID', true);
    safe(loan.itemId, `Recovery loan ${loan.checkoutId} Item ID`, true);
    safe(loan.quantity, `Recovery loan ${loan.checkoutId} Quantity`, true);
    safe(loan.outstanding, `Recovery loan ${loan.checkoutId} Outstanding`);
    safe(loan.lost, `Recovery loan ${loan.checkoutId} Lost`);
    if (loans.has(loan.checkoutId))
      invalidWorkbook(`Recovery Loans contains duplicate checkout ${loan.checkoutId}`);
    loans.add(loan.checkoutId);
    const item = items.get(loan.itemId);
    const borrower = borrowers.get(loan.borrowerId);
    const checkout = events.get(loan.checkoutId);
    if (
      !item ||
      !borrower ||
      !checkout ||
      checkout.kind !== 'checked_out' ||
      checkout.itemId !== loan.itemId ||
      checkout.borrowerId !== loan.borrowerId ||
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
      invalidWorkbook(`Recovery borrower "${borrower.fullName}" is archived with unresolved loans`);
    const aggregate = totals.get(loan.itemId) ?? { borrowed: 0, lost: 0 };
    aggregate.borrowed += loan.outstanding;
    aggregate.lost += loan.lost;
    if (!Number.isSafeInteger(aggregate.borrowed) || !Number.isSafeInteger(aggregate.lost))
      invalidWorkbook(`Recovery item ${loan.itemId} loan totals exceed safe integer range`);
    totals.set(loan.itemId, aggregate);
  }
  for (const event of payload.events)
    if (event.kind === 'checked_out' && !loans.has(event.id))
      invalidWorkbook(`Recovery checkout ${event.id} has no operational loan state`);
  for (const item of payload.items) {
    const aggregate = totals.get(item.id) ?? { borrowed: 0, lost: 0 };
    if (item.borrowed !== aggregate.borrowed || item.lost !== aggregate.lost)
      invalidWorkbook(`Recovery item ${item.id} balances do not match operational loans`);
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
        .prepare(
          'SELECT name, archived, (id=(SELECT default_location_id FROM inventory_settings WHERE singleton=1)) is_default FROM locations ORDER BY name COLLATE NOCASE',
        )
        .all() as Row[]
    ).map((row) => ({
      name: String(row.name),
      archived: Boolean(row.archived),
      isDefault: Boolean(row.is_default),
    }));
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
          p.available,s.borrowed,p.damaged,s.lost,s.revision
          FROM items i JOIN item_location_balances p ON p.item_id=i.id JOIN locations l ON l.id=p.location_id
          LEFT JOIN inventory_baselines b ON b.item_id=i.id
          LEFT JOIN item_state s ON s.item_id=i.id ORDER BY i.name COLLATE NOCASE`,
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
            `Missing or invalid ${field} for item ${row.id}`,
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
        id: Number(row.id),
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
      this.db.prepare('SELECT * FROM borrowers ORDER BY full_name,id').all() as Row[]
    ).map((row) => ({
      id: Number(row.id),
      playaName: String(row.playa_name),
      fullName: String(row.full_name),
      phoneNumber: String(row.phone_number),
      campDepartment: String(row.camp_department),
      archived: Boolean(row.archived),
      createdAt: String(row.created_at),
    }));
    const events = (
      this.db
        .prepare(
          `SELECT e.id,e.kind,i.id item_id,b.id borrower_id,e.quantity,
          e.related_event_id,e.note,e.created_at,e.location_name,e.location_code FROM inventory_events e
          JOIN items i ON i.id=e.item_id LEFT JOIN borrowers b ON b.id=e.borrower_id ORDER BY e.id`,
        )
        .all() as Row[]
    ).map((row) => ({
      id: Number(row.id),
      kind: row.kind as EventKind,
      locationName: row.location_name == null ? null : String(row.location_name),
      locationCode: row.location_code == null ? null : String(row.location_code),
      itemId: Number(row.item_id),
      borrowerId: row.borrower_id == null ? null : Number(row.borrower_id),
      quantity: Number(row.quantity),
      relatedEventId: row.related_event_id == null ? null : Number(row.related_event_id),
      note: String(row.note),
      createdAt: String(row.created_at),
    }));
    const loans = (
      this.db
        .prepare(
          `SELECT l.checkout_id,i.id item_id,b.id borrower_id,
        l.quantity,l.created_at,l.outstanding,l.lost
        FROM loan_state l JOIN items i ON i.id=l.item_id
        JOIN borrowers b ON b.id=l.borrower_id ORDER BY l.checkout_id`,
        )
        .all() as Row[]
    ).map((row) => ({
      checkoutId: Number(row.checkout_id),
      itemId: Number(row.item_id),
      borrowerId: Number(row.borrower_id),
      quantity: Number(row.quantity),
      createdAt: String(row.created_at),
      outstanding: Number(row.outstanding),
      lost: Number(row.lost),
    }));
    const clock = this.db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get() as
      Row | undefined;
    if (!clock || typeof clock.revision !== 'number' || !Number.isSafeInteger(clock.revision))
      throw new DomainError('integrity_error', 'State revision is missing or invalid', 500);
    const identityHighWater = getIdentityHighWater(this.db);
    const fleet = new RadioService(this.db).fleet();
    return {
      locations,
      items,
      borrowers,
      events,
      loans,
      stateRevision: Number(clock.revision),
      identityHighWater,
      radioCount: fleet.count,
      radios: fleet.radios,
    };
  }

  replaceWithReset(payload: ResetPayload): void {
    payload = validateResetPayload(payload);
    transaction(this.db, () => {
      const previousHighWater = getIdentityHighWater(this.db);
      this.rotateLedgerEpoch();
      this.db.prepare('DELETE FROM idempotency_receipts').run();
      this.db.prepare('DELETE FROM inventory_command_receipts').run();
      persistIdentityHighWater(this.db, previousHighWater);
      this.db.prepare('UPDATE inventory_replacement_guard SET enabled=1 WHERE singleton=1').run();
      this.db.prepare('DELETE FROM loan_state').run();
      this.db.prepare('DELETE FROM item_location_balances').run();
      this.db
        .prepare('UPDATE inventory_settings SET default_location_id=NULL WHERE singleton=1')
        .run();
      this.db.prepare('DELETE FROM item_state').run();
      this.db.prepare('DELETE FROM inventory_events').run();
      this.db.prepare('DELETE FROM inventory_baselines').run();
      this.db.prepare('DELETE FROM item_aliases').run();
      this.db.prepare('DELETE FROM items').run();
      this.db.prepare('DELETE FROM borrowers').run();
      this.db.prepare('DELETE FROM locations').run();

      const locationIds = new Map<string, number>();
      const insertLocation = this.db.prepare(
        'INSERT INTO locations(id,code,name,archived) VALUES (?,?,?,?)',
      );
      payload.locations.forEach((location, index) => {
        const locationId = allocateIdentity(this.db, 'location');
        insertLocation.run(
          locationId,
          `import-location-${index + 1}`,
          location.name,
          Number(location.archived),
        );
        locationIds.set(location.name.toLocaleLowerCase(), locationId);
        if (location.isDefault)
          this.db
            .prepare('UPDATE inventory_settings SET default_location_id=? WHERE singleton=1')
            .run(locationId);
      });

      const identities = new Map<string, ResetItem[]>();
      for (const item of payload.items) {
        const key = normalizeItemName(item.name);
        identities.set(key, [...(identities.get(key) ?? []), item]);
      }
      for (const placements of identities.values()) {
        const item = placements[0]!;
        const itemId = allocateIdentity(this.db, 'item');
        this.db
          .prepare('INSERT INTO items(id,name,kind,lot_size,archived) VALUES (?,?,?,?,?)')
          .run(itemId, item.name, item.kind, item.lotSize, Number(item.archived));
        this.db.prepare('INSERT INTO item_state(item_id) VALUES (?)').run(itemId);
        for (const alias of item.aliases)
          this.db
            .prepare('INSERT INTO item_aliases(item_id,alias) VALUES (?,?)')
            .run(itemId, alias);
        let lastEvent = 0;
        let total = 0;
        for (const placement of placements) {
          const locationId = locationIds.get(placement.location!.toLocaleLowerCase())!;
          this.db
            .prepare(
              'INSERT INTO item_location_balances(item_id,location_id,available) VALUES (?,?,?)',
            )
            .run(itemId, locationId, placement.total);
          total += placement.total;
          if (placement.total) {
            lastEvent = allocateIdentity(this.db, 'event');
            const location = this.db
              .prepare('SELECT name,code FROM locations WHERE id=?')
              .get(locationId)!;
            this.db
              .prepare(
                "INSERT INTO inventory_events(id,kind,item_id,quantity,note,location_name,location_code) VALUES (?,'stock_added',?,?,'Reset baseline import',?,?)",
              )
              .run(
                lastEvent,
                itemId,
                placement.total,
                String(location.name),
                String(location.code),
              );
          }
        }
        this.db
          .prepare(
            'INSERT INTO inventory_baselines(item_id,quantity,through_event_id) VALUES (?,?,?)',
          )
          .run(itemId, total, lastEvent);
      }
      this.db.prepare('UPDATE state_clock SET revision=0 WHERE singleton=1').run();
      this.db.prepare('UPDATE inventory_replacement_guard SET enabled=0 WHERE singleton=1').run();
    });
  }

  replaceWithRecovery(payload: RecoveryPayload): void {
    payload = validateRecoveryPayload(payload);
    transaction(this.db, () => {
      const previousHighWater = getIdentityHighWater(this.db);
      new RadioService(this.db).restore(payload.radioCount, payload.radios);
      this.rotateLedgerEpoch();
      this.db.prepare('DELETE FROM idempotency_receipts').run();
      this.db.prepare('DELETE FROM inventory_command_receipts').run();
      persistIdentityHighWater(this.db, {
        nextItemId: Math.max(previousHighWater.nextItemId, payload.identityHighWater.nextItemId),
        nextBorrowerId: Math.max(
          previousHighWater.nextBorrowerId,
          payload.identityHighWater.nextBorrowerId,
        ),
        nextLocationId: Math.max(
          previousHighWater.nextLocationId,
          payload.identityHighWater.nextLocationId,
        ),
        nextEventId: Math.max(previousHighWater.nextEventId, payload.identityHighWater.nextEventId),
      });
      this.db.prepare('UPDATE inventory_replacement_guard SET enabled=1 WHERE singleton=1').run();
      this.db.prepare('DELETE FROM loan_state').run();
      this.db.prepare('DELETE FROM item_location_balances').run();
      this.db
        .prepare('UPDATE inventory_settings SET default_location_id=NULL WHERE singleton=1')
        .run();
      this.db.prepare('DELETE FROM item_state').run();
      this.db.prepare('DELETE FROM inventory_events').run();
      this.db.prepare('DELETE FROM inventory_baselines').run();
      this.db.prepare('DELETE FROM item_aliases').run();
      this.db.prepare('DELETE FROM items').run();
      this.db.prepare('DELETE FROM borrowers').run();
      this.db.prepare('DELETE FROM locations').run();

      const locationIds = new Map<string, number>();
      const insertLocation = this.db.prepare(
        'INSERT INTO locations(id,code,name,archived) VALUES (?,?,?,?)',
      );
      payload.locations.forEach((location, index) => {
        const locationId = allocateIdentity(this.db, 'location');
        insertLocation.run(
          locationId,
          `recovered-location-${index + 1}`,
          location.name,
          Number(location.archived),
        );
        locationIds.set(location.name.toLocaleLowerCase(), locationId);
        if (location.isDefault)
          this.db
            .prepare('UPDATE inventory_settings SET default_location_id=? WHERE singleton=1')
            .run(locationId);
      });

      const itemIds = new Map<number, number>();
      for (const item of payload.items) {
        let itemId = itemIds.get(item.id);
        if (itemId === undefined) {
          itemId = allocateIdentity(this.db, 'item');
          itemIds.set(item.id, itemId);
          this.db
            .prepare(
              'INSERT INTO items(id,name,kind,lot_size,archived,created_at) VALUES (?,?,?,?,?,?)',
            )
            .run(itemId, item.name, item.kind, item.lotSize, Number(item.archived), item.createdAt);
          this.db
            .prepare('INSERT INTO item_state(item_id,borrowed,lost,revision) VALUES (?,?,?,?)')
            .run(itemId, item.borrowed, item.lost, item.revision);
          for (const alias of item.aliases)
            this.db
              .prepare('INSERT INTO item_aliases(item_id,alias) VALUES (?,?)')
              .run(itemId, alias);
        }
        this.db
          .prepare(
            'INSERT INTO item_location_balances(item_id,location_id,available,damaged) VALUES (?,?,?,?)',
          )
          .run(
            itemId,
            locationIds.get(item.location!.toLocaleLowerCase())!,
            item.available,
            item.damaged,
          );
      }

      const borrowerIds = new Map<number, number>();
      const insertBorrower = this.db.prepare(
        `INSERT INTO borrowers(id,playa_name,full_name,phone_number,camp_department,archived,created_at)
        VALUES (?,?,?,?,?,?,?)`,
      );
      for (const borrower of payload.borrowers) {
        const borrowerId = allocateIdentity(this.db, 'borrower');
        const profile = trimBorrowerProfile(borrower);
        insertBorrower.run(
          borrowerId,
          profile.playaName,
          profile.fullName,
          profile.phoneNumber,
          profile.campDepartment,
          Number(borrower.archived),
          borrower.createdAt,
        );
        borrowerIds.set(borrower.id, borrowerId);
      }

      const insertEvent = this.db.prepare(
        `INSERT INTO inventory_events(id,kind,item_id,borrower_id,quantity,related_event_id,note,created_at,location_name,location_code)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const event of payload.events) {
        insertEvent.run(
          event.id,
          event.kind,
          itemIds.get(event.itemId)!,
          event.borrowerId == null ? null : borrowerIds.get(event.borrowerId)!,
          event.quantity,
          event.relatedEventId,
          event.note,
          event.createdAt,
          event.locationName,
          event.locationCode,
        );
      }
      const insertLoan = this.db.prepare(`INSERT INTO loan_state(
        checkout_id,item_id,borrower_id,quantity,created_at,outstanding,lost
      ) VALUES (?,?,?,?,?,?,?)`);
      for (const loan of payload.loans)
        insertLoan.run(
          loan.checkoutId,
          itemIds.get(loan.itemId)!,
          borrowerIds.get(loan.borrowerId)!,
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
      for (const item of new Map(payload.items.map((item) => [item.id, item])).values()) {
        const anchor = payload.events.find((event) => event.id === item.baselineThroughEventId);
        const establishedAt =
          item.baselineThroughEventId === 0
            ? item.createdAt
            : (anchor?.createdAt ?? item.createdAt);
        insertBaseline.run(
          itemIds.get(item.id)!,
          item.startingStock,
          item.baselineThroughEventId,
          establishedAt,
        );
      }
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
