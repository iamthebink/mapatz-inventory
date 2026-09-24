import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { openDatabase } from '../../src/db/database.js';
import { InventoryService } from '../../src/domain/inventory.js';
import { periodBounds, todayInIsrael } from '../../src/domain/period-summary.js';
import { createApp } from '../../src/server/index.js';

const directory = mkdtempSync(join(tmpdir(), 'mapatz-e2e-'));
const databasePath = join(directory, 'inventory.sqlite');
const database = openDatabase(databasePath);
const inventory = new InventoryService(database);
const app = createApp({
  database,
  adminPassword: 'e2e-admin-password',
  serveWeb: false,
});
let sequence = 0;

app.get('/__e2e__/health', (_request, response) => response.json({ ready: true }));
app.get('/__e2e__/database', (_request, response) => response.json({ databasePath }));
app.post('/__e2e__/seed', (_request, response) => {
  sequence += 1;
  const stockItem = inventory.createItem({
    name: `פריט מלאי בדיקה ${sequence}`,
    kind: 'non_consumable',
    aliases: [`stock-${sequence}`],
  });
  inventory.addStock(stockItem.id, 3, 'e2e seed');
  const borrower = inventory.createBorrower({
    username: `e2e-${sequence}`,
    name: `שואל בדיקה ${sequence}`,
    contact: `050000${String(sequence).padStart(4, '0')}`,
    type: 'individual',
  });
  const item = inventory.createItem({
    name: `אוהל בדיקה ${sequence}`,
    kind: 'non_consumable',
    aliases: [`tent-${sequence}`],
  });
  inventory.addStock(item.id, 6, 'e2e seed');
  const checkoutId = inventory.checkout(item.id, borrower.id, 2, 'e2e holding');
  const archiveItem = inventory.createItem({
    name: `פריט ארכיון בדיקה ${sequence}`,
    kind: 'non_consumable',
    aliases: [`archive-${sequence}`],
  });
  inventory.addStock(archiveItem.id, 2, 'e2e seed');
  const archivedBorrower = inventory.createBorrower({
    username: `archived-${sequence}`,
    name: `שואל ארכיון ${sequence}`,
    contact: `059000${String(sequence).padStart(4, '0')}`,
    type: 'individual',
  });
  inventory.archiveBorrower(archivedBorrower.id, true);
  response.json({ borrower, item, stockItem, archiveItem, archivedBorrower, checkoutId });
});
app.post('/__e2e__/period-summary/history/:borrowerId/:itemId', (request, response) => {
  const today = todayInIsrael();
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { startUtc } = periodBounds(yesterday, yesterday);
  database
    .prepare(
      "INSERT INTO inventory_events(kind,item_id,borrower_id,quantity,created_at,note) VALUES ('checked_out',?,?,?,?,?)",
    )
    .run(
      Number(request.params.itemId),
      Number(request.params.borrowerId),
      2,
      startUtc,
      'e2e historical summary',
    );
  response.json({ date: yesterday });
});
app.post(
  '/__e2e__/conflicts/operation/:stockItemId/:checkoutId/:archiveItemId',
  (request, response) => {
    const stockItemId = Number(request.params.stockItemId);
    const checkoutId = Number(request.params.checkoutId);
    const archiveItemId = Number(request.params.archiveItemId);
    const available =
      inventory.listItems('', true).find((item) => item.id === stockItemId)?.available ?? 0;
    if (available > 0)
      database
        .prepare(
          "INSERT INTO inventory_events(kind,item_id,quantity,note) VALUES ('stock_removed',?,?,?)",
        )
        .run(stockItemId, available, 'e2e stock conflict');
    const loan = inventory.listLoans().find((candidate) => candidate.checkoutId === checkoutId);
    if (loan?.outstanding)
      inventory.returnCheckout(checkoutId, loan.outstanding, 0, 'e2e return conflict');
    database.prepare('UPDATE items SET archived=1 WHERE id=?').run(archiveItemId);
    response.status(204).end();
  },
);
app.post(
  '/__e2e__/conflicts/resolve/:borrowerId/:itemId/:stockItemId/:archiveItemId',
  (request, response) => {
    const borrowerId = Number(request.params.borrowerId);
    const itemId = Number(request.params.itemId);
    const stockItemId = Number(request.params.stockItemId);
    const archiveItemId = Number(request.params.archiveItemId);
    inventory.addStock(stockItemId, 4, 'e2e conflict resolution');
    inventory.checkout(itemId, borrowerId, 2, 'e2e conflict resolution');
    database.prepare('UPDATE items SET archived=0 WHERE id=?').run(archiveItemId);
    response.status(204).end();
  },
);
app.post('/__e2e__/archive-borrower/:borrowerId', (request, response) => {
  database
    .prepare('UPDATE borrowers SET archived=1 WHERE id=?')
    .run(Number(request.params.borrowerId));
  response.status(204).end();
});
app.post('/__e2e__/rotate-epoch', (_request, response) => {
  database.exec(
    'UPDATE inventory_replacement_guard SET ledger_epoch = ledger_epoch + 1 WHERE singleton = 1',
  );
  response.status(204).end();
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await vite.close();
  database.close();
  rmSync(directory, { recursive: true, force: true });
  if (existsSync(directory))
    throw new Error(`E2E temporary directory was not removed: ${directory}`);
}
app.post('/__e2e__/shutdown', (_request, response) => {
  response.status(204).end();
  setImmediate(() => void shutdown().then(() => process.exit(0)));
});

const vite = await createViteServer({
  server: { middlewareMode: true, hmr: false },
  appType: 'spa',
});
app.use(vite.middlewares);
const server = app.listen(4173, '127.0.0.1');
process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
