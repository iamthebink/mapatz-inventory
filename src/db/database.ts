import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBorrowerText, normalizeBorrowerPhone } from '../domain/borrower-profile.js';
import { normalizeItemName } from '../domain/item-name.js';

const here = dirname(fileURLToPath(import.meta.url));

export const migrations = [
  { version: 1, filename: '001_initial.sql', disableForeignKeys: false },
  { version: 2, filename: '002_import_export.sql', disableForeignKeys: true },
  { version: 3, filename: '003_admin_only_credentials.sql', disableForeignKeys: false },
  { version: 4, filename: '004_camp_equipment.sql', disableForeignKeys: true },
  { version: 5, filename: '005_idempotency.sql', disableForeignKeys: false },
  { version: 6, filename: '006_found_returned.sql', disableForeignKeys: true },
  { version: 7, filename: '007_unique_item_names.sql', disableForeignKeys: false },
  { version: 8, filename: '008_recoverable_admin_password.sql', disableForeignKeys: false },
  { version: 9, filename: '009_radio_fleet.sql', disableForeignKeys: false },
];

export type InventoryDatabase = DatabaseSync;

export function openDatabase(filename: string): InventoryDatabase {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  try {
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function migrate(db: InventoryDatabase): void {
  db.function('normalize_borrower_text', { deterministic: true }, (value) =>
    normalizeBorrowerText(String(value)),
  );
  db.function('normalize_borrower_phone', { deterministic: true }, (value) =>
    normalizeBorrowerPhone(String(value)),
  );
  db.function('normalize_item_name', { deterministic: true }, (value) =>
    normalizeItemName(String(value)),
  );
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM migrations').all() as { version: number }[]).map((row) =>
      Number(row.version),
    ),
  );
  const freshInstall = applied.size === 0;

  if (!freshInstall) {
    const existing = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((row) => row.name),
    );
    if (['item_state', 'loan_state', 'state_clock'].some((name) => !existing.has(name)))
      throw new Error(
        'Database is missing authoritative inventory state; restore a supported backup.',
      );
  }
  if (
    [...applied].some((version) => !migrations.some((migration) => migration.version === version))
  )
    throw new Error('Database schema is newer than this application; install the newer version.');
  if (!freshInstall) {
    const columns = (db.prepare('PRAGMA table_info(borrowers)').all() as { name: string }[]).map(
      (row) => row.name,
    );
    if (
      !['playa_name', 'full_name', 'phone_number', 'camp_department'].every((name) =>
        columns.includes(name),
      )
    )
      throw new Error(
        'Database uses an unsupported borrower profile schema. Preserve it and use a separate fresh database; no upgrade migration is provided.',
      );
  }
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const sql = readFileSync(resolve(here, `migrations/${migration.filename}`), 'utf8');
    if (migration.disableForeignKeys) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (
        migration.version === 6 &&
        db.prepare("SELECT 1 FROM inventory_events WHERE kind='unmarked_lost' LIMIT 1").get()
      )
        throw new Error(
          'Migration 006 blocked: legacy unmarked_lost history is ambiguous. Preserve this database and explicitly reconcile its history with an operator before upgrading, or use a separate fresh database. No history was changed.',
        );
      db.exec(sql);
      if (migration.disableForeignKeys) {
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0)
          throw new Error(`Migration ${migration.version} introduced foreign-key violations`);
      }
      db.prepare('INSERT INTO migrations(version) VALUES (?)').run(migration.version);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    } finally {
      if (migration.disableForeignKeys) db.exec('PRAGMA foreign_keys = ON');
    }
  }
  if (freshInstall) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(readFileSync(resolve(here, 'operational-state.sql'), 'utf8'));
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  } else {
    if (
      !db.prepare('SELECT 1 FROM state_clock WHERE singleton=1').get() ||
      db
        .prepare(
          'SELECT 1 FROM items i LEFT JOIN item_state s ON s.item_id=i.id WHERE s.item_id IS NULL LIMIT 1',
        )
        .get()
    )
      throw new Error('Database has incomplete authoritative inventory state.');
  }
  const invalidState = db
    .prepare(
      `SELECT 1 FROM items i JOIN item_state s ON s.item_id=i.id
    WHERE s.available < 0 OR s.borrowed < 0 OR s.damaged < 0 OR s.lost < 0
      OR (i.kind='consumable' AND (s.borrowed<>0 OR s.damaged<>0 OR s.lost<>0))
      OR (i.archived=1 AND (s.available<>0 OR s.borrowed<>0 OR s.damaged<>0 OR s.lost<>0))
      OR s.borrowed <> (SELECT COALESCE(SUM(l.outstanding),0) FROM loan_state l WHERE l.item_id=i.id)
      OR s.lost <> (SELECT COALESCE(SUM(l.lost),0) FROM loan_state l WHERE l.item_id=i.id)
    LIMIT 1`,
    )
    .get();
  const invalidLoan = db
    .prepare(
      `SELECT 1 FROM loan_state l JOIN borrowers b ON b.id=l.borrower_id
    WHERE l.outstanding<0 OR l.lost<0 OR l.outstanding+l.lost>l.quantity
      OR (b.archived=1 AND l.outstanding>0) LIMIT 1`,
    )
    .get();
  const invalidLoanIdentity = db
    .prepare(
      `SELECT 1 FROM loan_state l LEFT JOIN inventory_events e ON e.id=l.checkout_id
    WHERE e.id IS NULL OR e.kind<>'checked_out' OR e.item_id<>l.item_id
      OR e.borrower_id IS NOT l.borrower_id OR e.quantity<>l.quantity LIMIT 1`,
    )
    .get();
  const itemAtArchivedLocation = db
    .prepare(
      `SELECT 1 FROM items i JOIN locations l ON l.id=i.location_id
      WHERE l.archived=1 LIMIT 1`,
    )
    .get();
  const checkoutWithoutLoan = db
    .prepare(
      `SELECT 1 FROM inventory_events e LEFT JOIN loan_state l ON l.checkout_id=e.id
    WHERE e.kind='checked_out' AND l.checkout_id IS NULL LIMIT 1`,
    )
    .get();
  if (invalidState || invalidLoan)
    throw new Error('Database has invalid authoritative inventory balances.');
  if (invalidLoanIdentity || checkoutWithoutLoan)
    throw new Error('Database has inconsistent checkout and loan state.');
  if (itemAtArchivedLocation)
    throw new Error('Database has an item assigned to an archived location.');
}

export function transaction<T>(db: InventoryDatabase, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function readTransaction<Operation extends () => unknown>(
  db: InventoryDatabase,
  operation: Operation & (ReturnType<Operation> extends PromiseLike<unknown> ? never : unknown),
): ReturnType<Operation> {
  db.exec('BEGIN');
  try {
    const result = operation() as ReturnType<Operation>;
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
