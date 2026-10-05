import type { InventoryDatabase } from '../../src/db/database.js';
import { transaction } from '../../src/db/database.js';
import { allocateIdentity } from '../../src/db/identity-high-water.js';

export function recordHistoricalStockRemoval(
  db: InventoryDatabase,
  itemId: number,
  quantity: number,
  note = 'historical stock correction',
): void {
  transaction(db, () => {
    const location = db
      .prepare(
        'SELECT l.name,l.code FROM item_location_balances p JOIN locations l ON l.id=p.location_id WHERE p.item_id=? ORDER BY l.id LIMIT 1',
      )
      .get(itemId)!;
    const id = allocateIdentity(db, 'event');
    db.prepare(
      "INSERT INTO inventory_events(id,kind,item_id,quantity,note,location_name,location_code) VALUES (?,'stock_removed',?,?,?,?,?)",
    ).run(id, itemId, quantity, note, String(location.name), String(location.code));
  });
}
