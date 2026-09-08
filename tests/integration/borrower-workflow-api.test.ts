import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type InventoryDatabase } from '../../src/db/database.js';
import { InventoryService } from '../../src/domain/inventory.js';
import { createApp } from '../../src/server/index.js';

const databases: InventoryDatabase[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = openDatabase(':memory:');
  databases.push(db);
  const inventory = new InventoryService(db);
  const app = createApp({ database: db, adminPassword: 'admin-pass', serveWeb: false });
  return { db, inventory, agent: request.agent(app) };
}

describe('borrower workflow snapshot API', () => {
  it('returns the exact search and desk snapshot transports', async () => {
    const { db, inventory, agent } = fixture();
    const borrower = inventory.createBorrower({
      username: 'desk-user',
      name: 'Desk User',
      contact: '050 123',
      type: 'individual',
    });
    const archived = inventory.createBorrower({
      username: 'archived-user',
      name: 'Archived User',
      contact: '050 123',
      type: 'other',
    });
    inventory.archiveBorrower(archived.id, true);
    const usernameOnly = inventory.createBorrower({
      username: 'needle-account',
      name: 'Unrelated Name',
      contact: '999',
      type: 'other',
    });
    const item = inventory.createItem({ name: 'Tent', kind: 'non_consumable' });
    inventory.addStock(item.id, 2);
    const checkout = inventory.checkout(item.id, borrower.id, 2);
    inventory.returnCheckout(checkout, 0, 1);

    await agent
      .get('/api/borrowers/search')
      .query({ q: ' ０５０   １２３ ' })
      .expect(200)
      .expect(({ body }) =>
        expect(body).toEqual({
          ledgerEpoch: 1,
          active: [borrower],
          archivedMatches: [{ borrower: { ...archived, archived: true }, matchedBy: 'contact' }],
        }),
      );
    await agent
      .get('/api/borrowers/search?q=needle')
      .expect(200)
      .expect(({ body }) => expect(body.active).toEqual([usernameOnly]));
    await agent
      .get(`/api/borrowers/${borrower.id}/desk-snapshot`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          borrower,
          inventory: [{ ...inventory.listItems('Tent')[0], selectable: true }],
          holdings: [{ itemId: item.id, returnable: 1, lost: 0 }],
          asOfEventId: 3,
          ledgerEpoch: 1,
        });
      });
    expect(db.isTransaction).toBe(false);
  });

  it('uses the existing typed envelope for unknown, inactive, and internal snapshot failures', async () => {
    const { db, inventory, agent } = fixture();
    const active = inventory.createBorrower({
      username: 'active',
      name: 'Active',
      type: 'individual',
    });
    const inactive = inventory.createBorrower({
      username: 'inactive',
      name: 'Inactive',
      type: 'other',
    });
    inventory.archiveBorrower(inactive.id, true);

    await agent
      .get('/api/borrowers/999999/desk-snapshot')
      .expect(404)
      .expect(({ body }) =>
        expect(body).toEqual({ error: 'not_found', message: 'Borrower not found' }),
      );
    await agent
      .get(`/api/borrowers/${inactive.id}/desk-snapshot`)
      .expect(400)
      .expect(({ body }) =>
        expect(body).toEqual({ error: 'inactive_borrower', message: 'Borrower is inactive' }),
      );

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.exec('DROP TABLE items');
    await agent
      .get(`/api/borrowers/${active.id}/desk-snapshot`)
      .expect(500)
      .expect(({ body }) =>
        expect(body).toEqual({ error: 'internal_error', message: 'אירעה שגיאה פנימית' }),
      );
    expect(db.isTransaction).toBe(false);
    db.exec('DROP TABLE inventory_replacement_guard');
    await agent
      .get('/api/borrowers/search?q=anything')
      .expect(500)
      .expect(({ body }) =>
        expect(body).toEqual({ error: 'internal_error', message: 'אירעה שגיאה פנימית' }),
      );
    expect(db.isTransaction).toBe(false);
  });

  it('preserves forbidden mutation behavior without writing an event or receipt', async () => {
    const { db, inventory, agent } = fixture();
    const item = inventory.createItem({ name: 'Protected', kind: 'consumable' });
    const before = {
      events: db.prepare('SELECT COUNT(*) count FROM inventory_events').get(),
      receipts: db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get(),
    };

    await agent
      .post('/api/stock/add')
      .send({ itemId: item.id, quantity: 1 })
      .expect(403)
      .expect(({ body }) =>
        expect(body).toEqual({ error: 'forbidden', message: 'אין הרשאה לפעולה זו' }),
      );
    expect({
      events: db.prepare('SELECT COUNT(*) count FROM inventory_events').get(),
      receipts: db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get(),
    }).toEqual(before);
  });
});
