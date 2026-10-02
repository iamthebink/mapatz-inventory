import type {
  BorrowerImportMode,
  BorrowerImportRow,
  BorrowerImportPreview,
  BorrowerImportResult,
} from '../contracts/borrower-import.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { InventoryDatabase } from '../db/database.js';
import { readTransaction, transaction } from '../db/database.js';
import {
  allocateIdentity,
  getIdentityHighWater,
  identityHighWaterReceiptKey,
  persistIdentityHighWater,
} from '../db/identity-high-water.js';
import {
  borrowerIdentity,
  isValidBorrowerProfile,
  normalizeBorrowerText,
  normalizeBorrowerPhone,
  trimBorrowerProfile,
  type BorrowerProfile,
} from './borrower-profile.js';
import { normalizeItemName } from './item-name.js';
import { periodBounds } from './period-summary.js';
import type { PeriodSummary } from '../contracts/period-summary.js';
import type {
  BorrowerDeskSnapshot,
  BorrowerCreateRequest,
  BorrowerCreateResult,
  BorrowerCreateValidation,
  BorrowerMatchKind,
  BorrowerOperationConflict,
  BorrowerOperationRequest,
  BorrowerOperationResult,
  BorrowerSearchSnapshot,
  CommandProtocolError,
} from '../contracts/borrower-workflow.js';
import { DomainError, type Borrower, type EventKind, type Item, type ItemKind } from './types.js';

type Row = Record<string, any>;

const maxAliases = 20;
const itemStateColumns = `s.available,s.borrowed,s.damaged,s.lost,s.revision stockRevision`;
const staleIdentityReceipt = '{"staleIdentity":true}';

type CommandKind = 'borrower_operation' | 'borrower_create';
type Receipt = {
  key: string;
  command_kind: CommandKind;
  ledger_epoch: number;
  contract_version: number;
  request_hash: string;
  outcome: 'committed' | 'rejected';
  subject_id: number | null;
  result_json: string | null;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function integer(value: number, label = 'quantity'): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new DomainError('invalid_quantity', `${label} must be a positive integer`);
  return value;
}

function chunked<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    chunks.push(values.slice(index, index + size));
  return chunks;
}

export class InventoryService {
  // Restarting the service invalidates previews, safely requiring fresh consent.
  private readonly borrowerImportSecret = randomBytes(32);

  previewBorrowerImport(
    rows: BorrowerImportRow[],
    mode: BorrowerImportMode,
  ): BorrowerImportPreview {
    return readTransaction(this.db, () => this.borrowerImportPlan(rows, mode).preview);
  }

  importBorrowers(
    rows: BorrowerImportRow[],
    mode: BorrowerImportMode,
    confirmationToken: string,
  ): BorrowerImportResult {
    return transaction(this.db, () => {
      const plan = this.borrowerImportPlan(rows, mode);
      const supplied = Buffer.from(confirmationToken, 'utf8');
      const expected = Buffer.from(plan.preview.confirmationToken, 'utf8');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        return { outcome: 'confirmation_required', preview: plan.preview };
      let returned = 0;
      for (const borrower of plan.preview.affected) {
        for (const loan of borrower.loans) {
          this.move(
            'returned_usable',
            loan.itemId,
            loan.quantity,
            borrower.id,
            loan.checkoutId,
            'Borrower spreadsheet replacement',
          );
          returned += loan.quantity;
        }
      }
      // Archival preserves immutable event attribution, including already-lost quantities.
      for (const borrower of plan.absent)
        this.db.prepare('UPDATE borrowers SET archived=1 WHERE id=?').run(borrower.id);
      for (const row of rows) {
        const existing = plan.identities.get(borrowerIdentity(row));
        if (existing) {
          this.db.prepare('UPDATE borrowers SET archived=0 WHERE id=?').run(existing.id);
        } else this.createBorrower(row);
      }
      return {
        outcome: 'committed',
        added: plan.preview.added,
        updated: plan.preview.updated,
        archived: plan.preview.archived,
        returned,
      };
    });
  }

  private borrowerImportPlan(rows: BorrowerImportRow[], mode: BorrowerImportMode) {
    if (mode !== 'merge' && mode !== 'replace')
      throw new DomainError('invalid_import', 'Invalid import mode');
    if (!rows.length) throw new DomainError('invalid_import', 'The import must contain borrowers');
    const incoming = new Set<string>();
    for (const [index, row] of rows.entries()) {
      if (!isValidBorrowerProfile(row))
        throw new DomainError(
          'invalid_import',
          `Row ${index + 2} contains invalid borrower fields`,
        );
      const key = borrowerIdentity(row);
      if (incoming.has(key))
        throw new DomainError(
          'invalid_import',
          `Row ${index + 2} contains a duplicate borrower profile`,
        );
      incoming.add(key);
    }
    const borrowers = (this.db.prepare('SELECT * FROM borrowers ORDER BY id').all() as Row[]).map(
      this.borrowerFromRow,
    );
    const identities = new Map<string, Borrower>();
    for (const borrower of borrowers) {
      const key = borrowerIdentity(borrower);
      if (identities.has(key))
        throw new DomainError(
          'ambiguous_borrower',
          `Ambiguous borrower profile: ${borrower.fullName}`,
        );
      identities.set(key, borrower);
    }
    const absent =
      mode === 'replace'
        ? borrowers.filter((borrower) => !incoming.has(borrowerIdentity(borrower)))
        : [];
    const loans = this.listLoans();
    const affected = absent
      .map((borrower) => ({
        id: borrower.id,
        fullName: borrower.fullName,
        playaName: borrower.playaName,
        phoneNumber: borrower.phoneNumber,
        campDepartment: borrower.campDepartment,
        loans: loans
          .filter((loan) => Number(loan.borrowerId) === borrower.id && Number(loan.outstanding) > 0)
          .map((loan) => ({
            checkoutId: Number(loan.checkoutId),
            itemId: Number(loan.itemId),
            itemName: String(loan.itemName),
            quantity: Number(loan.outstanding),
          })),
      }))
      .filter((borrower) => borrower.loans.length > 0);
    const confirmationToken = createHmac('sha256', this.borrowerImportSecret)
      .update(
        stableJson({
          rows,
          mode,
          borrowers,
          affected,
          ledgerEpoch: this.ledgerEpochInTransaction(),
        }),
      )
      .digest('hex');
    const added = rows.filter((row) => !identities.has(borrowerIdentity(row))).length;
    const preview: BorrowerImportPreview = {
      confirmationToken,
      added,
      updated: rows.length - added,
      archived: absent.filter((borrower) => !borrower.archived).length,
      affected,
    };
    return { identities, absent, preview };
  }

  constructor(private readonly db: InventoryDatabase) {}

  inventoryEpoch(): number {
    return this.ledgerEpochInTransaction();
  }

  private requireInventoryEpoch(epoch?: number): void {
    if (epoch !== undefined && epoch !== this.ledgerEpochInTransaction())
      throw new DomainError(
        'stale_ledger',
        'המלאי הוחלף מאז פתיחת הטופס. יש לרענן ולבדוק מחדש.',
        409,
      );
  }

  listLocations(includeArchived = false): Row[] {
    return this.db
      .prepare(
        `SELECT id, code, name, archived FROM locations ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY name`,
      )
      .all()
      .map((row: any) => ({ ...row, archived: Boolean(row.archived) }));
  }

  createLocation(code: string, name: string): Row {
    const create = () => {
      const id = allocateIdentity(this.db, 'location');
      this.db
        .prepare('INSERT INTO locations(id,code,name) VALUES (?,?,?)')
        .run(id, code.trim(), name.trim());
      return this.db
        .prepare('SELECT id,code,name,archived FROM locations WHERE id=?')
        .get(id) as Row;
    };
    return this.db.isTransaction ? create() : transaction(this.db, create);
  }

  updateLocation(id: number, input: { code: string; name: string; archived?: boolean }): void {
    transaction(this.db, () => {
      if (input.archived) {
        const blockers = this.db
          .prepare('SELECT name FROM items WHERE location_id=? ORDER BY name COLLATE NOCASE')
          .all(id) as Row[];
        if (blockers.length)
          throw new DomainError(
            'location_in_use',
            `יש להעביר תחילה את הפריטים: ${blockers.map((item) => item.name).join(', ')}`,
            409,
          );
      }
      const result = this.db
        .prepare('UPDATE locations SET code=?,name=?,archived=COALESCE(?,archived) WHERE id=?')
        .run(
          input.code.trim(),
          input.name.trim(),
          input.archived == null ? null : Number(input.archived),
          id,
        );
      if (result.changes === 0) throw new DomainError('not_found', 'Location not found', 404);
    });
  }

  saveInventoryLocation(input: {
    key: string;
    ledgerEpoch?: number;
    locationId?: number;
    code: string;
    name: string;
    archived?: boolean;
  }): Row {
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return transaction(this.db, () => {
      this.requireBusinessCommandKey(input.key);
      this.requireInventoryEpoch(input.ledgerEpoch);
      const receipt = this.db
        .prepare('SELECT request_hash,result_json FROM inventory_command_receipts WHERE key=?')
        .get(input.key) as Row | undefined;
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new DomainError('idempotency_conflict', 'מפתח הפעולה כבר שימש לבקשה אחרת', 409);
        return this.decodeCommandReceipt<Row>(receipt);
      }
      const code = input.code.trim();
      const name = input.name.trim();
      if (!code || code.length > 40 || !name || name.length > 100)
        throw new DomainError('invalid_location', 'יש להזין שם וקוד תקינים');
      let locationId = input.locationId;
      if (locationId === undefined) {
        locationId = allocateIdentity(this.db, 'location');
        this.db
          .prepare('INSERT INTO locations(id,code,name) VALUES (?,?,?)')
          .run(locationId, code, name);
      } else {
        const current = this.db.prepare('SELECT id FROM locations WHERE id=?').get(locationId) as
          Row | undefined;
        if (!current) throw new DomainError('not_found', 'Location not found', 404);
        if (input.archived) {
          const blockers = this.db
            .prepare('SELECT name FROM items WHERE location_id=? ORDER BY name COLLATE NOCASE')
            .all(locationId) as Row[];
          if (blockers.length)
            throw new DomainError(
              'location_in_use',
              `יש להעביר תחילה את הפריטים: ${blockers.map((item) => item.name).join(', ')}`,
              409,
            );
        }
        this.db
          .prepare('UPDATE locations SET code=?,name=?,archived=COALESCE(?,archived) WHERE id=?')
          .run(code, name, input.archived == null ? null : Number(input.archived), locationId);
      }
      const result = this.db
        .prepare('SELECT id,code,name,archived FROM locations WHERE id=?')
        .get(locationId) as Row;
      const response = { ...result, archived: Boolean(result.archived) };
      this.db
        .prepare(
          'INSERT INTO inventory_command_receipts(key,request_hash,result_json) VALUES (?,?,?)',
        )
        .run(input.key, hash, JSON.stringify(response));
      return response;
    });
  }

  retireLocationCommand(input: {
    key: string;
    ledgerEpoch: number;
    locationId: number;
    action: 'archive' | 'delete';
    replacementLocationId?: number;
    expectedItemIds: number[];
    expectedCode: string;
    expectedName: string;
  }): { action: 'archive' | 'delete'; locationId: number; movedItemIds: number[] } {
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return transaction(this.db, () => {
      this.requireBusinessCommandKey(input.key);
      const receipt = this.findInventoryCommandReceipt(input.key);
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new DomainError('idempotency_conflict', 'מפתח הפעולה כבר שימש לבקשה אחרת', 409);
        return this.decodeCommandReceipt<{
          action: 'archive' | 'delete';
          locationId: number;
          movedItemIds: number[];
        }>(receipt);
      }
      this.requireInventoryEpoch(input.ledgerEpoch);
      const location = this.db
        .prepare('SELECT id,code,name,archived FROM locations WHERE id=?')
        .get(input.locationId) as Row | undefined;
      if (!location) throw new DomainError('not_found', 'Location not found', 404);
      if (location.code !== input.expectedCode || location.name !== input.expectedName)
        throw new DomainError('confirmation_changed', 'פרטי המיקום השתנו; יש לבדוק ולאשר שוב', 409);
      if (input.action === 'archive' && location.archived)
        throw new DomainError('location_already_archived', 'המיקום כבר בארכיון', 409);
      const itemIds = (
        this.db
          .prepare('SELECT id FROM items WHERE location_id=? ORDER BY id')
          .all(input.locationId) as Row[]
      ).map((row) => Number(row.id));
      if (!sameNumberList(itemIds, input.expectedItemIds))
        throw new DomainError(
          'confirmation_changed',
          'תכולת המיקום השתנתה; יש לבדוק ולאשר שוב',
          409,
        );
      if (itemIds.length > 0) {
        const destinationId = input.replacementLocationId;
        if (destinationId === undefined)
          throw new DomainError('destination_required', 'יש לבחור מיקום פעיל להעברת הפריטים', 409);
        if (destinationId === input.locationId)
          throw new DomainError('invalid_destination', 'יש לבחור מיקום אחר', 409);
        this.requireActiveLocation(destinationId);
      } else if (input.replacementLocationId !== undefined) {
        if (input.replacementLocationId === input.locationId)
          throw new DomainError('invalid_destination', 'יש לבחור מיקום אחר', 409);
        this.requireActiveLocation(input.replacementLocationId);
      }

      this.persistCurrentIdentityHighWater();
      const nextRevision = this.bumpStateRevision();
      if (itemIds.length > 0)
        this.db
          .prepare('UPDATE items SET location_id=? WHERE location_id=?')
          .run(input.replacementLocationId!, input.locationId);
      if (input.action === 'archive')
        this.db.prepare('UPDATE locations SET archived=1 WHERE id=?').run(input.locationId);
      else this.db.prepare('DELETE FROM locations WHERE id=?').run(input.locationId);
      this.scrubInventoryCommandReceipts(
        (value) =>
          this.isLocationReceiptFor(value, input.locationId) ||
          itemIds.some((id) => this.isItemReceiptFor(value, id)),
      );
      for (const itemIdChunk of chunked(itemIds, 900))
        this.db
          .prepare(
            `UPDATE item_state SET revision=? WHERE item_id IN (${placeholders(itemIdChunk.length)})`,
          )
          .run(nextRevision, ...itemIdChunk);
      const result = { action: input.action, locationId: input.locationId, movedItemIds: itemIds };
      this.insertInventoryCommandReceipt(input.key, hash, result);
      return result;
    });
  }

  private requireActiveLocation(locationId: number | null): void {
    if (locationId == null) return;
    const location = this.db
      .prepare('SELECT archived FROM locations WHERE id=?')
      .get(locationId) as Row | undefined;
    if (!location || location.archived)
      throw new DomainError('invalid_location', 'יש לבחור מיקום פעיל', 409);
  }

  createItem(input: {
    name: string;
    kind: ItemKind;
    lotSize?: number | null;
    locationId?: number | null;
    aliases?: string[];
  }): Item {
    if (input.kind !== 'consumable' && input.lotSize != null)
      throw new DomainError('invalid_lot_size', 'Only consumables may define a lot size');
    if (input.lotSize != null) integer(input.lotSize, 'lotSize');
    return transaction(this.db, () => {
      this.requireActiveLocation(input.locationId ?? null);
      const name = input.name.trim();
      this.requireUniqueItemName(name);
      const id = allocateIdentity(this.db, 'item');
      this.db
        .prepare('INSERT INTO items(id,name,kind,lot_size,location_id) VALUES (?,?,?,?,?)')
        .run(id, name, input.kind, input.lotSize ?? null, input.locationId ?? null);
      this.setAliases(id, input.aliases ?? []);
      this.db
        .prepare(
          'INSERT INTO inventory_baselines(item_id,quantity,through_event_id) VALUES (?,0,0)',
        )
        .run(id);
      this.initializeItemState(id);
      return this.getItem(id);
    });
  }

  updateItem(
    id: number,
    input: {
      name: string;
      lotSize?: number | null;
      locationId?: number | null;
      aliases?: string[];
    },
  ): Item {
    const item = this.requireItem(id);
    const lotSize = input.lotSize === undefined ? item.lotSize : input.lotSize;
    const locationId = input.locationId === undefined ? item.locationId : input.locationId;
    if (item.kind !== 'consumable' && lotSize != null)
      throw new DomainError('invalid_lot_size', 'Only consumables may define a lot size');
    if (lotSize != null) integer(lotSize, 'lotSize');
    return transaction(this.db, () => {
      this.requireActiveLocation(locationId);
      const name = input.name.trim();
      this.requireUniqueItemName(name, id);
      this.db
        .prepare('UPDATE items SET name=?,lot_size=?,location_id=? WHERE id=?')
        .run(name, lotSize, locationId, id);
      if (input.aliases !== undefined) this.setAliases(id, input.aliases);
      return this.getItem(id);
    });
  }

  saveInventoryItem(input: {
    key: string;
    ledgerEpoch?: number;
    itemId?: number;
    name: string;
    kind?: ItemKind;
    aliases: string[];
    lotSize: number | null;
    locationId: number | null;
    targetAvailable?: number;
    stockRevision?: number;
    note?: string;
  }): Item {
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return transaction(this.db, () => {
      this.requireBusinessCommandKey(input.key);
      this.requireInventoryEpoch(input.ledgerEpoch);
      const receipt = this.db
        .prepare('SELECT request_hash,result_json FROM inventory_command_receipts WHERE key=?')
        .get(input.key) as Row | undefined;
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new DomainError('idempotency_conflict', 'מפתח הפעולה כבר שימש לבקשה אחרת', 409);
        return this.decodeCommandReceipt<Item>(receipt);
      }
      this.requireActiveLocation(input.locationId);
      if (
        input.targetAvailable !== undefined &&
        (!Number.isSafeInteger(input.targetAvailable) || input.targetAvailable < 0)
      )
        throw new DomainError('invalid_quantity', 'הכמות חייבת להיות מספר שלם שאינו שלילי');
      if (input.note && input.note.length > 500)
        throw new DomainError('invalid_note', 'הערה ארוכה מדי');
      let item: Item;
      if (input.itemId === undefined) {
        if (!input.kind) throw new DomainError('invalid_kind', 'יש לבחור סוג פריט');
        item = this.createItemInTransaction(input);
      } else {
        item = this.requireItem(input.itemId);
        if (item.kind !== 'consumable' && input.lotSize != null)
          throw new DomainError('invalid_lot_size', 'Only consumables may define a lot size');
        if (input.lotSize != null) integer(input.lotSize, 'lotSize');
        this.requireUniqueItemName(input.name.trim(), input.itemId);
        this.db
          .prepare('UPDATE items SET name=?,lot_size=?,location_id=? WHERE id=?')
          .run(input.name.trim(), input.lotSize, input.locationId, input.itemId);
        this.setAliases(input.itemId, input.aliases);
      }
      const current = this.getItem(item.id);
      if (input.targetAvailable !== undefined) {
        if (input.itemId !== undefined && input.stockRevision !== current.stockRevision)
          throw new DomainError(
            'stale_stock',
            'המלאי השתנה מאז פתיחת הפריט. יש לבדוק את היתרות ולשלוח שוב.',
            409,
          );
        const delta = input.targetAvailable - current.available;
        if (delta !== 0)
          this.move(
            delta > 0 ? 'stock_added' : 'stock_removed',
            item.id,
            Math.abs(delta),
            null,
            null,
            input.note ?? '',
          );
      }
      const result = this.getItem(item.id);
      this.db
        .prepare(
          'INSERT INTO inventory_command_receipts(key,request_hash,result_json) VALUES (?,?,?)',
        )
        .run(input.key, hash, JSON.stringify(result));
      return result;
    });
  }

  private createItemInTransaction(input: {
    name: string;
    kind?: ItemKind;
    lotSize: number | null;
    locationId: number | null;
    aliases: string[];
  }): Item {
    if (!input.kind) throw new DomainError('invalid_kind', 'יש לבחור סוג פריט');
    if (input.kind !== 'consumable' && input.lotSize != null)
      throw new DomainError('invalid_lot_size', 'Only consumables may define a lot size');
    if (input.lotSize != null) integer(input.lotSize, 'lotSize');
    this.requireUniqueItemName(input.name.trim());
    const id = allocateIdentity(this.db, 'item');
    this.db
      .prepare('INSERT INTO items(id,name,kind,lot_size,location_id) VALUES (?,?,?,?,?)')
      .run(id, input.name.trim(), input.kind, input.lotSize, input.locationId);
    this.setAliases(id, input.aliases);
    this.db
      .prepare('INSERT INTO inventory_baselines(item_id,quantity,through_event_id) VALUES (?,0,0)')
      .run(id);
    this.initializeItemState(id);
    return this.getItem(id);
  }

  private requireUniqueItemName(name: string, excludedItemId?: number): void {
    const key = normalizeItemName(name);
    const duplicate = (this.db.prepare('SELECT id,name FROM items').all() as Row[]).some(
      (item) => Number(item.id) !== excludedItemId && normalizeItemName(String(item.name)) === key,
    );
    if (duplicate) throw new DomainError('duplicate_item_name', 'כבר קיים פריט בשם הזה', 409);
  }

  archiveItem(id: number, archived: boolean, replacementLocationId?: number | null): void {
    transaction(this.db, () => this.archiveItemInTransaction(id, archived, replacementLocationId));
  }

  archiveItemCommand(input: {
    key: string;
    ledgerEpoch?: number;
    itemId: number;
    archived: boolean;
    locationId?: number | null;
  }): { itemId: number; archived: boolean } {
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return transaction(this.db, () => {
      this.requireBusinessCommandKey(input.key);
      this.requireInventoryEpoch(input.ledgerEpoch);
      const receipt = this.db
        .prepare('SELECT request_hash,result_json FROM inventory_command_receipts WHERE key=?')
        .get(input.key) as Row | undefined;
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new DomainError('idempotency_conflict', 'מפתח הפעולה כבר שימש לבקשה אחרת', 409);
        return this.decodeCommandReceipt<{ itemId: number; archived: boolean }>(receipt);
      }
      this.archiveItemInTransaction(input.itemId, input.archived, input.locationId);
      const result = { itemId: input.itemId, archived: input.archived };
      this.db
        .prepare(
          'INSERT INTO inventory_command_receipts(key,request_hash,result_json) VALUES (?,?,?)',
        )
        .run(input.key, hash, JSON.stringify(result));
      return result;
    });
  }

  deleteItemCommand(input: {
    key: string;
    ledgerEpoch: number;
    itemId: number;
    expectedStockRevision: number;
    expectedName: string;
    expectedLocationId: number | null;
  }): { outcome: 'committed'; action: 'delete_item'; itemId: number } {
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return transaction(this.db, () => {
      this.requireBusinessCommandKey(input.key);
      const receipt = this.findInventoryCommandReceipt(input.key);
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new DomainError('idempotency_conflict', 'מפתח הפעולה כבר שימש לבקשה אחרת', 409);
        return this.decodeCommandReceipt<{
          outcome: 'committed';
          action: 'delete_item';
          itemId: number;
        }>(receipt);
      }
      this.requireInventoryEpoch(input.ledgerEpoch);
      const item = this.getItem(input.itemId);
      if (item.name !== input.expectedName || item.locationId !== input.expectedLocationId)
        throw new DomainError('confirmation_changed', 'פרטי הפריט השתנו; יש לבדוק ולאשר שוב', 409);
      if (item.borrowed || item.damaged || item.lost)
        throw new DomainError(
          'deletion_ineligible',
          `לא ניתן למחוק: מושאל ${item.borrowed}, פגום ${item.damaged}, אבוד ${item.lost}`,
          409,
        );
      if (item.stockRevision !== input.expectedStockRevision)
        throw new DomainError('confirmation_changed', 'יתרות הפריט השתנו; יש לבדוק ולאשר שוב', 409);
      const eventIds = (
        this.db
          .prepare('SELECT id FROM inventory_events WHERE item_id=?')
          .all(input.itemId) as Row[]
      ).map((row) => Number(row.id));
      this.persistCurrentIdentityHighWater();
      this.withLedgerDeletionGuard(() => {
        this.db.prepare('DELETE FROM loan_state WHERE item_id=?').run(input.itemId);
        this.deleteEventIds(eventIds);
        this.db.prepare('DELETE FROM items WHERE id=?').run(input.itemId);
        this.scrubInventoryCommandReceipts(
          (value) =>
            this.isItemReceiptFor(value, input.itemId) ||
            (typeof value.eventId === 'number' && eventIds.includes(value.eventId)),
        );
      });
      this.bumpStateRevision();
      const result = { outcome: 'committed', action: 'delete_item', itemId: input.itemId } as const;
      this.insertInventoryCommandReceipt(input.key, hash, result);
      return result;
    });
  }

  borrowerDeletionStatus(id: number): {
    borrower: Borrower;
    outstanding: number;
    lost: number;
    stateRevision: number;
  } {
    return readTransaction(this.db, () => {
      const borrower = this.getBorrower(id);
      const balances = this.db
        .prepare(
          'SELECT COALESCE(SUM(outstanding),0) outstanding,COALESCE(SUM(lost),0) lost FROM loan_state WHERE borrower_id=?',
        )
        .get(id) as Row;
      const revision = this.db
        .prepare('SELECT revision FROM state_clock WHERE singleton=1')
        .get() as Row;
      return {
        borrower,
        outstanding: Number(balances.outstanding),
        lost: Number(balances.lost),
        stateRevision: Number(revision.revision),
      };
    });
  }

  deleteBorrowerCommand(input: {
    key: string;
    ledgerEpoch: number;
    borrowerId: number;
    expectedStateRevision: number;
    expectedOutstanding: number;
    expectedLost: number;
    expectedFullName: string;
    expectedPlayaName: string;
    expectedPhoneNumber: string;
    expectedCampDepartment: string;
  }): { outcome: 'committed'; action: 'delete_borrower'; borrowerId: number } {
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return transaction(this.db, () => {
      this.requireBusinessCommandKey(input.key);
      const receipt = this.findInventoryCommandReceipt(input.key);
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new DomainError('idempotency_conflict', 'מפתח הפעולה כבר שימש לבקשה אחרת', 409);
        return this.decodeCommandReceipt<{
          outcome: 'committed';
          action: 'delete_borrower';
          borrowerId: number;
        }>(receipt);
      }
      this.requireInventoryEpoch(input.ledgerEpoch);
      const borrower = this.getBorrower(input.borrowerId);
      if (
        borrower.fullName !== input.expectedFullName ||
        borrower.playaName !== input.expectedPlayaName ||
        borrower.phoneNumber !== input.expectedPhoneNumber ||
        borrower.campDepartment !== input.expectedCampDepartment
      )
        throw new DomainError('confirmation_changed', 'פרטי השואל השתנו; יש לבדוק ולאשר שוב', 409);
      const balances = this.db
        .prepare(
          'SELECT COALESCE(SUM(outstanding),0) outstanding,COALESCE(SUM(lost),0) lost FROM loan_state WHERE borrower_id=?',
        )
        .get(input.borrowerId) as Row;
      const outstanding = Number(balances.outstanding);
      const lost = Number(balances.lost);
      const revision = Number(
        (this.db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get() as Row)
          .revision,
      );
      if (outstanding || lost)
        throw new DomainError(
          'deletion_ineligible',
          `לא ניתן למחוק שואל עם יתרות: מושאל ${outstanding}, אבוד ${lost}`,
          409,
        );
      if (
        revision !== input.expectedStateRevision ||
        outstanding !== input.expectedOutstanding ||
        lost !== input.expectedLost
      )
        throw new DomainError('confirmation_changed', 'יתרות השואל השתנו; יש לבדוק ולאשר שוב', 409);
      const eventIds = (
        this.db
          .prepare('SELECT id FROM inventory_events WHERE borrower_id=?')
          .all(input.borrowerId) as Row[]
      ).map((row) => Number(row.id));
      this.persistCurrentIdentityHighWater();
      this.withLedgerDeletionGuard(() => {
        this.db.prepare('DELETE FROM loan_state WHERE borrower_id=?').run(input.borrowerId);
        this.deleteEventIds(eventIds);
        this.db.prepare('DELETE FROM borrowers WHERE id=?').run(input.borrowerId);
        this.scrubInventoryCommandReceipts(
          (value) =>
            this.isBorrowerReceiptFor(value, input.borrowerId) ||
            (typeof value.eventId === 'number' && eventIds.includes(value.eventId)),
        );
        this.db
          .prepare('UPDATE idempotency_receipts SET result_json=? WHERE subject_id=?')
          .run(staleIdentityReceipt, input.borrowerId);
      });
      this.scrubBorrowerReceipts(input.borrowerId);
      this.bumpStateRevision();
      const result = {
        outcome: 'committed',
        action: 'delete_borrower',
        borrowerId: input.borrowerId,
      } as const;
      this.insertInventoryCommandReceipt(input.key, hash, result);
      return result;
    });
  }

  private archiveItemInTransaction(
    id: number,
    archived: boolean,
    replacementLocationId?: number | null,
  ): void {
    const item = this.getItem(id);
    if (archived && (item.borrowed || item.lost || item.damaged))
      throw new DomainError(
        'nonzero_balances',
        `לא ניתן לארכב פריט עם יתרות: מושאל ${item.borrowed}, אבוד ${item.lost}, פגום ${item.damaged}`,
        409,
      );
    const locationId =
      replacementLocationId === undefined ? item.locationId : replacementLocationId;
    if (!archived) this.requireActiveLocation(locationId);
    if (archived && item.available > 0)
      this.move('stock_removed', id, item.available, null, null, 'ארכוב פריט');
    this.db
      .prepare('UPDATE items SET archived=?,location_id=? WHERE id=?')
      .run(Number(archived), locationId, id);
  }

  createBorrower(
    input: Pick<BorrowerProfile, 'fullName'> & Partial<Omit<BorrowerProfile, 'fullName'>>,
  ): Borrower {
    const profile = this.requireProfile(input);
    const create = () => {
      this.requireUniqueProfile(profile);
      const id = allocateIdentity(this.db, 'borrower');
      this.db
        .prepare(
          'INSERT INTO borrowers(id,playa_name,full_name,phone_number,camp_department) VALUES (?,?,?,?,?)',
        )
        .run(id, profile.playaName, profile.fullName, profile.phoneNumber, profile.campDepartment);
      return this.getBorrower(id);
    };
    return this.db.isTransaction ? create() : transaction(this.db, create);
  }

  private requireProfile(
    input: Pick<BorrowerProfile, 'fullName'> & Partial<Omit<BorrowerProfile, 'fullName'>>,
  ): BorrowerProfile {
    const profile = { playaName: '', phoneNumber: '', campDepartment: '', ...input };
    if (!isValidBorrowerProfile(profile))
      throw new DomainError(
        'invalid_borrower',
        'Full name is required and profile fields must be at most 100 characters',
      );
    return trimBorrowerProfile(profile);
  }

  private requireUniqueProfile(profile: BorrowerProfile, exceptId?: number): void {
    if (
      this.listBorrowers('', true).some(
        (borrower) =>
          borrower.id !== exceptId && borrowerIdentity(borrower) === borrowerIdentity(profile),
      )
    )
      throw new DomainError(
        'borrower_conflict',
        'כבר קיים שואל עם אותם פרטים. יש לבחור את הכרטיס הקיים או לשנות את הפרטים.',
        409,
      );
  }

  commitBorrowerOperations(
    borrowerId: number,
    idempotencyKey: string,
    request: BorrowerOperationRequest,
  ): BorrowerOperationResult | CommandProtocolError {
    return transaction(this.db, () => {
      const epochError = this.requireCommandEpoch(request.ledgerEpoch, idempotencyKey);
      if (epochError) return epochError;
      const requestHash = this.commandHash('borrower_operation', borrowerId, request);
      const receipt = this.findReceipt(idempotencyKey);
      if (receipt) {
        const mismatch = this.receiptMismatch(
          receipt,
          'borrower_operation',
          borrowerId,
          request,
          requestHash,
        );
        if (mismatch) return mismatch;
        if (receipt.result_json === staleIdentityReceipt)
          return this.staleIdentityProtocolError(idempotencyKey);
        if (receipt.outcome === 'committed')
          return {
            ...(JSON.parse(receipt.result_json ?? '{}') as BorrowerOperationResult),
            replayed: true,
          } as BorrowerOperationResult;
        const validation = this.validateBorrowerOperation(borrowerId, request);
        const snapshot = this.borrowerDeskSnapshotInTransaction(borrowerId);
        return {
          error: 'borrower_operation_attempt_rejected',
          message: 'The original borrower operation was rejected',
          outcome: 'rejected',
          idempotencyKey,
          replayed: true,
          currentValidation:
            validation.length > 0
              ? { status: 'conflicted', conflicts: validation, snapshot }
              : { status: 'now_valid', conflicts: [], snapshot },
        };
      }

      // Preserve the existing unknown-borrower 404 contract without creating a receipt.
      this.getBorrower(borrowerId);
      const conflicts = this.validateBorrowerOperation(borrowerId, request);
      if (conflicts.length > 0) {
        const result: BorrowerOperationResult = {
          error: 'borrower_operation_conflict',
          message: 'The borrower operation conflicts with current inventory state',
          outcome: 'rejected',
          idempotencyKey,
          replayed: false,
          conflicts,
          snapshot: this.borrowerDeskSnapshotInTransaction(borrowerId),
        };
        this.insertReceipt(
          idempotencyKey,
          'borrower_operation',
          borrowerId,
          request,
          requestHash,
          'rejected',
          null,
        );
        return result;
      }

      for (const group of [...request.items].sort((a, b) => a.itemId - b.itemId)) {
        const checkouts = this.returnableCheckouts(borrowerId, group.itemId);
        for (const part of group.return ?? []) {
          this.allocateReturns(
            checkouts,
            group.itemId,
            borrowerId,
            'returned_usable',
            part.usable,
            part.note,
          );
          this.allocateReturns(
            checkouts,
            group.itemId,
            borrowerId,
            'returned_damaged',
            part.damaged,
            part.note,
          );
        }
        for (const part of group.lost ?? [])
          this.allocateLosses(checkouts, group.itemId, borrowerId, part.quantity, part.note);
        const lostCheckouts = this.lostCheckouts(borrowerId, group.itemId);
        for (const part of group.lostCredit ?? [])
          this.allocateLostCredits(
            lostCheckouts,
            group.itemId,
            borrowerId,
            part.quantity,
            part.condition,
            part.note,
          );
      }
      for (const group of [...request.items].sort((a, b) => a.itemId - b.itemId))
        for (const part of group.borrow ?? [])
          this.move('checked_out', group.itemId, part.quantity, borrowerId, null, part.note);
      for (const group of [...request.items].sort((a, b) => a.itemId - b.itemId))
        for (const part of group.issue ?? [])
          this.move('issued', group.itemId, part.quantity, null, null, part.note);

      const result: BorrowerOperationResult = {
        outcome: 'committed',
        idempotencyKey,
        replayed: false,
      };
      this.insertReceipt(
        idempotencyKey,
        'borrower_operation',
        borrowerId,
        request,
        requestHash,
        'committed',
        result,
      );
      return result;
    });
  }

  createBorrowerCommand(
    idempotencyKey: string,
    request: BorrowerCreateRequest,
  ): BorrowerCreateResult | CommandProtocolError {
    return transaction(this.db, () => {
      const epochError = this.requireCommandEpoch(request.ledgerEpoch, idempotencyKey);
      if (epochError) return epochError;
      const requestHash = this.commandHash('borrower_create', null, request);
      const receipt = this.findReceipt(idempotencyKey);
      if (receipt) {
        const mismatch = this.receiptMismatch(
          receipt,
          'borrower_create',
          null,
          request,
          requestHash,
        );
        if (mismatch) return mismatch;
        if (receipt.result_json === staleIdentityReceipt)
          return this.staleIdentityProtocolError(idempotencyKey);
        if (receipt.outcome === 'committed')
          return {
            ...(JSON.parse(receipt.result_json ?? '{}') as BorrowerCreateResult),
            replayed: true,
          } as BorrowerCreateResult;
        const validation = this.validateBorrowerCreation(request);
        return {
          error: 'borrower_create_attempt_rejected',
          message: 'The original borrower creation was rejected',
          outcome: 'rejected',
          idempotencyKey,
          replayed: true,
          currentValidation:
            validation.fieldErrors.length > 0
              ? { status: 'conflicted', ...validation }
              : { status: 'now_valid', fieldErrors: [], matches: [] },
        };
      }

      const validation = this.validateBorrowerCreation(request);
      if (validation.fieldErrors.length > 0) {
        const result: BorrowerCreateResult = {
          error: 'borrower_conflict',
          message: 'A borrower with the same normalized identity already exists',
          outcome: 'rejected',
          idempotencyKey,
          replayed: false,
          ...validation,
        };
        this.insertReceipt(
          idempotencyKey,
          'borrower_create',
          null,
          request,
          requestHash,
          'rejected',
          null,
        );
        return result;
      }

      const borrower = this.createBorrower(request);
      const result: BorrowerCreateResult = {
        outcome: 'committed',
        idempotencyKey,
        replayed: false,
        borrower,
      };
      this.insertReceipt(
        idempotencyKey,
        'borrower_create',
        null,
        request,
        requestHash,
        'committed',
        result,
      );
      return result;
    });
  }

  updateBorrower(
    id: number,
    input: Pick<BorrowerProfile, 'fullName'> & Partial<Omit<BorrowerProfile, 'fullName'>>,
  ): Borrower {
    return transaction(this.db, () => {
      this.requireBorrower(id, true);
      const profile = this.requireProfile(input);
      this.requireUniqueProfile(profile, id);
      this.db
        .prepare(
          'UPDATE borrowers SET playa_name=?,full_name=?,phone_number=?,camp_department=? WHERE id=?',
        )
        .run(profile.playaName, profile.fullName, profile.phoneNumber, profile.campDepartment, id);
      return this.getBorrower(id);
    });
  }

  archiveBorrower(id: number, archived: boolean): void {
    this.requireBorrower(id, true);
    if (archived && this.unresolvedForBorrower(id) > 0)
      throw new DomainError('active_loan', 'Cannot archive a borrower with outstanding equipment');
    this.db.prepare('UPDATE borrowers SET archived=? WHERE id=?').run(Number(archived), id);
  }

  listItems(search = '', includeArchived = false): Item[] {
    const fragment = `%${search.trim()}%`;
    const rows = this.db
      .prepare(
        `SELECT i.*,${itemStateColumns}
      FROM items i LEFT JOIN item_state s ON s.item_id=i.id WHERE (? OR i.archived=0) AND (
        i.name LIKE ? COLLATE NOCASE OR EXISTS(
          SELECT 1 FROM item_aliases a WHERE a.item_id=i.id AND a.alias LIKE ? COLLATE NOCASE)) ORDER BY i.name COLLATE NOCASE`,
      )
      .all(Number(includeArchived), fragment, fragment) as Row[];
    return rows.map((row) => this.itemFromRow(row));
  }

  listBorrowers(search = '', includeArchived = false): Borrower[] {
    const query = normalizeBorrowerText(search);
    const phoneQuery = normalizeBorrowerPhone(search);
    return (
      this.db
        .prepare('SELECT * FROM borrowers WHERE (? OR archived=0) ORDER BY full_name,id')
        .all(Number(includeArchived)) as Row[]
    )
      .map(this.borrowerFromRow)
      .filter(
        (borrower) =>
          !query ||
          [borrower.fullName, borrower.playaName, borrower.campDepartment].some((value) =>
            normalizeBorrowerText(value).includes(query),
          ) ||
          (phoneQuery.length > 0 &&
            normalizeBorrowerPhone(borrower.phoneNumber).includes(phoneQuery)),
      )
      .sort(
        (left, right) =>
          compareText(
            normalizeBorrowerText(left.fullName),
            normalizeBorrowerText(right.fullName),
          ) ||
          compareText(
            normalizeBorrowerText(left.playaName),
            normalizeBorrowerText(right.playaName),
          ) ||
          left.id - right.id,
      );
  }

  borrowerCampSuggestions(): string[] {
    const values = new Map<string, string>();
    for (const borrower of this.listBorrowers('', true)) {
      const key = normalizeBorrowerText(borrower.campDepartment);
      if (key && !values.has(key)) values.set(key, borrower.campDepartment);
    }
    return [...values.values()].sort((left, right) => left.localeCompare(right, 'he'));
  }

  searchBorrowers(query: string): BorrowerSearchSnapshot {
    return readTransaction(this.db, () => {
      const ledgerEpoch = this.ledgerEpochInTransaction();
      const normalizedQuery = normalizeBorrowerText(query);
      const phoneQuery = normalizeBorrowerPhone(query);
      const active = this.listBorrowers(query);
      const archivedMatches: BorrowerSearchSnapshot['archivedMatches'] = [];
      for (const borrower of this.listBorrowers('', true).filter((entry) => entry.archived)) {
        let matchedBy: BorrowerMatchKind | undefined;
        if (normalizedQuery && normalizeBorrowerText(borrower.playaName) === normalizedQuery)
          matchedBy = 'playa_name';
        else if (phoneQuery && normalizeBorrowerPhone(borrower.phoneNumber) === phoneQuery)
          matchedBy = 'phone_number';
        else if (normalizedQuery && normalizeBorrowerText(borrower.fullName) === normalizedQuery)
          matchedBy = 'full_name';
        if (matchedBy) archivedMatches.push({ borrower, matchedBy });
      }
      const matchOrder = { playa_name: 0, phone_number: 1, full_name: 2 };
      archivedMatches.sort(
        (left, right) =>
          matchOrder[left.matchedBy] - matchOrder[right.matchedBy] ||
          left.borrower.id - right.borrower.id,
      );
      return { ledgerEpoch, active, archivedMatches };
    });
  }

  getBorrowerDeskSnapshot(borrowerId: number): BorrowerDeskSnapshot {
    return readTransaction(this.db, () => {
      this.requireBorrower(borrowerId);
      return this.borrowerDeskSnapshotInTransaction(borrowerId);
    });
  }

  addStock(itemId: number, quantity: number, note = ''): number {
    return transaction(this.db, () => {
      this.requireItem(itemId);
      return this.move('stock_added', itemId, integer(quantity), null, null, note);
    });
  }

  issue(itemId: number, quantity: number, note = ''): number {
    return transaction(this.db, () => {
      const item = this.requireItem(itemId);
      if (item.kind !== 'consumable')
        throw new DomainError('wrong_item_kind', 'Only consumables can be issued');
      this.requireAvailable(itemId, quantity);
      return this.move('issued', itemId, quantity, null, null, note);
    });
  }

  issueBatch(input: {
    key: string;
    ledgerEpoch: number;
    items: Array<{ itemId: number; quantity: number; note: string }>;
  }): {
    outcome: 'committed' | 'rejected';
    idempotencyKey: string;
    replayed: boolean;
    conflicts: Array<{
      itemId: number;
      code: 'item_not_found' | 'item_archived' | 'wrong_item_kind' | 'insufficient_stock';
      available?: number;
    }>;
  } {
    if (
      input.items.length === 0 ||
      input.items.some(
        (part) =>
          !Number.isSafeInteger(part.itemId) ||
          part.itemId < 1 ||
          !Number.isSafeInteger(part.quantity) ||
          part.quantity < 1 ||
          typeof part.note !== 'string' ||
          part.note.length > 500,
      )
    )
      throw new DomainError('validation_error', 'Invalid consumable batch');
    const hash = createHash('sha256').update(stableJson(input)).digest('hex');
    return transaction(this.db, () => {
      this.requireBusinessCommandKey(input.key);
      const receipt = this.db
        .prepare('SELECT request_hash,result_json FROM inventory_command_receipts WHERE key=?')
        .get(input.key) as Row | undefined;
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new DomainError('idempotency_conflict', 'מפתח הפעולה כבר שימש לבקשה אחרת', 409);
        return {
          ...this.decodeCommandReceipt<ReturnType<InventoryService['issueBatch']>>(receipt),
          replayed: true,
        };
      }
      this.requireInventoryEpoch(input.ledgerEpoch);
      const totals = new Map<number, number>();
      for (const part of input.items)
        totals.set(part.itemId, (totals.get(part.itemId) ?? 0) + part.quantity);
      const conflicts: ReturnType<InventoryService['issueBatch']>['conflicts'] = [];
      for (const [itemId, quantity] of totals) {
        if (!Number.isSafeInteger(quantity))
          throw new DomainError('validation_error', 'Invalid quantity');
        let item: Item;
        try {
          item = this.getItem(itemId);
        } catch (error) {
          if (error instanceof DomainError && error.code === 'not_found') {
            conflicts.push({ itemId, code: 'item_not_found' });
            continue;
          }
          throw error;
        }
        if (item.archived) conflicts.push({ itemId, code: 'item_archived' });
        else if (item.kind !== 'consumable') conflicts.push({ itemId, code: 'wrong_item_kind' });
        else if (quantity > item.available)
          conflicts.push({ itemId, code: 'insufficient_stock', available: item.available });
      }
      if (conflicts.length === 0)
        for (const part of input.items)
          this.move('issued', part.itemId, part.quantity, null, null, part.note);
      const result = {
        outcome: conflicts.length ? ('rejected' as const) : ('committed' as const),
        idempotencyKey: input.key,
        replayed: false,
        conflicts,
      };
      this.db
        .prepare(
          'INSERT INTO inventory_command_receipts(key,request_hash,result_json) VALUES (?,?,?)',
        )
        .run(input.key, hash, JSON.stringify(result));
      return result;
    });
  }

  checkout(itemId: number, borrowerId: number, quantity: number, note = ''): number {
    return transaction(this.db, () => {
      const item = this.requireItem(itemId);
      if (item.kind !== 'non_consumable')
        throw new DomainError('wrong_item_kind', 'Only non-consumables can be checked out');
      this.requireBorrower(borrowerId);
      this.requireAvailable(itemId, quantity);
      return this.move('checked_out', itemId, quantity, borrowerId, null, note);
    });
  }

  returnCheckout(checkoutId: number, usable: number, damaged: number, note = ''): number[] {
    if (
      !Number.isSafeInteger(usable) ||
      usable < 0 ||
      !Number.isSafeInteger(damaged) ||
      damaged < 0 ||
      usable + damaged <= 0
    )
      throw new DomainError(
        'invalid_quantity',
        'Returned quantities must be non-negative integers with a positive total',
      );
    return transaction(this.db, () => {
      const checkout = this.requireCheckout(checkoutId);
      if (usable + damaged > this.outstanding(checkoutId))
        throw new DomainError('over_return', 'Return exceeds outstanding quantity');
      const ids: number[] = [];
      if (usable)
        ids.push(
          this.move(
            'returned_usable',
            checkout.item_id,
            usable,
            checkout.borrower_id,
            checkoutId,
            note,
          ),
        );
      if (damaged)
        ids.push(
          this.move(
            'returned_damaged',
            checkout.item_id,
            damaged,
            checkout.borrower_id,
            checkoutId,
            note,
          ),
        );
      return ids;
    });
  }

  markLost(checkoutId: number, quantity: number, lost: true, note = ''): number {
    if (lost !== true)
      throw new DomainError(
        'unsupported_restoration',
        'Lost equipment can only be found and returned',
      );
    return transaction(this.db, () => {
      const checkout = this.requireCheckout(checkoutId);
      integer(quantity);
      if (quantity > this.outstanding(checkoutId))
        throw new DomainError('excessive_quantity', 'Quantity exceeds eligible checkout quantity');
      return this.move(
        'marked_lost',
        checkout.item_id,
        quantity,
        checkout.borrower_id,
        checkoutId,
        note,
      );
    });
  }

  resolveDamage(itemId: number, quantity: number, repaired: boolean, note = ''): number {
    return transaction(this.db, () => {
      integer(quantity);
      if (quantity > this.getItem(itemId).damaged)
        throw new DomainError('excessive_quantity', 'Quantity exceeds damaged stock');
      return this.move(repaired ? 'repaired' : 'written_off', itemId, quantity, null, null, note);
    });
  }

  resolveDamageCommand(input: {
    key: string;
    ledgerEpoch?: number;
    itemId: number;
    quantity: number;
    repaired: boolean;
    note: string;
  }): { eventId: number } {
    if (input.note.length > 500) throw new DomainError('invalid_note', 'הערה ארוכה מדי');
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return transaction(this.db, () => {
      this.requireBusinessCommandKey(input.key);
      this.requireInventoryEpoch(input.ledgerEpoch);
      const receipt = this.db
        .prepare('SELECT request_hash,result_json FROM inventory_command_receipts WHERE key=?')
        .get(input.key) as Row | undefined;
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new DomainError('idempotency_conflict', 'מפתח הפעולה כבר שימש לבקשה אחרת', 409);
        return this.decodeCommandReceipt<{ eventId: number }>(receipt);
      }
      const item = this.requireItem(input.itemId);
      integer(input.quantity);
      if (input.quantity > item.damaged)
        throw new DomainError('excessive_quantity', 'Quantity exceeds damaged stock');
      const result = {
        eventId: this.move(
          input.repaired ? 'repaired' : 'written_off',
          input.itemId,
          input.quantity,
          null,
          null,
          input.note,
        ),
      };
      this.db
        .prepare(
          'INSERT INTO inventory_command_receipts(key,request_hash,result_json) VALUES (?,?,?)',
        )
        .run(input.key, hash, JSON.stringify(result));
      return result;
    });
  }

  listLoans(): Row[] {
    return this.db
      .prepare(
        `SELECT l.checkout_id checkoutId,l.item_id itemId,i.name itemName,
      l.borrower_id borrowerId,b.full_name borrowerName,l.quantity,l.outstanding,l.lost,
      l.created_at createdAt
      FROM loan_state l JOIN items i ON i.id=l.item_id JOIN borrowers b ON b.id=l.borrower_id
      WHERE l.outstanding > 0 OR l.lost > 0 ORDER BY l.checkout_id DESC`,
      )
      .all();
  }

  periodSummary(start: string, end: string, now = new Date()): PeriodSummary {
    const bounds = periodBounds(start, end, now);
    return readTransaction(this.db, () => {
      const rows = this.db
        .prepare(
          `
        SELECT e.borrower_id borrowerId, e.item_id itemId,
          b.playa_name, b.full_name borrowerName, b.phone_number, b.camp_department,
          b.archived borrowerArchived, i.name itemName,
          SUM(CASE e.kind WHEN 'checked_out' THEN e.quantity
            WHEN 'returned_usable' THEN -e.quantity
            WHEN 'returned_damaged' THEN -e.quantity
            WHEN 'marked_lost' THEN -e.quantity ELSE 0 END) balance
        FROM inventory_events e
        JOIN borrowers b ON b.id=e.borrower_id
        JOIN items i ON i.id=e.item_id
        WHERE e.created_at >= ? AND e.created_at < ?
          AND e.kind IN ('checked_out','returned_usable','returned_damaged','marked_lost')
        GROUP BY e.borrower_id,e.item_id
        HAVING balance > 0
        ORDER BY b.full_name COLLATE NOCASE, e.borrower_id, i.name COLLATE NOCASE
      `,
        )
        .all(bounds.startUtc, bounds.endExclusiveUtc) as Row[];
      const borrowers = new Map<number, PeriodSummary['borrowers'][number]>();
      for (const row of rows) {
        let entry = borrowers.get(row.borrowerId);
        if (!entry) {
          entry = {
            borrower: {
              id: row.borrowerId,
              playaName: row.playa_name,
              fullName: row.borrowerName,
              phoneNumber: row.phone_number,
              campDepartment: row.camp_department,
              archived: Boolean(row.borrowerArchived),
            },
            total: 0,
            items: [],
          };
          borrowers.set(row.borrowerId, entry);
        }
        entry.items.push({
          itemId: row.itemId,
          name: row.itemName,
          quantity: row.balance,
        });
        entry.total += row.balance;
      }
      return {
        start,
        end,
        borrowers: [...borrowers.values()].sort((left, right) =>
          left.borrower.fullName.localeCompare(right.borrower.fullName, 'he', { numeric: true }),
        ),
      };
    });
  }

  listLedger(): Row[] {
    return this.db
      .prepare(
        `SELECT e.*,i.name itemName,b.full_name borrowerName FROM inventory_events e
      JOIN items i ON i.id=e.item_id LEFT JOIN borrowers b ON b.id=e.borrower_id ORDER BY e.id DESC`,
      )
      .all();
  }

  private requireCommandEpoch(
    requestedEpoch: number,
    idempotencyKey: string,
  ): CommandProtocolError | undefined {
    if (requestedEpoch === this.ledgerEpochInTransaction()) return undefined;
    return {
      error: 'ledger_epoch_changed',
      message: 'The inventory ledger has been replaced; refresh before retrying',
      outcome: 'protocol_error',
      idempotencyKey,
    };
  }

  private commandHash(
    commandKind: CommandKind,
    subjectId: number | null,
    request: BorrowerOperationRequest | BorrowerCreateRequest,
  ): string {
    const identity = {
      commandKind,
      subjectId,
      ledgerEpoch: request.ledgerEpoch,
      contractVersion: request.contractVersion,
      request,
    };
    return createHash('sha256').update(stableJson(identity)).digest('hex');
  }

  private findReceipt(key: string): Receipt | undefined {
    return this.db.prepare('SELECT * FROM idempotency_receipts WHERE key=?').get(key) as
      Receipt | undefined;
  }

  private receiptMismatch(
    receipt: Receipt,
    commandKind: CommandKind,
    subjectId: number | null,
    request: BorrowerOperationRequest | BorrowerCreateRequest,
    requestHash: string,
  ): CommandProtocolError | undefined {
    if (
      receipt.command_kind === commandKind &&
      receipt.subject_id === subjectId &&
      receipt.ledger_epoch === request.ledgerEpoch &&
      receipt.contract_version === request.contractVersion &&
      receipt.request_hash === requestHash
    )
      return undefined;
    return {
      error: 'idempotency_key_reused',
      message: 'The idempotency key was already used for a different command',
      outcome: 'protocol_error',
      idempotencyKey: receipt.key,
    };
  }

  private insertReceipt(
    key: string,
    commandKind: CommandKind,
    subjectId: number | null,
    request: BorrowerOperationRequest | BorrowerCreateRequest,
    requestHash: string,
    outcome: 'committed' | 'rejected',
    result: BorrowerOperationResult | BorrowerCreateResult | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO idempotency_receipts(
          key,command_kind,ledger_epoch,contract_version,request_hash,outcome,subject_id,result_json
        ) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        key,
        commandKind,
        request.ledgerEpoch,
        request.contractVersion,
        requestHash,
        outcome,
        subjectId,
        result == null ? null : JSON.stringify(result),
      );
  }

  private validateBorrowerOperation(
    borrowerId: number,
    request: BorrowerOperationRequest,
  ): BorrowerOperationConflict[] {
    const borrower = this.getBorrower(borrowerId);
    if (borrower.archived) return [{ scope: 'borrower', code: 'borrower_inactive', borrowerId }];

    const conflicts: BorrowerOperationConflict[] = [];
    for (const group of [...request.items].sort((a, b) => a.itemId - b.itemId)) {
      let item: Item;
      try {
        item = this.getItem(group.itemId);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'not_found') {
          conflicts.push({ scope: 'item', code: 'item_not_found', itemId: group.itemId });
          continue;
        }
        throw error;
      }
      if (item.archived) {
        conflicts.push({ scope: 'item', code: 'item_archived', itemId: group.itemId });
        continue;
      }
      if (
        item.kind === 'consumable' &&
        group.issue?.length &&
        !group.borrow &&
        !group.return &&
        !group.lost &&
        !group.lostCredit
      ) {
        const requested = (group.issue ?? []).reduce((total, part) => total + part.quantity, 0);
        if (requested > item.available)
          conflicts.push({
            scope: 'issue',
            code: 'insufficient_stock',
            itemId: group.itemId,
            requested,
            available: item.available,
          });
        continue;
      }
      if (item.kind !== 'non_consumable' || group.issue) {
        conflicts.push({ scope: 'item', code: 'wrong_item_kind', itemId: group.itemId });
        continue;
      }

      const requestedReturn = (group.return ?? []).reduce(
        (total, part) => total + part.usable + part.damaged,
        0,
      );
      const requestedLost = (group.lost ?? []).reduce((total, part) => total + part.quantity, 0);
      const returnable = this.returnableCheckouts(borrowerId, group.itemId).reduce(
        (total, checkout) => total + checkout.remaining,
        0,
      );
      if (requestedReturn + requestedLost > returnable) {
        conflicts.push(
          requestedLost > 0
            ? {
                scope: 'held',
                code: 'held_balance_changed',
                itemId: group.itemId,
                requested: requestedReturn + requestedLost,
                returnable,
              }
            : {
                scope: 'return',
                code: 'returnable_balance_changed',
                itemId: group.itemId,
                requested: requestedReturn,
                returnable,
              },
        );
        continue;
      }
      const requestedLostCredit = (group.lostCredit ?? []).reduce(
        (total, part) => total + part.quantity,
        0,
      );
      const lost = this.lostCheckouts(borrowerId, group.itemId).reduce(
        (total, checkout) => total + checkout.remaining,
        0,
      );
      if (requestedLostCredit > lost + requestedLost) {
        conflicts.push({
          scope: 'lost-credit',
          code: 'lost_balance_changed',
          itemId: group.itemId,
          requested: requestedLostCredit,
          lost: lost + requestedLost,
        });
        continue;
      }
      const requestedBorrow = (group.borrow ?? []).reduce(
        (total, part) => total + part.quantity,
        0,
      );
      const usableReturns = (group.return ?? []).reduce((total, part) => total + part.usable, 0);
      const usableLostCredit = (group.lostCredit ?? []).reduce(
        (total, part) => total + (part.condition === 'usable' ? part.quantity : 0),
        0,
      );
      const availableAfterUsableReturns = item.available + usableReturns + usableLostCredit;
      if (requestedBorrow > availableAfterUsableReturns)
        conflicts.push({
          scope: 'borrow',
          code: 'insufficient_stock',
          itemId: group.itemId,
          requested: requestedBorrow,
          availableAfterUsableReturns,
        });
    }
    return conflicts;
  }

  validateBorrowerCreation(request: BorrowerProfile): BorrowerCreateValidation {
    if (!isValidBorrowerProfile(request))
      return {
        fieldErrors: [
          {
            field: 'fullName',
            code: 'invalid_borrower',
            message: 'Full name is required and profile fields must be at most 100 characters',
          },
        ],
        matches: [],
      };
    const matches: BorrowerCreateValidation['matches'] = [];
    let exact = false;
    for (const borrower of this.listBorrowers('', true)) {
      if (borrowerIdentity(borrower) === borrowerIdentity(request)) exact = true;
      let matchedBy: BorrowerMatchKind | undefined;
      const playaName = normalizeBorrowerText(request.playaName);
      const phone = normalizeBorrowerPhone(request.phoneNumber);
      if (playaName && normalizeBorrowerText(borrower.playaName) === playaName)
        matchedBy = 'playa_name';
      else if (phone && normalizeBorrowerPhone(borrower.phoneNumber) === phone)
        matchedBy = 'phone_number';
      else if (normalizeBorrowerText(borrower.fullName) === normalizeBorrowerText(request.fullName))
        matchedBy = 'full_name';
      if (matchedBy)
        matches.push({ borrower, status: borrower.archived ? 'archived' : 'active', matchedBy });
    }
    return {
      fieldErrors: exact
        ? [{ field: 'fullName', code: 'duplicate_profile', message: 'כבר קיים שואל עם אותם פרטים' }]
        : [],
      matches,
    };
  }

  private returnableCheckouts(
    borrowerId: number,
    itemId: number,
  ): Array<{ id: number; remaining: number }> {
    return (
      this.db
        .prepare(
          `SELECT checkout_id id,outstanding remaining FROM loan_state
          WHERE borrower_id=? AND item_id=? AND outstanding>0
          ORDER BY created_at,checkout_id`,
        )
        .all(borrowerId, itemId) as Row[]
    ).map((row) => ({ id: Number(row.id), remaining: Number(row.remaining) }));
  }

  private lostCheckouts(
    borrowerId: number,
    itemId: number,
  ): Array<{ id: number; remaining: number }> {
    return (
      this.db
        .prepare(
          `SELECT checkout_id id,lost remaining FROM loan_state
          WHERE borrower_id=? AND item_id=? AND lost>0
          ORDER BY created_at,checkout_id`,
        )
        .all(borrowerId, itemId) as Row[]
    ).map((row) => ({ id: Number(row.id), remaining: Number(row.remaining) }));
  }

  private allocateReturns(
    checkouts: Array<{ id: number; remaining: number }>,
    itemId: number,
    borrowerId: number,
    kind: 'returned_usable' | 'returned_damaged',
    quantity: number,
    note: string,
  ): void {
    let remaining = quantity;
    for (const checkout of checkouts) {
      if (remaining === 0) break;
      const allocated = Math.min(remaining, checkout.remaining);
      if (allocated === 0) continue;
      this.move(kind, itemId, allocated, borrowerId, checkout.id, note);
      checkout.remaining -= allocated;
      remaining -= allocated;
    }
    if (remaining !== 0) throw new DomainError('internal_error', 'Return allocation failed', 500);
  }

  private allocateLostCredits(
    checkouts: Array<{ id: number; remaining: number }>,
    itemId: number,
    borrowerId: number,
    quantity: number,
    condition: 'usable' | 'damaged',
    note: string,
  ): void {
    let remaining = quantity;
    for (const checkout of checkouts) {
      if (remaining === 0) break;
      const allocated = Math.min(remaining, checkout.remaining);
      if (allocated === 0) continue;
      this.move(
        condition === 'usable' ? 'found_returned' : 'found_returned_damaged',
        itemId,
        allocated,
        borrowerId,
        checkout.id,
        note,
      );
      checkout.remaining -= allocated;
      remaining -= allocated;
    }
    if (remaining !== 0)
      throw new DomainError('internal_error', 'Lost-credit allocation failed', 500);
  }

  private allocateLosses(
    checkouts: Array<{ id: number; remaining: number }>,
    itemId: number,
    borrowerId: number,
    quantity: number,
    note: string,
  ): void {
    let remaining = quantity;
    for (const checkout of checkouts) {
      if (remaining === 0) break;
      const allocated = Math.min(remaining, checkout.remaining);
      if (allocated === 0) continue;
      this.move('marked_lost', itemId, allocated, borrowerId, checkout.id, note);
      checkout.remaining -= allocated;
      remaining -= allocated;
    }
    if (remaining !== 0) throw new DomainError('internal_error', 'Lost allocation failed', 500);
  }

  private setAliases(itemId: number, aliases: string[]): void {
    if (aliases.length > maxAliases)
      throw new DomainError('too_many_aliases', `An item may have at most ${maxAliases} aliases`);
    const normalized = aliases.map((value) => value.trim());
    if (normalized.some((value) => value.length === 0 || value.length > 100))
      throw new DomainError('invalid_alias', 'Aliases must contain 1-100 trimmed characters');
    this.db.prepare('DELETE FROM item_aliases WHERE item_id=?').run(itemId);
    const insert = this.db.prepare('INSERT INTO item_aliases(item_id,alias) VALUES (?,?)');
    for (const alias of [...new Set(normalized)]) insert.run(itemId, alias);
  }

  private initializeItemState(itemId: number): void {
    this.db.prepare('INSERT INTO item_state(item_id) VALUES (?)').run(itemId);
  }

  private move(
    kind: EventKind,
    itemId: number,
    quantity: number,
    borrowerId: number | null,
    relatedId: number | null,
    note: string,
  ): number {
    integer(quantity);
    const state = this.db
      .prepare(
        'SELECT s.*,i.kind FROM item_state s JOIN items i ON i.id=s.item_id WHERE s.item_id=?',
      )
      .get(itemId) as Row | undefined;
    if (!state) throw new DomainError('integrity_error', 'Item state is missing', 500);
    const next = {
      available: Number(state.available),
      borrowed: Number(state.borrowed),
      damaged: Number(state.damaged),
      lost: Number(state.lost),
    };
    const delta: Record<EventKind, Partial<typeof next>> = {
      stock_added: { available: quantity },
      stock_removed: { available: -quantity },
      issued: { available: -quantity },
      checked_out: { available: -quantity, borrowed: quantity },
      returned_usable: { borrowed: -quantity, available: quantity },
      returned_damaged: { borrowed: -quantity, damaged: quantity },
      marked_lost: { borrowed: -quantity, lost: quantity },
      found_returned: { lost: -quantity, available: quantity },
      found_returned_damaged: { lost: -quantity, damaged: quantity },
      repaired: { damaged: -quantity, available: quantity },
      written_off: { damaged: -quantity },
    };
    for (const [field, change] of Object.entries(delta[kind]) as Array<
      [keyof typeof next, number]
    >) {
      const value = next[field] + change;
      if (!Number.isSafeInteger(value) || value < 0)
        throw new DomainError(
          'excessive_quantity',
          'Movement exceeds a stored balance or safe integer range',
        );
      next[field] = value;
    }
    if (
      state.kind === 'non_consumable' &&
      !Number.isSafeInteger(next.available + next.borrowed + next.damaged + next.lost)
    )
      throw new DomainError(
        'excessive_quantity',
        'Movement exceeds a stored balance or safe integer range',
      );
    let loan: Row | undefined;
    if (relatedId !== null) {
      loan = this.db.prepare('SELECT * FROM loan_state WHERE checkout_id=?').get(relatedId) as
        Row | undefined;
      if (!loan || Number(loan.item_id) !== itemId || Number(loan.borrower_id) !== borrowerId)
        throw new DomainError(
          'integrity_error',
          'Related checkout state is missing or mismatched',
          500,
        );
      const source =
        kind === 'found_returned' || kind === 'found_returned_damaged' ? 'lost' : 'outstanding';
      if (quantity > Number(loan[source]))
        throw new DomainError('excessive_quantity', 'Movement exceeds checkout balance');
    }
    const eventId = this.append(kind, itemId, quantity, borrowerId, relatedId, note);
    if (kind === 'checked_out') {
      if (borrowerId === null || relatedId !== null)
        throw new DomainError('integrity_error', 'Invalid checkout identity', 500);
      this.db
        .prepare(
          `INSERT INTO loan_state(checkout_id,item_id,borrower_id,quantity,created_at,outstanding,lost)
        VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,0)`,
        )
        .run(eventId, itemId, borrowerId, quantity, quantity);
    } else if (loan) {
      const outstanding =
        Number(loan.outstanding) +
        (kind === 'returned_usable' || kind === 'returned_damaged' || kind === 'marked_lost'
          ? -quantity
          : 0);
      const lost =
        Number(loan.lost) +
        (kind === 'marked_lost'
          ? quantity
          : kind === 'found_returned' || kind === 'found_returned_damaged'
            ? -quantity
            : 0);
      this.db
        .prepare('UPDATE loan_state SET outstanding=?,lost=? WHERE checkout_id=?')
        .run(outstanding, lost, relatedId);
    }
    const clock = this.db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get() as
      Row | undefined;
    if (!clock || !Number.isSafeInteger(Number(clock.revision) + 1))
      throw new DomainError('integrity_error', 'State revision is missing or exhausted', 500);
    const revision = Number(clock.revision) + 1;
    this.db.prepare('UPDATE state_clock SET revision=? WHERE singleton=1').run(revision);
    this.db
      .prepare(
        `UPDATE item_state SET available=?,borrowed=?,damaged=?,lost=?,revision=? WHERE item_id=?`,
      )
      .run(next.available, next.borrowed, next.damaged, next.lost, revision, itemId);
    return eventId;
  }

  private append(
    kind: EventKind,
    itemId: number,
    quantity: number,
    borrowerId: number | null,
    relatedId: number | null,
    note: string,
  ): number {
    const id = allocateIdentity(this.db, 'event');
    this.db
      .prepare(
        `INSERT INTO inventory_events(id,kind,item_id,borrower_id,quantity,related_event_id,note)
      VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, kind, itemId, borrowerId, integer(quantity), relatedId, note);
    return id;
  }

  private findInventoryCommandReceipt(key: string): Row | undefined {
    this.requireBusinessCommandKey(key);
    return this.db
      .prepare('SELECT request_hash,result_json FROM inventory_command_receipts WHERE key=?')
      .get(key) as Row | undefined;
  }

  private insertInventoryCommandReceipt(key: string, hash: string, result: unknown): void {
    this.requireBusinessCommandKey(key);
    this.db
      .prepare(
        'INSERT INTO inventory_command_receipts(key,request_hash,result_json) VALUES (?,?,?)',
      )
      .run(key, hash, JSON.stringify(result));
  }

  private decodeCommandReceipt<Result>(receipt: Row): Result {
    let value: unknown;
    try {
      value = JSON.parse(String(receipt.result_json));
    } catch {
      throw new DomainError('integrity_error', 'Stored command receipt is invalid', 500);
    }
    if (isRecord(value) && value.staleIdentity === true)
      throw new DomainError('stale_identity', 'הפעולה המקורית מתייחסת לרשומה שנמחקה', 409);
    return value as Result;
  }

  private staleIdentityProtocolError(idempotencyKey: string): CommandProtocolError {
    return {
      error: 'idempotency_key_reused',
      message: 'The original command refers to a deleted borrower or inventory record',
      outcome: 'protocol_error',
      idempotencyKey,
    };
  }

  private persistCurrentIdentityHighWater(): void {
    persistIdentityHighWater(this.db, getIdentityHighWater(this.db));
  }

  private bumpStateRevision(): number {
    const row = this.db.prepare('SELECT revision FROM state_clock WHERE singleton=1').get() as
      Row | undefined;
    const current = Number(row?.revision);
    if (!row || !Number.isSafeInteger(current + 1))
      throw new DomainError('integrity_error', 'State revision is missing or exhausted', 500);
    const revision = current + 1;
    this.db.prepare('UPDATE state_clock SET revision=? WHERE singleton=1').run(revision);
    return revision;
  }

  private withLedgerDeletionGuard(operation: () => void): void {
    const guard = this.db
      .prepare('SELECT enabled FROM inventory_replacement_guard WHERE singleton=1')
      .get() as Row | undefined;
    if (!guard || Number(guard.enabled) !== 0)
      throw new DomainError('integrity_error', 'Ledger deletion guard is unavailable', 500);
    this.db.prepare('UPDATE inventory_replacement_guard SET enabled=1 WHERE singleton=1').run();
    try {
      operation();
    } finally {
      this.db.prepare('UPDATE inventory_replacement_guard SET enabled=0 WHERE singleton=1').run();
    }
  }

  private deleteEventIds(eventIds: number[]): void {
    if (eventIds.length === 0) return;
    for (const eventIdChunk of chunked(eventIds, 900)) {
      const ids = placeholders(eventIdChunk.length);
      this.db
        .prepare(
          `UPDATE inventory_events SET related_event_id=NULL WHERE related_event_id IN (${ids})`,
        )
        .run(...eventIdChunk);
      this.db.prepare(`DELETE FROM inventory_events WHERE id IN (${ids})`).run(...eventIdChunk);
    }
  }

  private requireBusinessCommandKey(key: string): void {
    if (key === identityHighWaterReceiptKey)
      throw new DomainError('idempotency_conflict', 'מפתח הפעולה שמור למערכת', 409);
  }

  private scrubInventoryCommandReceipts(
    matches: (value: Record<string, unknown>) => boolean,
  ): void {
    const receipts = this.db
      .prepare('SELECT key,result_json FROM inventory_command_receipts')
      .all() as Row[];
    const update = this.db.prepare(
      'UPDATE inventory_command_receipts SET result_json=? WHERE key=?',
    );
    for (const receipt of receipts) {
      if (receipt.key === identityHighWaterReceiptKey) continue;
      let value: unknown;
      try {
        value = JSON.parse(String(receipt.result_json));
      } catch {
        continue;
      }
      if (isRecord(value) && matches(value)) update.run(staleIdentityReceipt, receipt.key);
    }
  }

  private scrubBorrowerReceipts(borrowerId: number): void {
    const receipts = this.db
      .prepare('SELECT key,subject_id,result_json FROM idempotency_receipts')
      .all() as Row[];
    const update = this.db.prepare('UPDATE idempotency_receipts SET result_json=? WHERE key=?');
    for (const receipt of receipts) {
      let containsBorrower = Number(receipt.subject_id) === borrowerId;
      if (!containsBorrower && receipt.result_json != null) {
        try {
          const value: unknown = JSON.parse(String(receipt.result_json));
          containsBorrower =
            isRecord(value) && isRecord(value.borrower) && value.borrower.id === borrowerId;
        } catch {
          /* Invalid cached data is not a deletion target. */
        }
      }
      if (containsBorrower) update.run(staleIdentityReceipt, receipt.key);
    }
  }

  private isItemReceiptFor(value: Record<string, unknown>, itemId: number): boolean {
    return (
      value.itemId === itemId ||
      (value.id === itemId && typeof value.name === 'string' && typeof value.kind === 'string')
    );
  }

  private isBorrowerReceiptFor(value: Record<string, unknown>, borrowerId: number): boolean {
    return (
      value.borrowerId === borrowerId ||
      (isRecord(value.borrower) && value.borrower.id === borrowerId)
    );
  }

  private isLocationReceiptFor(value: Record<string, unknown>, locationId: number): boolean {
    return (
      value.id === locationId && typeof value.code === 'string' && typeof value.name === 'string'
    );
  }

  private requireAvailable(itemId: number, quantity: number): void {
    integer(quantity);
    const item = this.requireItem(itemId);
    if (quantity > item.available)
      throw new DomainError('insufficient_stock', 'Insufficient available stock');
  }

  private requireItem(id: number): Item {
    const item = this.getItem(id);
    if (item.archived) throw new DomainError('archived_item', 'Item is archived');
    return item;
  }

  private getItem(id: number): Item {
    const row = this.db
      .prepare(
        `SELECT i.*,${itemStateColumns} FROM items i
      LEFT JOIN item_state s ON s.item_id=i.id WHERE i.id=?`,
      )
      .get(id) as Row | undefined;
    if (!row) throw new DomainError('not_found', 'Item not found', 404);
    return this.itemFromRow(row);
  }

  private getBorrower(id: number): Borrower {
    const row = this.db.prepare('SELECT * FROM borrowers WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new DomainError('not_found', 'Borrower not found', 404);
    return this.borrowerFromRow(row);
  }

  private ledgerEpochInTransaction(): number {
    const row = this.db
      .prepare('SELECT ledger_epoch FROM inventory_replacement_guard WHERE singleton=1')
      .get() as Row | undefined;
    if (!row)
      throw new DomainError('internal_error', 'Inventory replacement guard is missing', 500);
    return Number(row.ledger_epoch);
  }

  private borrowerDeskSnapshotInTransaction(borrowerId: number): BorrowerDeskSnapshot {
    const borrower = this.getBorrower(borrowerId);
    const inventory = (
      this.db
        .prepare(
          `SELECT i.*,${itemStateColumns} FROM items i
          LEFT JOIN item_state s ON s.item_id=i.id
          WHERE i.kind IN ('non_consumable','consumable') ORDER BY i.name COLLATE NOCASE`,
        )
        .all() as Row[]
    ).map((row) => {
      const item = this.itemFromRow(row);
      return {
        id: item.id,
        name: item.name,
        kind: item.kind,
        lotSize: item.lotSize,
        locationId: item.locationId,
        archived: item.archived,
        aliases: item.aliases,
        available: item.available,
        damaged: item.damaged,
        selectable: !item.archived,
      };
    });
    const holdings = (
      this.db
        .prepare(
          `SELECT l.item_id item_id,SUM(l.outstanding) returnable,SUM(l.lost) lost
          FROM loan_state l JOIN items i ON i.id=l.item_id
          WHERE l.borrower_id=?
          GROUP BY l.item_id
          HAVING SUM(l.outstanding) > 0 OR SUM(l.lost) > 0
          ORDER BY i.name COLLATE NOCASE`,
        )
        .all(borrowerId) as Row[]
    ).map((row) => ({
      itemId: Number(row.item_id),
      returnable: Number(row.returnable),
      lost: Number(row.lost),
    }));
    const watermark = this.db
      .prepare('SELECT revision value FROM state_clock WHERE singleton=1')
      .get() as Row;
    return {
      borrower,
      inventory,
      holdings,
      stateRevision: Number(watermark.value),
      ledgerEpoch: this.ledgerEpochInTransaction(),
    };
  }

  private requireBorrower(id: number, allowArchived = false): Borrower {
    const borrower = this.getBorrower(id);
    if (!allowArchived && borrower.archived)
      throw new DomainError('inactive_borrower', 'Borrower is inactive');
    return borrower;
  }

  private requireCheckout(id: number): Row {
    const row = this.db
      .prepare('SELECT item_id,borrower_id,outstanding,lost FROM loan_state WHERE checkout_id=?')
      .get(id) as Row | undefined;
    if (!row) throw new DomainError('not_found', 'Checkout not found', 404);
    return row;
  }

  private outstanding(id: number): number {
    return Number(this.requireCheckout(id).outstanding);
  }

  private unresolvedForItem(id: number): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(outstanding+lost),0) value FROM loan_state WHERE item_id=?')
      .get(id) as Row;
    return Number(row.value);
  }

  private unresolvedForBorrower(id: number): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(outstanding+lost),0) value FROM loan_state WHERE borrower_id=?')
      .get(id) as Row;
    return Number(row.value);
  }

  private itemFromRow = (row: Row): Item => ({
    id: Number(row.id),
    name: String(row.name),
    kind: row.kind,
    lotSize: row.lot_size == null ? null : Number(row.lot_size),
    locationId: row.location_id == null ? null : Number(row.location_id),
    archived: Boolean(row.archived),
    aliases: (
      this.db
        .prepare('SELECT alias FROM item_aliases WHERE item_id=? ORDER BY alias')
        .all(row.id) as Row[]
    ).map((a) => String(a.alias)),
    available: this.requiredStateValue(row.available),
    damaged: this.requiredStateValue(row.damaged),
    borrowed: this.requiredStateValue(row.borrowed),
    lost: this.requiredStateValue(row.lost),
    stockRevision: this.requiredStateValue(row.stockRevision),
  });

  private requiredStateValue(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new DomainError('integrity_error', 'Item state is missing or invalid', 500);
    return value;
  }

  private borrowerFromRow = (row: Row): Borrower => ({
    id: Number(row.id),
    playaName: String(row.playa_name),
    fullName: String(row.full_name),
    phoneNumber: String(row.phone_number),
    campDepartment: String(row.camp_department),
    archived: Boolean(row.archived),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function placeholders(count: number): string {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Invalid SQL placeholder count');
  return Array.from({ length: count }, () => '?').join(',');
}

function sameNumberList(left: number[], right: number[]): boolean {
  if (!Array.isArray(right) || left.length !== right.length) return false;
  const normalized = [...right].sort((a, b) => a - b);
  return left.every((value, index) => value === normalized[index]);
}
