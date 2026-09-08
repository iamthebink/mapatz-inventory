import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export type InventoryDatabase = DatabaseSync;

export function openDatabase(filename: string): InventoryDatabase {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db: InventoryDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM migrations').all() as { version: number }[]).map((row) =>
      Number(row.version),
    ),
  );
  const migrations = [
    { version: 1, filename: '001_initial.sql', disableForeignKeys: false },
    { version: 2, filename: '002_import_export.sql', disableForeignKeys: true },
    { version: 3, filename: '003_admin_only_credentials.sql', disableForeignKeys: false },
    { version: 4, filename: '004_camp_equipment.sql', disableForeignKeys: true },
    { version: 5, filename: '005_idempotency.sql', disableForeignKeys: false },
  ];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const sql = readFileSync(resolve(here, `migrations/${migration.filename}`), 'utf8');
    if (migration.disableForeignKeys) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
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
