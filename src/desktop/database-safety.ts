import { migrations } from '../db/database.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// VACUUM INTO includes committed WAL contents without copying a live database file.
export function protectDatabase(filename: string, backupDirectory: string): void {
  if (!existsSync(filename)) return;
  const db = new DatabaseSync(filename);
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name='migrations'").get();
    const versions = table ? db.prepare('SELECT version FROM migrations').all() : [];
    if (
      versions.some(
        (row) => !migrations.some((migration) => migration.version === Number(row.version)),
      )
    )
      throw new Error(
        'Database belongs to a newer application. Reinstall that version; data was not changed.',
      );
    if (
      migrations.some(
        (migration) => !versions.some((row) => Number(row.version) === migration.version),
      )
    ) {
      mkdirSync(backupDirectory, { recursive: true });
      db.prepare('VACUUM INTO ?').run(
        join(backupDirectory, `before-migration-${Date.now()}.sqlite`),
      );
    }
  } finally {
    db.close();
  }
}

// An initialized profile must never bootstrap a replacement empty database.
export function validateInitializedDatabase(filename: string): void {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => String(row.name)),
    );
    if (
      ![
        'migrations',
        'credentials',
        'inventory_events',
        'item_state',
        'item_location_balances',
        'inventory_settings',
        'loan_state',
        'state_clock',
      ].every((name) => tables.has(name)) ||
      !db.prepare('SELECT 1 FROM migrations LIMIT 1').get() ||
      !db.prepare("SELECT 1 FROM credentials WHERE role='admin'").get() ||
      !db.prepare('SELECT 1 FROM state_clock WHERE singleton=1').get() ||
      db
        .prepare(
          'SELECT 1 FROM items i LEFT JOIN item_state s ON s.item_id=i.id WHERE s.item_id IS NULL LIMIT 1',
        )
        .get()
    ) {
      throw new Error(
        'Initialized profile database is empty or incomplete. Restore the original database; no replacement was created.',
      );
    }
  } finally {
    db.close();
  }
}
