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
    const id = allocateIdentity(db, 'event');
    db.prepare(
      "INSERT INTO inventory_events(id,kind,item_id,quantity,note) VALUES (?,'stock_removed',?,?,?)",
    ).run(id, itemId, quantity, note);
  });
}
