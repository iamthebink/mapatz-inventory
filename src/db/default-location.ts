import type { InventoryDatabase } from './database.js';
import { DomainError } from '../domain/types.js';

/** Maintain the shared default inside the caller's location/startup transaction. */
export function ensureDefaultLocation(db: InventoryDatabase): void {
  if (!db.isTransaction) throw new Error('Default location selection requires a transaction');
  const current = db
    .prepare('SELECT default_location_id FROM inventory_settings WHERE singleton=1')
    .get() as { default_location_id: number | null } | undefined;
  if (!current) throw new Error('Inventory settings are missing');
  if (
    current.default_location_id !== null &&
    db
      .prepare('SELECT id FROM locations WHERE id=? AND archived=0')
      .get(current.default_location_id)
  )
    return;

  const location = db
    .prepare("SELECT id FROM locations WHERE archived=0 ORDER BY (name='צוללת') DESC,id LIMIT 1")
    .get() as { id: number } | undefined;
  if (!location)
    throw new DomainError(
      'active_location_required',
      'חייב להישאר לפחות מיקום פעיל אחד. יש להוסיף או להפעיל מיקום לפני המחיקה, ההעברה לארכיון או הייבוא.',
      409,
    );
  db.prepare('UPDATE inventory_settings SET default_location_id=? WHERE singleton=1').run(
    location.id,
  );
}
