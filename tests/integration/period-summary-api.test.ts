import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { createApp } from '../../src/server/index.js';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('period summary API', () => {
  it('allows operator and admin reads, validates dates, and leaves the ledger unchanged', async () => {
    const db = openDatabase(':memory:');
    databases.push(db);
    db.prepare(
      "INSERT INTO borrowers(id,username,name,contact,type) VALUES (1,'one','Alpha','555','individual')",
    ).run();
    db.prepare(
      "INSERT INTO items(id,code,name,kind) VALUES (1,100,'Chairs','non_consumable')",
    ).run();
    db.prepare(
      "INSERT INTO inventory_events(kind,item_id,borrower_id,quantity,created_at) VALUES ('checked_out',1,1,2,'2026-09-21 09:00:00')",
    ).run();
    const agent = request.agent(
      createApp({ database: db, adminPassword: 'admin-pass', serveWeb: false }),
    );
    const path = '/api/period-summary?start=2026-09-21&end=2026-09-21';
    const operator = await agent.get(path).expect(200);
    expect(operator.body.borrowers[0]).toMatchObject({ total: 2, borrower: { username: 'one' } });
    await agent
      .post('/api/session/role')
      .send({ role: 'admin', password: 'admin-pass' })
      .expect(200);
    expect((await agent.get(path).expect(200)).body).toEqual(operator.body);
    await agent.get('/api/period-summary?start=2026-02-30&end=2026-09-21').expect(400);
    await agent.get('/api/period-summary?start=2026-09-22&end=2026-09-21').expect(400);
    await agent.get('/api/period-summary?start=2099-01-01&end=2099-01-01').expect(400);
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual({ count: 1 });
  });
});
