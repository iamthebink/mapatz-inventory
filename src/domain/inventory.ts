import type { InventoryDatabase } from '../db/database.js';
import { transaction } from '../db/database.js';
import {
  DomainError,
  type Borrower,
  type BorrowerType,
  type EventKind,
  type Item,
  type ItemKind,
} from './types.js';

type Row = Record<string, any>;

const eventEffect = `CASE kind
  WHEN 'stock_added' THEN quantity WHEN 'returned_usable' THEN quantity WHEN 'repaired' THEN quantity
  WHEN 'stock_removed' THEN -quantity WHEN 'issued' THEN -quantity WHEN 'checked_out' THEN -quantity ELSE 0 END`;
const damagedEffect = `CASE kind WHEN 'returned_damaged' THEN quantity WHEN 'repaired' THEN -quantity WHEN 'written_off' THEN -quantity ELSE 0 END`;
const maxAliases = 20;

function integer(value: number, label = 'quantity'): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new DomainError('invalid_quantity', `${label} must be a positive integer`);
  return value;
}

export class InventoryService {
  constructor(private readonly db: InventoryDatabase) {}

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
    const result = this.db
      .prepare('UPDATE locations SET code=?,name=?,archived=COALESCE(?,archived) WHERE id=?')
      .run(
        input.code.trim(),
        input.name.trim(),
        input.archived == null ? null : Number(input.archived),
        id,
      );
    if (result.changes === 0) throw new DomainError('not_found', 'Location not found', 404);
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
      const code = Number(
        (this.db.prepare('SELECT next_code FROM code_sequence WHERE singleton=1').get() as Row)
          .next_code,
      );
      this.db.prepare('UPDATE code_sequence SET next_code=next_code+1 WHERE singleton=1').run();
      const result = this.db
        .prepare('INSERT INTO items(code,name,kind,lot_size,location_id) VALUES (?,?,?,?,?)')
        .run(code, input.name.trim(), input.kind, input.lotSize ?? null, input.locationId ?? null);
      const id = Number(result.lastInsertRowid);
      this.setAliases(id, input.aliases ?? []);
      this.db
        .prepare(
          'INSERT INTO inventory_baselines(item_id,quantity,through_event_id) VALUES (?,0,0)',
        )
        .run(id);
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
      this.db
        .prepare('UPDATE items SET name=?,lot_size=?,location_id=? WHERE id=?')
        .run(input.name.trim(), lotSize, locationId, id);
      if (input.aliases !== undefined) this.setAliases(id, input.aliases);
      return this.getItem(id);
    });
  }

  archiveItem(id: number, archived: boolean): void {
    const item = this.getItem(id);
    if (archived && this.unresolvedForItem(id) > 0)
      throw new DomainError('active_loan', 'Cannot archive an item with outstanding equipment');
    if (archived && item.damaged > 0)
      throw new DomainError('damaged_stock', 'Cannot archive an item with damaged stock');
    this.db.prepare('UPDATE items SET archived=? WHERE id=?').run(Number(archived), id);
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
        `SELECT i.*,
      COALESCE((SELECT SUM(${eventEffect}) FROM inventory_events e WHERE e.item_id=i.id),0) available,
      COALESCE((SELECT SUM(${damagedEffect}) FROM inventory_events e WHERE e.item_id=i.id),0) damaged
      FROM items i WHERE (? OR i.archived=0) AND (
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

  addStock(itemId: number, quantity: number, note = ''): number {
    this.requireItem(itemId);
    return this.append('stock_added', itemId, integer(quantity), null, null, note);
  }

  removeStock(itemId: number, quantity: number, note = ''): number {
    return transaction(this.db, () => {
      this.requireAvailable(itemId, quantity);
      return this.append('stock_removed', itemId, quantity, null, null, note);
    });
  }

  issue(itemId: number, quantity: number, note = ''): number {
    return transaction(this.db, () => {
      const item = this.requireItem(itemId);
      if (item.kind !== 'consumable')
        throw new DomainError('wrong_item_kind', 'Only consumables can be issued');
      this.requireAvailable(itemId, quantity);
      return this.append('issued', itemId, quantity, null, null, note);
    });
  }

  checkout(itemId: number, borrowerId: number, quantity: number, note = ''): number {
    return transaction(this.db, () => {
      const item = this.requireItem(itemId);
      if (item.kind !== 'non_consumable')
        throw new DomainError('wrong_item_kind', 'Only non-consumables can be checked out');
      this.requireBorrower(borrowerId);
      this.requireAvailable(itemId, quantity);
      return this.append('checked_out', itemId, quantity, borrowerId, null, note);
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
          this.append(
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
          this.append(
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

  markLost(checkoutId: number, quantity: number, lost: boolean, note = ''): number {
    return transaction(this.db, () => {
      const checkout = this.requireCheckout(checkoutId);
      const maximum = lost ? this.outstanding(checkoutId) : this.lost(checkoutId);
      integer(quantity);
      if (quantity > maximum)
        throw new DomainError('excessive_quantity', 'Quantity exceeds eligible checkout quantity');
      return this.append(
        lost ? 'marked_lost' : 'unmarked_lost',
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
      return this.append(repaired ? 'repaired' : 'written_off', itemId, quantity, null, null, note);
    });
  }

  listLoans(): Row[] {
    return this.db
      .prepare(
        `SELECT e.id checkoutId,e.item_id itemId,i.code,i.name itemName,
      e.borrower_id borrowerId,b.name borrowerName,e.quantity,
      e.quantity-COALESCE(SUM(CASE WHEN x.kind IN ('returned_usable','returned_damaged','marked_lost') THEN x.quantity WHEN x.kind='unmarked_lost' THEN -x.quantity ELSE 0 END),0) outstanding,
      COALESCE(SUM(CASE WHEN x.kind='marked_lost' THEN x.quantity WHEN x.kind='unmarked_lost' THEN -x.quantity ELSE 0 END),0) lost,
      e.created_at createdAt
      FROM inventory_events e JOIN items i ON i.id=e.item_id JOIN borrowers b ON b.id=e.borrower_id
      LEFT JOIN inventory_events x ON x.related_event_id=e.id WHERE e.kind='checked_out'
      GROUP BY e.id HAVING outstanding > 0 OR lost > 0 ORDER BY e.id DESC`,
      )
      .all();
  }

  listLedger(): Row[] {
    return this.db
      .prepare(
        `SELECT e.*,i.code itemCode,i.name itemName,b.name borrowerName FROM inventory_events e
      JOIN items i ON i.id=e.item_id LEFT JOIN borrowers b ON b.id=e.borrower_id ORDER BY e.id DESC`,
      )
      .all();
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
        `SELECT i.*,
      COALESCE((SELECT SUM(${eventEffect}) FROM inventory_events e WHERE e.item_id=i.id),0) available,
      COALESCE((SELECT SUM(${damagedEffect}) FROM inventory_events e WHERE e.item_id=i.id),0) damaged FROM items i WHERE i.id=?`,
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

  private requireBorrower(id: number, allowArchived = false): Borrower {
    const borrower = this.getBorrower(id);
    if (!allowArchived && borrower.archived)
      throw new DomainError('inactive_borrower', 'Borrower is inactive');
    return borrower;
  }

  private requireCheckout(id: number): Row {
    const row = this.db
      .prepare("SELECT * FROM inventory_events WHERE id=? AND kind='checked_out'")
      .get(id) as Row | undefined;
    if (!row) throw new DomainError('not_found', 'Checkout not found', 404);
    return row;
  }

  private outstanding(id: number): number {
    const row = this.db
      .prepare(
        `SELECT e.quantity-COALESCE(SUM(CASE
      WHEN x.kind IN ('returned_usable','returned_damaged','marked_lost') THEN x.quantity
      WHEN x.kind='unmarked_lost' THEN -x.quantity ELSE 0 END),0) value
      FROM inventory_events e LEFT JOIN inventory_events x ON x.related_event_id=e.id WHERE e.id=? GROUP BY e.id`,
      )
      .get(id) as Row;
    return Number(row.value);
  }

  private lost(id: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind='marked_lost' THEN quantity WHEN kind='unmarked_lost' THEN -quantity ELSE 0 END),0) value
      FROM inventory_events WHERE related_event_id=?`,
      )
      .get(id) as Row;
    return Number(row.value);
  }

  private unresolvedForItem(id: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(e.quantity-COALESCE((SELECT SUM(x.quantity) FROM inventory_events x
      WHERE x.related_event_id=e.id AND x.kind IN ('returned_usable','returned_damaged')),0)),0) value
      FROM inventory_events e WHERE e.kind='checked_out' AND e.item_id=?`,
      )
      .get(id) as Row;
    return Number(row.value);
  }

  private unresolvedForBorrower(id: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(e.quantity-COALESCE((SELECT SUM(x.quantity) FROM inventory_events x
      WHERE x.related_event_id=e.id AND x.kind IN ('returned_usable','returned_damaged')),0)),0) value
      FROM inventory_events e WHERE e.kind='checked_out' AND e.borrower_id=?`,
      )
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
    available: Number(row.available ?? 0),
    damaged: Number(row.damaged ?? 0),
  });

  private borrowerFromRow = (row: Row): Borrower => ({
    id: Number(row.id),
    username: String(row.username),
    name: String(row.name),
    contact: String(row.contact),
    type: row.type,
    archived: Boolean(row.archived),
  });
}
