import type { InventoryDatabase } from './database.js';

/**
 * Numeric row ids are exposed to pending commands and report cursors. Keep their
 * allocators above every id ever handed out, even when deletion removes the
 * highest live row. This is stored as non-personal protocol metadata in the
 * existing command-receipt table so it does not require a schema migration.
 */
export type IdentityHighWater = {
  nextItemId: number;
  nextBorrowerId: number;
  nextLocationId: number;
  nextEventId: number;
};

export type IdentityKind = 'item' | 'borrower' | 'location' | 'event';

export const identityHighWaterReceiptKey = 'system:identity-high-water';

const receiptHash = 'system:identity-high-water:v1';
const nextField: Record<IdentityKind, keyof IdentityHighWater> = {
  item: 'nextItemId',
  borrower: 'nextBorrowerId',
  location: 'nextLocationId',
  event: 'nextEventId',
};
const tableFor: Record<IdentityKind, string> = {
  item: 'items',
  borrower: 'borrowers',
  location: 'locations',
  event: 'inventory_events',
};

function liveNextId(db: InventoryDatabase, kind: IdentityKind): number {
  const row = db.prepare(`SELECT COALESCE(MAX(id),0)+1 next_id FROM ${tableFor[kind]}`).get() as
    { next_id: number } | undefined;
  const nextId = Number(row?.next_id);
  if (!Number.isSafeInteger(nextId) || nextId < 1)
    throw new Error(`Invalid ${kind} identity high-water mark`);
  return nextId;
}

function validHighWater(value: unknown): value is IdentityHighWater {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    ['nextItemId', 'nextBorrowerId', 'nextLocationId', 'nextEventId'].every(
      (field) => Number.isSafeInteger(record[field]) && Number(record[field]) > 0,
    ) && Object.keys(record).length === 4
  );
}

function receiptHighWater(db: InventoryDatabase): IdentityHighWater | undefined {
  const row = db
    .prepare('SELECT request_hash,result_json FROM inventory_command_receipts WHERE key=?')
    .get(identityHighWaterReceiptKey) as { request_hash: string; result_json: string } | undefined;
  if (!row) return undefined;
  if (row.request_hash !== receiptHash) throw new Error('Identity high-water receipt is corrupted');
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.result_json);
  } catch {
    throw new Error('Identity high-water receipt is corrupted');
  }
  if (!validHighWater(parsed)) throw new Error('Identity high-water receipt is corrupted');
  return parsed;
}

export function persistIdentityHighWater(
  db: InventoryDatabase,
  highWater: IdentityHighWater,
): void {
  if (!validHighWater(highWater)) throw new Error('Invalid identity high-water mark');
  db.prepare(
    `INSERT INTO inventory_command_receipts(key,request_hash,result_json)
      VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET
      request_hash=excluded.request_hash,result_json=excluded.result_json`,
  ).run(identityHighWaterReceiptKey, receiptHash, JSON.stringify(highWater));
}

/** Read and, if needed, initialize the durable high-water cursor. */
export function getIdentityHighWater(db: InventoryDatabase): IdentityHighWater {
  const stored = receiptHighWater(db);
  if (stored) return stored;
  const live: IdentityHighWater = {
    nextItemId: liveNextId(db, 'item'),
    nextBorrowerId: liveNextId(db, 'borrower'),
    nextLocationId: liveNextId(db, 'location'),
    nextEventId: liveNextId(db, 'event'),
  };
  return live;
}

export function preserveIdentityHighWater(
  db: InventoryDatabase,
  requested: IdentityHighWater,
): IdentityHighWater {
  const live = getIdentityHighWater(db);
  const highWater = {
    nextItemId: Math.max(live.nextItemId, requested.nextItemId),
    nextBorrowerId: Math.max(live.nextBorrowerId, requested.nextBorrowerId),
    nextLocationId: Math.max(live.nextLocationId, requested.nextLocationId),
    nextEventId: Math.max(live.nextEventId, requested.nextEventId),
  };
  persistIdentityHighWater(db, highWater);
  return highWater;
}

export function allocateIdentity(db: InventoryDatabase, kind: IdentityKind): number {
  const highWater = getIdentityHighWater(db);
  const field = nextField[kind];
  const id = highWater[field];
  if (!Number.isSafeInteger(id + 1)) throw new Error(`${kind} identity range is exhausted`);
  persistIdentityHighWater(db, { ...highWater, [field]: id + 1 });
  return id;
}
