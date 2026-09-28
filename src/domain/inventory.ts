import type {
  BorrowerImportMode,
  BorrowerImportRow,
  BorrowerImportPreview,
  BorrowerImportResult,
} from '../contracts/borrower-import.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { InventoryDatabase } from '../db/database.js';
import { readTransaction, transaction } from '../db/database.js';
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
import {
  DomainError,
  type Borrower,
  type BorrowerType,
  type EventKind,
  type Item,
  type ItemKind,
} from './types.js';

type Row = Record<string, any>;

const maxAliases = 20;
const itemStateColumns = `s.available,s.borrowed,s.damaged,s.lost,s.revision stockRevision`;

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

export function normalizeBorrowerText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

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
        const existing = plan.identities.get(normalizeBorrowerText(row.username));
        if (existing) {
          this.db
            .prepare(
              'UPDATE borrowers SET username=?,name=?,contact=?,type=?,archived=0 WHERE id=?',
            )
            .run(row.username, row.name, row.contact, row.type, existing.id);
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
      if (
        typeof row.username !== 'string' ||
        row.username.trim().length < 2 ||
        row.username.trim().length > 40 ||
        typeof row.name !== 'string' ||
        !row.name.trim() ||
        row.name.trim().length > 100 ||
        typeof row.contact !== 'string' ||
        row.contact.length > 500 ||
        !['individual', 'camp_organization', 'other'].includes(row.type)
      )
        throw new DomainError(
          'invalid_import',
          `Row ${index + 2} contains invalid borrower fields`,
        );
      const key = normalizeBorrowerText(row.username);
      if (incoming.has(key))
        throw new DomainError('invalid_import', `Row ${index + 2} contains a duplicate username`);
      incoming.add(key);
    }
    const borrowers = (this.db.prepare('SELECT * FROM borrowers ORDER BY id').all() as Row[]).map(
      this.borrowerFromRow,
    );
    const identities = new Map<string, Borrower>();
    for (const borrower of borrowers) {
      const key = normalizeBorrowerText(borrower.username);
      if (identities.has(key))
        throw new DomainError(
          'ambiguous_borrower',
          `Ambiguous normalized username: ${borrower.username}`,
        );
      identities.set(key, borrower);
    }
    const absent =
      mode === 'replace'
        ? borrowers.filter((borrower) => !incoming.has(normalizeBorrowerText(borrower.username)))
        : [];
    const loans = this.listLoans();
    const affected = absent
      .map((borrower) => ({
        id: borrower.id,
        name: borrower.name,
        username: borrower.username,
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
    const added = rows.filter((row) => !identities.has(normalizeBorrowerText(row.username))).length;
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
    const result = this.db
      .prepare('INSERT INTO locations(code,name) VALUES (?,?)')
      .run(code.trim(), name.trim());
    return this.db
      .prepare('SELECT id,code,name,archived FROM locations WHERE id=?')
      .get(result.lastInsertRowid) as Row;
  }

  updateLocation(id: number, input: { code: string; name: string; archived?: boolean }): void {
    transaction(this.db, () => {
      if (input.archived) {
        const blockers = this.db
          .prepare('SELECT code,name FROM items WHERE location_id=? AND archived=0 ORDER BY code')
          .all(id) as Row[];
        if (blockers.length)
          throw new DomainError(
            'location_in_use',
            `יש להעביר תחילה את הפריטים: ${blockers.map((item) => `${item.code} ${item.name}`).join(', ')}`,
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
      this.requireInventoryEpoch(input.ledgerEpoch);
      const receipt = this.db
        .prepare('SELECT request_hash,result_json FROM inventory_command_receipts WHERE key=?')
        .get(input.key) as Row | undefined;
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new DomainError('idempotency_conflict', 'מפתח הפעולה כבר שימש לבקשה אחרת', 409);
        return JSON.parse(String(receipt.result_json)) as Row;
      }
      const code = input.code.trim();
      const name = input.name.trim();
      if (!code || code.length > 40 || !name || name.length > 100)
        throw new DomainError('invalid_location', 'יש להזין שם וקוד תקינים');
      let locationId = input.locationId;
      if (locationId === undefined) {
        locationId = Number(
          this.db.prepare('INSERT INTO locations(code,name) VALUES (?,?)').run(code, name)
            .lastInsertRowid,
        );
      } else {
        const current = this.db.prepare('SELECT id FROM locations WHERE id=?').get(locationId) as
          Row | undefined;
        if (!current) throw new DomainError('not_found', 'Location not found', 404);
        if (input.archived) {
          const blockers = this.db
            .prepare('SELECT code,name FROM items WHERE location_id=? AND archived=0 ORDER BY code')
            .all(locationId) as Row[];
          if (blockers.length)
            throw new DomainError(
              'location_in_use',
              `יש להעביר תחילה את הפריטים: ${blockers.map((item) => `${item.code} ${item.name}`).join(', ')}`,
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
      const code = Number(
        (this.db.prepare('SELECT next_code FROM code_sequence WHERE singleton=1').get() as Row)
          .next_code,
      );
      this.db.prepare('UPDATE code_sequence SET next_code=next_code+1 WHERE singleton=1').run();
      const result = this.db
        .prepare('INSERT INTO items(code,name,kind,lot_size,location_id) VALUES (?,?,?,?,?)')
        .run(code, name, input.kind, input.lotSize ?? null, input.locationId ?? null);
      const id = Number(result.lastInsertRowid);
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
      this.requireInventoryEpoch(input.ledgerEpoch);
      const receipt = this.db
        .prepare('SELECT request_hash,result_json FROM inventory_command_receipts WHERE key=?')
        .get(input.key) as Row | undefined;
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new DomainError('idempotency_conflict', 'מפתח הפעולה כבר שימש לבקשה אחרת', 409);
        return JSON.parse(String(receipt.result_json)) as Item;
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
    const code = Number(
      (this.db.prepare('SELECT next_code FROM code_sequence WHERE singleton=1').get() as Row)
        .next_code,
    );
    this.db.prepare('UPDATE code_sequence SET next_code=next_code+1 WHERE singleton=1').run();
    const id = Number(
      this.db
        .prepare('INSERT INTO items(code,name,kind,lot_size,location_id) VALUES (?,?,?,?,?)')
        .run(code, input.name.trim(), input.kind, input.lotSize, input.locationId).lastInsertRowid,
    );
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
      this.requireInventoryEpoch(input.ledgerEpoch);
      const receipt = this.db
        .prepare('SELECT request_hash,result_json FROM inventory_command_receipts WHERE key=?')
        .get(input.key) as Row | undefined;
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new DomainError('idempotency_conflict', 'מפתח הפעולה כבר שימש לבקשה אחרת', 409);
        return JSON.parse(String(receipt.result_json)) as { itemId: number; archived: boolean };
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

  createBorrower(input: {
    username: string;
    name: string;
    contact?: string;
    type: BorrowerType;
  }): Borrower {
    const result = this.db
      .prepare('INSERT INTO borrowers(username,name,contact,type) VALUES (?,?,?,?)')
      .run(input.username.trim(), input.name.trim(), input.contact ?? '', input.type);
    return this.getBorrower(Number(result.lastInsertRowid));
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

      const inserted = this.db
        .prepare('INSERT INTO borrowers(username,name,contact,type) VALUES (?,?,?,?)')
        .run(request.username, request.name, request.contact, request.type);
      const borrower = this.getBorrower(Number(inserted.lastInsertRowid));
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
    input: { username: string; name: string; contact?: string; type: BorrowerType },
  ): Borrower {
    this.requireBorrower(id, true);
    this.db
      .prepare('UPDATE borrowers SET username=?,name=?,contact=?,type=? WHERE id=?')
      .run(input.username.trim(), input.name.trim(), input.contact ?? '', input.type, id);
    return this.getBorrower(id);
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
        CAST(i.code AS TEXT) LIKE ? OR i.name LIKE ? COLLATE NOCASE OR EXISTS(
          SELECT 1 FROM item_aliases a WHERE a.item_id=i.id AND a.alias LIKE ? COLLATE NOCASE)) ORDER BY i.code`,
      )
      .all(Number(includeArchived), fragment, fragment, fragment) as Row[];
    return rows.map((row) => this.itemFromRow(row));
  }

  listBorrowers(search = '', includeArchived = false): Borrower[] {
    const fragment = `%${search.trim()}%`;
    return (
      this.db
        .prepare(
          `SELECT * FROM borrowers WHERE (? OR archived=0)
      AND (username LIKE ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE) ORDER BY name`,
        )
        .all(Number(includeArchived), fragment, fragment) as Row[]
    ).map(this.borrowerFromRow);
  }

  searchBorrowers(query: string): BorrowerSearchSnapshot {
    return readTransaction(this.db, () => {
      const ledgerEpoch = this.ledgerEpochInTransaction();
      const normalizedQuery = normalizeBorrowerText(query);

      const rows = this.db.prepare('SELECT * FROM borrowers ORDER BY id').all() as Row[];
      const active: Borrower[] = [];
      const archivedMatches: BorrowerSearchSnapshot['archivedMatches'] = [];
      for (const row of rows) {
        const borrower = this.borrowerFromRow(row);
        const username = normalizeBorrowerText(borrower.username);
        const name = normalizeBorrowerText(borrower.name);
        const contact = normalizeBorrowerText(borrower.contact);
        if (!borrower.archived) {
          if (
            normalizedQuery.length === 0 ||
            username.includes(normalizedQuery) ||
            name.includes(normalizedQuery) ||
            contact.includes(normalizedQuery)
          )
            active.push(borrower);
          continue;
        }

        let matchedBy: BorrowerMatchKind | undefined;
        if (username === normalizedQuery) matchedBy = 'username';
        else if (contact.length > 0 && contact === normalizedQuery) matchedBy = 'contact';
        else if (name === normalizedQuery) matchedBy = 'full_name';
        if (matchedBy) archivedMatches.push({ borrower, matchedBy });
      }

      const borrowerOrder = (left: Borrower, right: Borrower): number =>
        compareText(normalizeBorrowerText(left.name), normalizeBorrowerText(right.name)) ||
        compareText(normalizeBorrowerText(left.username), normalizeBorrowerText(right.username)) ||
        left.id - right.id;
      active.sort(borrowerOrder);
      const matchOrder: Record<BorrowerMatchKind, number> = {
        username: 0,
        contact: 1,
        full_name: 2,
      };
      archivedMatches.sort(
        (left, right) =>
          matchOrder[left.matchedBy] - matchOrder[right.matchedBy] ||
          borrowerOrder(left.borrower, right.borrower),
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
      const receipt = this.db
        .prepare('SELECT request_hash,result_json FROM inventory_command_receipts WHERE key=?')
        .get(input.key) as Row | undefined;
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new DomainError('idempotency_conflict', 'מפתח הפעולה כבר שימש לבקשה אחרת', 409);
        return {
          ...(JSON.parse(String(receipt.result_json)) as ReturnType<
            InventoryService['issueBatch']
          >),
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
      this.requireInventoryEpoch(input.ledgerEpoch);
      const receipt = this.db
        .prepare('SELECT request_hash,result_json FROM inventory_command_receipts WHERE key=?')
        .get(input.key) as Row | undefined;
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new DomainError('idempotency_conflict', 'מפתח הפעולה כבר שימש לבקשה אחרת', 409);
        return JSON.parse(String(receipt.result_json)) as { eventId: number };
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
        `SELECT l.checkout_id checkoutId,l.item_id itemId,i.code,i.name itemName,
      l.borrower_id borrowerId,b.name borrowerName,l.quantity,l.outstanding,l.lost,
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
          b.username, b.name borrowerName, b.contact, b.type borrowerType,
          b.archived borrowerArchived, i.code, i.name itemName,
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
        ORDER BY b.name COLLATE NOCASE, e.borrower_id, i.code
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
              username: row.username,
              name: row.borrowerName,
              contact: row.contact,
              type: row.borrowerType,
              archived: Boolean(row.borrowerArchived),
            },
            total: 0,
            items: [],
          };
          borrowers.set(row.borrowerId, entry);
        }
        entry.items.push({
          itemId: row.itemId,
          code: row.code,
          name: row.itemName,
          quantity: row.balance,
        });
        entry.total += row.balance;
      }
      return {
        start,
        end,
        borrowers: [...borrowers.values()].sort((left, right) =>
          left.borrower.name.localeCompare(right.borrower.name, 'he', { numeric: true }),
        ),
      };
    });
  }

  listLedger(): Row[] {
    return this.db
      .prepare(
        `SELECT e.*,i.code itemCode,i.name itemName,b.name borrowerName FROM inventory_events e
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

  private validateBorrowerCreation(request: BorrowerCreateRequest): BorrowerCreateValidation {
    const desired = {
      username: normalizeBorrowerText(request.username),
      contact: normalizeBorrowerText(request.contact),
      full_name: normalizeBorrowerText(request.name),
    };
    const matches: BorrowerCreateValidation['matches'] = [];
    const matchedKinds = new Set<BorrowerMatchKind>();
    for (const row of this.db
      .prepare('SELECT * FROM borrowers ORDER BY archived,id')
      .all() as Row[]) {
      const borrower = this.borrowerFromRow(row);
      const borrowerMatches: BorrowerMatchKind[] = [];
      if (normalizeBorrowerText(borrower.username) === desired.username)
        borrowerMatches.push('username');
      if (desired.contact.length > 0 && normalizeBorrowerText(borrower.contact) === desired.contact)
        borrowerMatches.push('contact');
      if (normalizeBorrowerText(borrower.name) === desired.full_name)
        borrowerMatches.push('full_name');
      const [matchedBy] = borrowerMatches;
      if (!matchedBy) continue;
      for (const kind of borrowerMatches) matchedKinds.add(kind);
      matches.push({
        borrower,
        status: borrower.archived ? 'archived' : 'active',
        matchedBy,
      });
    }
    const matchOrder: Record<BorrowerMatchKind, number> = {
      username: 0,
      contact: 1,
      full_name: 2,
    };
    matches.sort(
      (left, right) =>
        Number(left.borrower.archived) - Number(right.borrower.archived) ||
        matchOrder[left.matchedBy] - matchOrder[right.matchedBy] ||
        compareText(
          normalizeBorrowerText(left.borrower.name),
          normalizeBorrowerText(right.borrower.name),
        ) ||
        compareText(
          normalizeBorrowerText(left.borrower.username),
          normalizeBorrowerText(right.borrower.username),
        ) ||
        left.borrower.id - right.borrower.id,
    );
    const definitions: Array<{
      kind: BorrowerMatchKind;
      field: 'username' | 'contact' | 'name';
      code: string;
      message: string;
    }> = [
      {
        kind: 'username',
        field: 'username',
        code: 'username_conflict',
        message: 'Username matches an existing borrower',
      },
      {
        kind: 'contact',
        field: 'contact',
        code: 'contact_conflict',
        message: 'Contact matches an existing borrower',
      },
      {
        kind: 'full_name',
        field: 'name',
        code: 'full_name_conflict',
        message: 'Name matches an existing borrower',
      },
    ];
    return {
      fieldErrors: definitions
        .filter(({ kind }) => matchedKinds.has(kind))
        .map(({ field, code, message }) => ({ field, code, message })),
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
    const result = this.db
      .prepare(
        `INSERT INTO inventory_events(kind,item_id,borrower_id,quantity,related_event_id,note)
      VALUES (?,?,?,?,?,?)`,
      )
      .run(kind, itemId, borrowerId, integer(quantity), relatedId, note);
    return Number(result.lastInsertRowid);
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
          WHERE i.kind IN ('non_consumable','consumable') ORDER BY i.code`,
        )
        .all() as Row[]
    ).map((row) => {
      const item = this.itemFromRow(row);
      return {
        id: item.id,
        code: item.code,
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
          ORDER BY i.code`,
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
    code: Number(row.code),
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
    username: String(row.username),
    name: String(row.name),
    contact: String(row.contact),
    type: row.type,
    archived: Boolean(row.archived),
  });
}
