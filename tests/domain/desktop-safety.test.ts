import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protectDatabase, validateInitializedDatabase } from '../../src/desktop/database-safety';
import { profilePort, markProfileInitialized } from '../../src/desktop/profile';

describe('desktop profile safety', () => {
  it('backs up committed WAL content before a pending migration without changing receipts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-safety-'));
    const filename = join(directory, 'inventory.sqlite');
    const db = new DatabaseSync(filename);
    try {
      db.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE migrations(version INTEGER PRIMARY KEY); INSERT INTO migrations VALUES(1); CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES('committed');",
      );
      protectDatabase(filename, join(directory, 'backups'));
      const backup = new DatabaseSync(
        join(directory, 'backups', readdirSync(join(directory, 'backups'))[0]!),
      );
      expect(backup.prepare('SELECT value FROM proof').get()).toEqual({ value: 'committed' });
      backup.close();
      expect(db.prepare('SELECT version FROM migrations').all()).toEqual([{ version: 1 }]);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rejects zero-byte and empty SQLite databases for initialized profiles without adding tables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-empty-'));
    const filename = join(directory, 'inventory.sqlite');
    const db = new DatabaseSync(filename);
    db.close();
    try {
      expect(() => validateInitializedDatabase(filename)).toThrow('empty or incomplete');
      const empty = new DatabaseSync(filename);
      empty.exec('CREATE TABLE unrelated(value TEXT)');
      empty.close();
      expect(() => validateInitializedDatabase(filename)).toThrow('empty or incomplete');
      const check = new DatabaseSync(filename, { readOnly: true });
      expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([
        { name: 'unrelated' },
      ]);
      check.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rejects newer schemas before backup or mutation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-safety-'));
    const filename = join(directory, 'inventory.sqlite');
    const db = new DatabaseSync(filename);
    try {
      db.exec(
        'CREATE TABLE migrations(version INTEGER PRIMARY KEY); INSERT INTO migrations VALUES(999)',
      );
      expect(() => protectDatabase(filename, join(directory, 'backups'))).toThrow(
        'newer application',
      );
      expect(existsSync(join(directory, 'backups'))).toBe(false);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('keeps its origin and refuses to silently replace a missing initialized database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-safety-'));
    try {
      const port = await profilePort(directory);
      expect(await profilePort(directory)).toBe(port);
      markProfileInitialized(directory);
      await expect(profilePort(directory)).rejects.toThrow('database is missing');
      expect(existsSync(join(directory, 'inventory.sqlite'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
