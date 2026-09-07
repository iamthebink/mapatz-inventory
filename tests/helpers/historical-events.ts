import type { InventoryDatabase } from '../../src/db/database.js';

export function recordHistoricalStockRemoval(
  db: InventoryDatabase,
  itemId: number,
  quantity: number,
  note = 'historical stock correction',
): void {
  db.prepare(
    "INSERT INTO inventory_events(kind,item_id,quantity,note) VALUES ('stock_removed',?,?,?)",
  ).run(itemId, quantity, note);
}
