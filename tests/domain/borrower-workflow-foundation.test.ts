import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  migrate,
  openDatabase,
  transaction,
  type InventoryDatabase,
} from '../../src/db/database.js';
import { InventoryTransferService } from '../../src/domain/import-export.js';
import { InventoryService, normalizeBorrowerText } from '../../src/domain/inventory.js';

function applyMigration(
  db: DatabaseSync,
  version: number,
  filename: string,
  disableForeignKeys = false,
): void {
  if (disableForeignKeys) db.exec('PRAGMA foreign_keys = OFF');
  db.exec(readFileSync(new URL(`../../src/db/migrations/${filename}`, import.meta.url), 'utf8'));
  db.prepare('INSERT INTO migrations(version) VALUES (?)').run(version);
  if (disableForeignKeys) db.exec('PRAGMA foreign_keys = ON');
}

function versionFourDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigration(db, 1, '001_initial.sql');
  applyMigration(db, 2, '002_import_export.sql', true);
  applyMigration(db, 3, '003_admin_only_credentials.sql');
  applyMigration(db, 4, '004_camp_equipment.sql', true);
  return db;
}

function receipt(db: DatabaseSync, key: string): void {
  db.prepare(
    `INSERT INTO idempotency_receipts(
      key,command_kind,ledger_epoch,contract_version,request_hash,outcome,subject_id,result_json
    ) VALUES (?,?,?,?,?,?,?,?)`,
  ).run(key, 'borrower_operation', 1, 1, 'hash', 'committed', 1, '{}');
}

function interleaveAfterRead(
  db: InventoryDatabase,
  matches: (sql: string) => boolean,
  interleave: () => void,
): InventoryDatabase {
  let triggered = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!matches(sql)) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              const value = Reflect.get(statementTarget, statementProperty, statementTarget);
              if (
                (statementProperty === 'get' || statementProperty === 'all') &&
                typeof value === 'function'
              )
                return (...parameters: unknown[]) => {
                  const result = value.apply(statementTarget, parameters);
                  if (!triggered) {
                    triggered = true;
                    interleave();
                  }
                  return result;
                };
              return typeof value === 'function' ? value.bind(statementTarget) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as InventoryDatabase;
}

describe('borrower workflow persistence foundation', () => {
  it('migrates a populated version-4 database exactly once without changing ledger projections', () => {
    const db = versionFourDatabase();
    const inventory = new InventoryService(db);
    const item = inventory.createItem({ name: 'Existing', kind: 'non_consumable' });
    const borrower = inventory.createBorrower({
      username: 'existing',
      name: 'Existing Borrower',
      type: 'individual',
    });
    inventory.addStock(item.id, 3);
    inventory.checkout(item.id, borrower.id, 1);
    const before = {
      items: inventory.listItems('', true),
      borrowers: inventory.listBorrowers('', true),
      loans: inventory.listLoans(),
      ledger: inventory.listLedger(),
    };

    migrate(db);
    migrate(db);

    expect(db.prepare('SELECT version FROM migrations ORDER BY version').all()).toEqual(
      [1, 2, 3, 4, 5].map((version) => ({ version })),
    );
    expect(
      db.prepare('SELECT enabled,ledger_epoch FROM inventory_replacement_guard').get(),
    ).toEqual({ enabled: 0, ledger_epoch: 1 });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='idempotency_receipts'",
        )
        .get(),
    ).toEqual({ name: 'idempotency_receipts' });
    expect(
      db
        .prepare(
          `SELECT name,type,"notnull" not_null,dflt_value,pk
          FROM pragma_table_info('idempotency_receipts') ORDER BY cid`,
        )
        .all(),
    ).toEqual([
      { name: 'key', type: 'TEXT', not_null: 1, dflt_value: null, pk: 1 },
      { name: 'command_kind', type: 'TEXT', not_null: 1, dflt_value: null, pk: 0 },
      { name: 'ledger_epoch', type: 'INTEGER', not_null: 1, dflt_value: null, pk: 0 },
      { name: 'contract_version', type: 'INTEGER', not_null: 1, dflt_value: null, pk: 0 },
      { name: 'request_hash', type: 'TEXT', not_null: 1, dflt_value: null, pk: 0 },
      { name: 'outcome', type: 'TEXT', not_null: 1, dflt_value: null, pk: 0 },
      { name: 'subject_id', type: 'INTEGER', not_null: 0, dflt_value: null, pk: 0 },
      { name: 'result_json', type: 'TEXT', not_null: 0, dflt_value: null, pk: 0 },
      {
        name: 'created_at',
        type: 'TEXT',
        not_null: 1,
        dflt_value: 'CURRENT_TIMESTAMP',
        pk: 0,
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT name,type,"notnull" not_null,dflt_value,pk
          FROM pragma_table_info('inventory_replacement_guard') WHERE name='ledger_epoch'`,
        )
        .get(),
    ).toEqual({
      name: 'ledger_epoch',
      type: 'INTEGER',
      not_null: 1,
      dflt_value: '1',
      pk: 0,
    });
    expect(
      db
        .prepare("SELECT name FROM pragma_index_list('inventory_events') ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual([
      'events_borrower_idx',
      'events_borrower_item_kind_created_id_idx',
      'events_item_idx',
      'events_related_kind_idx',
    ]);
    expect(
      db
        .prepare("SELECT name FROM pragma_index_info('events_related_kind_idx') ORDER BY seqno")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(['related_event_id', 'kind']);
    expect(
      db
        .prepare(
          "SELECT name FROM pragma_index_info('events_borrower_item_kind_created_id_idx') ORDER BY seqno",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(['borrower_id', 'item_id', 'kind', 'created_at', 'id']);
    expect(
      db
        .prepare("SELECT name FROM pragma_table_info('inventory_events') ORDER BY cid")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual([
      'id',
      'kind',
      'item_id',
      'borrower_id',
      'quantity',
      'related_event_id',
      'note',
      'created_at',
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() =>
      db
        .prepare(
          `INSERT INTO idempotency_receipts(
            key,command_kind,ledger_epoch,contract_version,request_hash,outcome
          ) VALUES (NULL,'borrower_operation',1,1,'hash','committed')`,
        )
        .run(),
    ).toThrow();
    expect({
      items: inventory.listItems('', true),
      borrowers: inventory.listBorrowers('', true),
      loans: inventory.listLoans(),
      ledger: inventory.listLedger(),
    }).toEqual(before);
    db.close();
  });

  it('rolls back every version-5 change and leaves transaction state clear after migration failure', () => {
    const db = versionFourDatabase();
    const inventory = new InventoryService(db);
    const existing = inventory.createItem({ name: 'Preserved', kind: 'consumable' });
    inventory.addStock(existing.id, 2);
    db.exec('CREATE INDEX events_borrower_item_kind_created_id_idx ON items(name)');

    expect(() => migrate(db)).toThrow(/events_borrower_item_kind_created_id_idx already exists/);

    expect(db.isTransaction).toBe(false);
    expect(
      db
        .prepare("SELECT name FROM pragma_table_info('inventory_replacement_guard') ORDER BY cid")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(['singleton', 'enabled']);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='idempotency_receipts'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='events_related_kind_idx'",
        )
        .get(),
    ).toBeUndefined();
    expect(db.prepare('SELECT version FROM migrations ORDER BY version').all()).toEqual(
      [1, 2, 3, 4].map((version) => ({ version })),
    );
    expect(inventory.listItems('', true)[0]).toMatchObject({ name: 'Preserved', available: 2 });
    db.close();
  });

  it('normalizes search centrally and separates deterministic exact archived matches', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const activeIdFirst = inventory.createBorrower({
      username: 'Ｔie',
      name: 'Same',
      contact: 'order',
      type: 'individual',
    });
    const activeIdSecond = inventory.createBorrower({
      username: 'Tie',
      name: 'Same',
      contact: 'order',
      type: 'other',
    });
    const activeUsernameSecond = inventory.createBorrower({
      username: 'z-user',
      name: 'Ａlpha',
      contact: 'order',
      type: 'individual',
    });
    const activeUsernameFirst = inventory.createBorrower({
      username: 'a-user',
      name: 'Alpha',
      contact: 'order',
      type: 'other',
    });
    const archivedByName = inventory.createBorrower({
      username: 'retired-name',
      name: '  Alice  ',
      type: 'other',
    });
    const archivedByContact = inventory.createBorrower({
      username: 'retired-contact',
      name: 'Yankee',
      contact: '  Alice  ',
      type: 'other',
    });
    const archivedByUsername = inventory.createBorrower({
      username: 'ＡLICE',
      name: 'Zulu',
      contact: 'alice',
      type: 'individual',
    });
    const archivedSubstring = inventory.createBorrower({
      username: 'alice-old',
      name: 'Substring Only',
      type: 'other',
    });
    for (const borrower of [
      archivedByName,
      archivedByContact,
      archivedByUsername,
      archivedSubstring,
    ])
      inventory.archiveBorrower(borrower.id, true);

    expect(normalizeBorrowerText('  ＡLICE\t Able  ')).toBe('alice able');
    expect(inventory.searchBorrowers('order').active).toEqual([
      activeUsernameFirst,
      activeUsernameSecond,
      activeIdFirst,
      activeIdSecond,
    ]);
    expect(inventory.searchBorrowers(' alice ')).toEqual({
      ledgerEpoch: 1,
      active: [],
      archivedMatches: [
        { borrower: { ...archivedByUsername, archived: true }, matchedBy: 'username' },
        { borrower: { ...archivedByContact, archived: true }, matchedBy: 'contact' },
        { borrower: { ...archivedByName, archived: true }, matchedBy: 'full_name' },
      ],
    });
    expect(inventory.searchBorrowers('')).toEqual({
      ledgerEpoch: 1,
      active: [activeUsernameFirst, activeUsernameSecond, activeIdFirst, activeIdSecond],
      archivedMatches: [],
    });
    expect(db.isTransaction).toBe(false);
    db.close();
  });

  it('keeps search epoch and borrower rows on one generation when a writer commits between reads', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-search-snapshot-'));
    const filename = join(directory, 'inventory.sqlite');
    const reader = openDatabase(filename);
    const writer = openDatabase(filename);
    const original = new InventoryService(reader).createBorrower({
      username: 'old-match',
      name: 'Old Match',
      type: 'individual',
    });
    const interleaved = interleaveAfterRead(
      reader,
      (sql) => sql.includes('SELECT ledger_epoch FROM inventory_replacement_guard'),
      () =>
        transaction(writer, () => {
          writer
            .prepare(
              'UPDATE inventory_replacement_guard SET ledger_epoch=ledger_epoch+1 WHERE singleton=1',
            )
            .run();
          writer.prepare('UPDATE borrowers SET archived=1 WHERE id=?').run(original.id);
          writer
            .prepare('INSERT INTO borrowers(username,name,type) VALUES (?,?,?)')
            .run('new-match', 'New Match', 'individual');
        }),
    );

    const snapshot = new InventoryService(interleaved).searchBorrowers('match');

    expect(snapshot).toEqual({ ledgerEpoch: 1, active: [original], archivedMatches: [] });
    expect(writer.prepare('SELECT ledger_epoch FROM inventory_replacement_guard').get()).toEqual({
      ledger_epoch: 2,
    });
    expect(new InventoryService(writer).searchBorrowers('match').active).toEqual([
      expect.objectContaining({ username: 'new-match' }),
    ]);
    expect(reader.isTransaction).toBe(false);
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps desk identity, balances, watermark, and epoch on one generation across replacement', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-desk-snapshot-'));
    const filename = join(directory, 'inventory.sqlite');
    const reader = openDatabase(filename);
    const writer = openDatabase(filename);
    const setup = new InventoryService(reader);
    const borrower = setup.createBorrower({
      username: 'old-borrower',
      name: 'Old Borrower',
      type: 'individual',
    });
    const item = setup.createItem({ name: 'Old Item', kind: 'non_consumable' });
    setup.addStock(item.id, 2);
    setup.checkout(item.id, borrower.id, 1);
    const interleaved = interleaveAfterRead(
      reader,
      (sql) => sql.includes('SELECT * FROM borrowers WHERE id=?'),
      () =>
        new InventoryTransferService(writer).replaceWithReset({
          locations: [],
          items: [
            {
              code: 900,
              name: 'Replacement Item',
              kind: 'non_consumable',
              location: null,
              aliases: [],
              lotSize: null,
              archived: false,
              total: 5,
            },
          ],
        }),
    );

    const snapshot = new InventoryService(interleaved).getBorrowerDeskSnapshot(borrower.id);

    expect(snapshot).toMatchObject({
      borrower,
      inventory: [expect.objectContaining({ id: item.id, code: item.code, available: 1 })],
      holdings: [{ itemId: item.id, returnable: 1, lost: 0 }],
      asOfEventId: 2,
      ledgerEpoch: 1,
    });
    expect(writer.prepare('SELECT ledger_epoch FROM inventory_replacement_guard').get()).toEqual({
      ledger_epoch: 2,
    });
    expect(new InventoryService(writer).listItems('', true)).toEqual([
      expect.objectContaining({ code: 900, available: 5 }),
    ]);
    expect(reader.isTransaction).toBe(false);
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('assembles one code-ordered desk snapshot with returnable, lost-only, and archived truth', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const borrower = inventory.createBorrower({
      username: 'desk',
      name: 'Desk Borrower',
      type: 'individual',
    });
    const other = inventory.createBorrower({ username: 'other', name: 'Other', type: 'other' });
    const first = inventory.createItem({ name: 'First', kind: 'non_consumable' });
    const lostOnly = inventory.createItem({ name: 'Lost only', kind: 'non_consumable' });
    const returned = inventory.createItem({ name: 'Returned', kind: 'non_consumable' });
    inventory.createItem({ name: 'Excluded consumable', kind: 'consumable' });
    inventory.createItem({ name: 'Excluded camp item', kind: 'camp_equipment' });
    for (const item of [first, lostOnly, returned]) inventory.addStock(item.id, 10);

    const firstCheckout = inventory.checkout(first.id, borrower.id, 5);
    inventory.returnCheckout(firstCheckout, 1, 1);
    inventory.markLost(firstCheckout, 2, true);
    inventory.markLost(firstCheckout, 1, false);
    const secondFirstCheckout = inventory.checkout(first.id, borrower.id, 3);
    inventory.returnCheckout(secondFirstCheckout, 1, 0);
    inventory.markLost(secondFirstCheckout, 1, true);
    const lostCheckout = inventory.checkout(lostOnly.id, borrower.id, 2);
    inventory.markLost(lostCheckout, 2, true);
    const returnedCheckout = inventory.checkout(returned.id, borrower.id, 1);
    inventory.returnCheckout(returnedCheckout, 1, 0);
    inventory.checkout(first.id, other.id, 1);
    db.prepare('UPDATE items SET archived=1 WHERE id=?').run(lostOnly.id);
    const unrelated = inventory.createItem({ name: 'Watermark', kind: 'consumable' });
    const watermark = inventory.addStock(unrelated.id, 1);

    const snapshot = inventory.getBorrowerDeskSnapshot(borrower.id);
    expect(snapshot.borrower).toEqual(borrower);
    expect(
      snapshot.inventory.map(({ code, kind, selectable }) => ({ code, kind, selectable })),
    ).toEqual([
      { code: first.code, kind: 'non_consumable', selectable: true },
      { code: lostOnly.code, kind: 'non_consumable', selectable: false },
      { code: returned.code, kind: 'non_consumable', selectable: true },
    ]);
    expect(snapshot.holdings).toEqual([
      { itemId: first.id, returnable: 3, lost: 2 },
      { itemId: lostOnly.id, returnable: 0, lost: 2 },
    ]);
    expect(snapshot.inventory.find((item) => item.id === first.id)).toMatchObject({ damaged: 1 });
    expect(snapshot.asOfEventId).toBe(watermark);
    expect(snapshot.ledgerEpoch).toBe(1);
    expect(db.isTransaction).toBe(false);
    expect(() => inventory.getBorrowerDeskSnapshot(999_999)).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
    inventory.archiveBorrower(borrower.id, false);
    db.prepare('UPDATE borrowers SET archived=1 WHERE id=?').run(borrower.id);
    expect(() => inventory.getBorrowerDeskSnapshot(borrower.id)).toThrow(
      expect.objectContaining({ code: 'inactive_borrower' }),
    );
    expect(db.isTransaction).toBe(false);
    db.close();
  });

  it('enforces receipt command and outcome checks', () => {
    const db = openDatabase(':memory:');
    receipt(db, 'valid');
    expect(() =>
      db
        .prepare(
          `INSERT INTO idempotency_receipts(
            key,command_kind,ledger_epoch,contract_version,request_hash,outcome
          ) VALUES ('bad-kind','batch',1,1,'hash','committed')`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO idempotency_receipts(
            key,command_kind,ledger_epoch,contract_version,request_hash,outcome
          ) VALUES ('bad-outcome','borrower_create',1,1,'hash','pending')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it('refuses replacement when the ledger-epoch singleton is missing', () => {
    const db = openDatabase(':memory:');
    const inventory = new InventoryService(db);
    const item = inventory.createItem({ name: 'Preserved', kind: 'consumable' });
    inventory.addStock(item.id, 2);
    db.prepare('DELETE FROM inventory_replacement_guard').run();

    expect(() =>
      new InventoryTransferService(db).replaceWithReset({ locations: [], items: [] }),
    ).toThrow(expect.objectContaining({ code: 'internal_error' }));
    expect(inventory.listItems('', true)).toEqual([expect.objectContaining({ available: 2 })]);
    expect(db.isTransaction).toBe(false);
    db.close();
  });
});
