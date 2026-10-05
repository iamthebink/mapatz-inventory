import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type InventoryDatabase } from '../../src/db/database.js';
import { InventoryService } from '../../src/domain/inventory.js';
import { createApp } from '../../src/server/index.js';
import { WORKBOOK_CONTRACT } from '../../src/io/workbook-contract.js';
const databases: InventoryDatabase[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
});
async function workbook(invalid = false) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Borrowers');
  sheet.addRow(['Playa Name', 'Full Name', 'Phone Number', 'Camp/Department']);
  sheet.addRow(['imported', 'Imported']);
  if (invalid) sheet.addRow(['bad', '']);
  return Buffer.from(await book.xlsx.writeBuffer());
}
function fixture() {
  const db = openDatabase(':memory:');
  databases.push(db);
  const service = new InventoryService(db);
  const location = service.listLocations().find((l) => l.code === 'monster')!;
  service.saveInventoryLocation({
    key: 'fixture-default',
    ledgerEpoch: 1,
    locationId: location.id,
    code: location.code,
    name: location.name,
    isDefault: true,
  });
  let now = Date.now();
  const agent = request.agent(
    createApp({
      database: db,
      adminPassword: 'secret',
      now: () => now,
      adminIdleMs: 1000,
      serveWeb: false,
    }),
  );
  return {
    db,
    service,
    agent,
    expire: () => {
      now += 2000;
    },
  };
}
describe('admin borrower workbook transport', () => {
  it('denies operators and expired admins before preview or commit', async () => {
    const { agent, service, expire } = fixture();
    const bytes = await workbook();
    for (const operation of ['preview', 'commit']) {
      await agent
        .post(`/api/borrowers/import/${operation}?mode=replace`)
        .set('content-type', WORKBOOK_CONTRACT.mimeType)
        .send(bytes)
        .expect(403);
    }
    await agent.post('/api/session/role').send({ role: 'admin', password: 'secret' }).expect(200);
    expire();
    await agent
      .post('/api/borrowers/import/preview?mode=replace')
      .set('content-type', WORKBOOK_CONTRACT.mimeType)
      .send(bytes)
      .expect(403);
    expect(service.listBorrowers()).toEqual([]);
  });
  it('validates whole upload and transport, then atomically commits only current confirmation', async () => {
    const { agent, service } = fixture();
    const borrower = service.createBorrower({
      playaName: 'removed',
      fullName: 'Removed',
      campDepartment: '',
    });
    const item = service.createItem({
      name: 'Tent',
      kind: 'non_consumable',
      locationId: Number(
        (service.listLocations().find((l) => l.code === 'monster') ?? service.listLocations()[0])!
          .id,
      ),
    });
    service.addStock(
      item.id,
      5,
      '',
      Number(
        (service.listLocations().find((l) => l.code === 'monster') ?? service.listLocations()[0])!
          .id,
      ),
    );
    service.checkout(
      item.id,
      borrower.id,
      2,
      '',
      Number(
        (service.listLocations().find((l) => l.code === 'monster') ?? service.listLocations()[0])!
          .id,
      ),
    );
    await agent.post('/api/session/role').send({ role: 'admin', password: 'secret' });
    const bytes = await workbook();
    const post = (operation: string, data = bytes, mode = 'replace') =>
      agent
        .post(`/api/borrowers/import/${operation}?mode=${mode}`)
        .set('content-type', WORKBOOK_CONTRACT.mimeType)
        .send(data);
    await post('preview', await workbook(true)).expect(400);
    await post('preview', Buffer.from('bad')).expect(400);
    await post('preview', bytes, 'unknown').expect(400);
    await post('commit').expect(400);
    const preview = (await post('preview').expect(200)).body;
    expect(service.listBorrowers()).toHaveLength(1);
    await post('commit')
      .set('x-borrower-import-confirmation', 'a'.repeat(64))
      .expect(200)
      .expect(({ body }) => expect(body.outcome).toBe('confirmation_required'));
    service.checkout(
      item.id,
      borrower.id,
      1,
      '',
      Number(
        (service.listLocations().find((l) => l.code === 'monster') ?? service.listLocations()[0])!
          .id,
      ),
    );
    const stale = (
      await post('commit')
        .set('x-borrower-import-confirmation', preview.confirmationToken)
        .expect(200)
    ).body;
    expect(stale.outcome).toBe('confirmation_required');
    const token = stale.preview.confirmationToken;
    await post('commit')
      .set('x-borrower-import-confirmation', token)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ outcome: 'committed', returned: 3 }));
    await post('commit').set('x-borrower-import-confirmation', token).expect(200);
    expect(service.listItems()[0]?.available).toBe(5);
    expect(service.listBorrowers().map((row) => row.playaName)).toEqual(['imported']);
  });
  it('enforces the XLSX request size limit', async () => {
    const { agent } = fixture();
    await agent.post('/api/session/role').send({ role: 'admin', password: 'secret' });
    await agent
      .post('/api/borrowers/import/preview?mode=merge')
      .set('content-type', WORKBOOK_CONTRACT.mimeType)
      .send(Buffer.alloc(10 * 1024 * 1024 + 1))
      .expect(400);
  });
});
