import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { InventoryService } from '../../src/domain/inventory.js';
import { InventoryTransferService } from '../../src/domain/import-export.js';
import { WORKBOOK_CONTRACT } from '../../src/io/workbook-contract.js';
import { exportWorkbook, parseResetWorkbook } from '../../src/io/workbook.js';
import { createApp } from '../../src/server/index.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(clock: { now: number } = { now: 1_000 }) {
  const db = openDatabase(':memory:');
  const inventory = new InventoryService(db);
  const app = createApp({
    database: db,
    adminPassword: 'admin-pass',
    now: () => clock.now,
    serveWeb: false,
  });
  return { db, inventory, app, agent: request.agent(app), clock };
}

function role(agent: ReturnType<typeof request.agent>, target: string, password?: string) {
  return agent.post('/api/session/role').send({ role: target, password });
}

function expectRecoveredState(
  actual: ReturnType<InventoryTransferService['snapshot']>,
  expected: ReturnType<InventoryTransferService['snapshot']>,
) {
  const {
    identityHighWater: actualHighWater,
    nextItemCode: actualNextItemCode,
    ...actualBusinessState
  } = actual;
  const {
    identityHighWater: expectedHighWater,
    nextItemCode: expectedNextItemCode,
    ...expectedBusinessState
  } = expected;
  expect(actualBusinessState).toEqual(expectedBusinessState);
  expect(actualNextItemCode).toBeGreaterThanOrEqual(expectedNextItemCode);
  for (const field of Object.keys(expectedHighWater) as Array<keyof typeof expectedHighWater>)
    expect(actualHighWater[field]).toBeGreaterThanOrEqual(expectedHighWater[field]);
}

describe('inventory API permission and edge-case matrix', () => {
  it('keeps password recovery unavailable in browser mode and requires the desktop token for exact recovery', async () => {
    const browser = fixture();
    await browser.agent.post('/api/password/recovery').expect(404);
    expect(
      browser.db.prepare("SELECT recoverable_password FROM credentials WHERE role='admin'").get(),
    ).toEqual({ recoverable_password: null });
    browser.db.close();

    const db = openDatabase(':memory:');
    const token = 'desktop-launch-token';
    const app = createApp({
      database: db,
      adminPassword: 'exact 👋 password',
      accessToken: token,
      desktopRecovery: true,
      serveWeb: false,
    });
    await request(app).post('/api/password/recovery').expect(403);
    const recovered = await request(app)
      .post('/api/password/recovery')
      .set('x-mapatz-desktop-token', token)
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(recovered.body).toEqual({ password: 'exact 👋 password' });
    expect(
      db.prepare("SELECT recoverable_password FROM credentials WHERE role='admin'").get(),
    ).toEqual({ recoverable_password: 'exact 👋 password' });

    const agent = request.agent(app);
    await agent
      .post('/api/session/role')
      .set('x-mapatz-desktop-token', token)
      .send({ role: 'admin', password: 'exact 👋 password' })
      .expect(200);
    await agent
      .post('/api/password')
      .set('x-mapatz-desktop-token', token)
      .send({ password: '<new&short>' })
      .expect(204);
    const changed = await agent
      .post('/api/password/recovery')
      .set('x-mapatz-desktop-token', token)
      .expect(200);
    expect(changed.body).toEqual({ password: '<new&short>' });
    await agent
      .post('/api/session/role')
      .set('x-mapatz-desktop-token', token)
      .send({ role: 'admin', password: 'exact 👋 password' })
      .expect(401);
    await agent
      .post('/api/session/role')
      .set('x-mapatz-desktop-token', token)
      .send({ role: 'admin', password: '<new&short>' })
      .expect(200);
    db.close();
  });

  it('exposes the exact password in the local development recovery preview', async () => {
    const db = openDatabase(':memory:');
    const app = createApp({
      database: db,
      adminPassword: 'preview-password',
      developmentRecovery: true,
      serveWeb: false,
    });
    const response = await request(app)
      .post('/api/password/recovery')
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(response.body).toEqual({ password: 'preview-password' });
    db.close();
  });

  it('reveals the changed desktop password after reopening the same database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-desktop-credential-'));
    cleanup.push(directory);
    const filename = join(directory, 'inventory.sqlite');
    const token = 'desktop-launch-token';
    let db = openDatabase(filename);
    const first = createApp({
      database: db,
      adminPassword: 'original-password',
      accessToken: token,
      desktopRecovery: true,
      serveWeb: false,
    });
    const agent = request.agent(first);
    await agent
      .post('/api/session/role')
      .set('x-mapatz-desktop-token', token)
      .send({ role: 'admin', password: 'original-password' })
      .expect(200);
    await agent
      .post('/api/password')
      .set('x-mapatz-desktop-token', token)
      .send({ password: 'new password 🔑' })
      .expect(204);
    db.close();

    db = openDatabase(filename);
    const reopened = createApp({
      database: db,
      accessToken: token,
      desktopRecovery: true,
      serveWeb: false,
    });
    const response = await request(reopened)
      .post('/api/password/recovery')
      .set('x-mapatz-desktop-token', token)
      .expect(200);
    expect(response.body).toEqual({ password: 'new password 🔑' });
    db.close();
  });

  it('preserves the desktop recovery credential across workbook reset and recovery', async () => {
    const db = openDatabase(':memory:');
    const token = 'desktop-launch-token';
    const app = createApp({
      database: db,
      adminPassword: 'still-here',
      accessToken: token,
      desktopRecovery: true,
      serveWeb: false,
    });
    const inventory = new InventoryService(db);
    const item = inventory.createItem({ name: 'Existing', kind: 'consumable' });
    inventory.addStock(item.id, 3);
    const transfers = new InventoryTransferService(db);
    const before = transfers.snapshot();
    const recover = () =>
      request(app)
        .post('/api/password/recovery')
        .set('x-mapatz-desktop-token', token)
        .expect(200)
        .expect(({ body }) => expect(body.password).toBe('still-here'));

    transfers.replaceWithReset({ locations: [], items: [] });
    await recover();
    transfers.replaceWithRecovery(before);
    await recover();
    db.close();
  });
  it('enforces admin-only workbook export and returns the standard offline XLSX', async () => {
    const { db, inventory, agent } = fixture();
    const item = inventory.createItem({ name: 'Exported', kind: 'consumable' });
    inventory.addStock(item.id, 4);
    await agent.get('/api/workbook').expect(403);
    await role(agent, 'admin', 'admin-pass').expect(200);
    const response = await agent
      .get('/api/workbook')
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect('content-type', new RegExp(WORKBOOK_CONTRACT.mimeType))
      .expect(200);
    await expect(parseResetWorkbook(response.body as Buffer)).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'Exported', total: 4 })],
    });
    db.close();
  });

  it('requires reset confirmation, validates before mutation, and preserves destination credentials', async () => {
    const { db, inventory, agent } = fixture();
    const oldItem = inventory.createItem({ name: 'Old', kind: 'consumable' });
    inventory.addStock(oldItem.id, 9);
    const oldEventId = inventory.listLedger()[0]!.id;
    const oldLocation = inventory.saveInventoryLocation({
      key: 'pre-reset-location-1',
      ledgerEpoch: inventory.inventoryEpoch(),
      code: 'old-location',
      name: 'Old location',
    });
    const credentialsBefore = db
      .prepare('SELECT role,salt,password_hash,updated_at FROM credentials ORDER BY role')
      .all();
    const workbook = await exportWorkbook({
      radioCount: 0,
      radios: [],
      locations: [{ name: 'Imported Place', archived: false }],
      items: [
        {
          code: 4,
          name: 'Imported',
          kind: 'consumable',
          location: 'Imported Place',
          aliases: [],
          lotSize: null,
          archived: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          startingStock: 6,
          baselineThroughEventId: 0,
          available: 6,
          borrowed: 0,
          damaged: 0,
          lost: 0,
          revision: 0,
          resetTotal: 6,
        },
      ],
      borrowers: [],
      events: [],
      loans: [],
      stateRevision: 0,
      nextItemCode: 100,
      identityHighWater: {
        nextItemId: 1,
        nextBorrowerId: 1,
        nextLocationId: 1,
        nextEventId: 1,
      },
    });
    await agent
      .post('/api/workbook/reset')
      .set('content-type', WORKBOOK_CONTRACT.mimeType)
      .set('x-mapatz-confirmed', 'true')
      .send(workbook)
      .expect(403);
    await role(agent, 'admin', 'admin-pass').expect(200);
    await agent
      .post('/api/workbook/reset')
      .set('content-type', WORKBOOK_CONTRACT.mimeType)
      .send(workbook)
      .expect(400)
      .expect(({ body }) => expect(body.error).toBe('confirmation_required'));
    expect(inventory.listItems('', true)[0]?.name).toBe('Old');
    await agent
      .post('/api/workbook/reset')
      .set('content-type', WORKBOOK_CONTRACT.mimeType)
      .set('x-mapatz-confirmed', 'true')
      .send(Buffer.from('not xlsx'))
      .expect(400)
      .expect(({ body }) => expect(body.error).toBe('invalid_workbook'));
    expect(inventory.listItems('', true)[0]?.name).toBe('Old');

    await agent
      .post('/api/workbook/reset')
      .set('content-type', WORKBOOK_CONTRACT.mimeType)
      .set('x-mapatz-confirmed', 'true')
      .send(workbook)
      .expect(204);
    const imported = inventory.listItems('', true)[0]!;
    expect(imported).toMatchObject({ code: 4, name: 'Imported', available: 6 });
    expect(imported.id).toBeGreaterThan(oldItem.id);
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_command_receipts').get()).toEqual({
      count: 1,
    });
    expect(db.prepare('SELECT key FROM inventory_command_receipts').get()).toEqual({
      key: 'system:identity-high-water',
    });
    const location = db
      .prepare('SELECT id,name FROM locations WHERE id=?')
      .get(imported.locationId) as { id: number; name: string };
    expect(location).toMatchObject({ name: 'Imported Place' });
    expect(location.id).toBeGreaterThan(Number(oldLocation.id));
    const newLocation = inventory.saveInventoryLocation({
      key: 'post-reset-location-1',
      ledgerEpoch: inventory.inventoryEpoch(),
      code: 'new-location',
      name: 'New location',
    });
    const newItem = inventory.createItem({ name: 'Post reset item', kind: 'consumable' });
    inventory.addStock(newItem.id, 1);
    const newEvent = inventory.listLedger()[0]!;
    expect(Number(newLocation.id)).toBeGreaterThan(Number(oldLocation.id));
    expect(newItem.id).toBeGreaterThan(oldItem.id);
    expect(newItem.code).toBeGreaterThan(oldItem.code);
    expect(newEvent.id).toBeGreaterThan(oldEventId);
    expect(
      db.prepare('SELECT role,salt,password_hash,updated_at FROM credentials ORDER BY role').all(),
    ).toEqual(credentialsBefore);
    await role(agent, 'operator').expect(200);
    await role(agent, 'admin', 'admin-pass').expect(200);
    expect(new InventoryTransferService(db).snapshot().items[0]).toMatchObject({
      startingStock: 6,
      resetTotal: 6,
    });
    db.close();
  });

  it('enforces confirmed admin recovery and preserves destination credentials', async () => {
    const sourceDb = openDatabase(':memory:');
    const sourceTransfers = new InventoryTransferService(sourceDb);
    sourceTransfers.replaceWithReset({
      locations: [{ name: 'Recovery Location', archived: false }],
      items: [
        {
          code: 9,
          name: 'Recovered Equipment',
          kind: 'non_consumable',
          location: 'Recovery Location',
          aliases: ['Recovery Alias'],
          lotSize: null,
          archived: false,
          total: 3,
        },
      ],
    });
    const sourceInventory = new InventoryService(sourceDb);
    const sourceItem = sourceInventory.listItems('', true)[0]!;
    const sourceBorrower = sourceInventory.createBorrower({
      username: 'recover-me',
      name: 'Recovery Borrower',
      type: 'individual',
    });
    sourceInventory.checkout(sourceItem.id, sourceBorrower.id, 1, 'preserved loan');
    const expected = sourceTransfers.snapshot();
    const exported = await exportWorkbook(expected);

    const { db, inventory, agent } = fixture();
    const old = inventory.createItem({ name: 'Destination Data', kind: 'consumable' });
    inventory.addStock(old.id, 8);
    const credentialsBefore = db
      .prepare('SELECT role,salt,password_hash,updated_at FROM credentials ORDER BY role')
      .all();
    await agent
      .post('/api/workbook/recovery')
      .set('content-type', WORKBOOK_CONTRACT.mimeType)
      .set('x-mapatz-confirmed', 'true')
      .send(exported)
      .expect(403);
    await role(agent, 'admin', 'admin-pass').expect(200);
    await agent
      .post('/api/workbook/recovery')
      .set('content-type', WORKBOOK_CONTRACT.mimeType)
      .send(exported)
      .expect(400)
      .expect(({ body }) => expect(body.error).toBe('confirmation_required'));
    expect(inventory.listItems('', true)[0]?.name).toBe('Destination Data');
    await agent
      .post('/api/workbook/recovery')
      .set('content-type', WORKBOOK_CONTRACT.mimeType)
      .set('x-mapatz-confirmed', 'true')
      .send(exported)
      .expect(204);

    expectRecoveredState(new InventoryTransferService(db).snapshot(), expected);
    expect(
      db.prepare('SELECT role,salt,password_hash,updated_at FROM credentials ORDER BY role').all(),
    ).toEqual(credentialsBefore);
    await role(agent, 'operator').expect(200);
    await role(agent, 'admin', 'admin-pass').expect(200);
    sourceDb.close();
    db.close();
  });

  it('starts as an operator, requires the admin password for elevation, and downgrades freely', async () => {
    const { db, agent } = fixture();
    await agent
      .get('/api/session')
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ role: 'operator', deadline: null }));
    await role(agent, 'admin', 'wrong')
      .expect(401)
      .expect(({ body }) => expect(body.message).toBe('סיסמה שגויה'));
    await role(agent, 'admin', 'admin-pass')
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ role: 'admin', deadline: 601_000 }));
    await role(agent, 'operator')
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ role: 'operator', deadline: null }));
    await role(agent, 'guest').expect(400);
    db.close();
  });

  it('allows operator work by default and still restricts admin mutations', async () => {
    const { db, inventory, agent } = fixture();
    const item = inventory.createItem({ name: 'כפפה', kind: 'consumable' });
    inventory.addStock(item.id, 5);
    await agent.post('/api/issue').send({ itemId: item.id, quantity: 1 }).expect(201);
    await agent.post('/api/stock/add').send({ itemId: item.id, quantity: 1 }).expect(403);
    await role(agent, 'admin', 'admin-pass').expect(200);
    await agent.post('/api/stock/add').send({ itemId: item.id, quantity: 1 }).expect(201);
    db.close();
  });

  it('keeps camp equipment admin-counted and outside issue and checkout operations', async () => {
    const { db, inventory, agent } = fixture();
    await agent.post('/api/items').send({ name: 'שולחן קבוע', kind: 'camp_equipment' }).expect(403);
    await role(agent, 'admin', 'admin-pass').expect(200);
    const created = await agent
      .post('/api/items')
      .send({ name: 'שולחן קבוע', kind: 'camp_equipment' })
      .expect(201);
    const itemId = Number(created.body.id);
    await agent.post('/api/stock/add').send({ itemId, quantity: 7 }).expect(201);
    await agent
      .post('/api/stock/remove')
      .send({ itemId, quantity: 2 })
      .expect(404)
      .expect(({ body }) => expect(body.error).toBe('not_found'));
    await agent
      .post('/api/issue')
      .send({ itemId, quantity: 1 })
      .expect(400)
      .expect(({ body }) => expect(body.error).toBe('wrong_item_kind'));
    await agent
      .post('/api/checkout')
      .send({ itemId, borrowerId: 999, quantity: 1 })
      .expect(400)
      .expect(({ body }) => expect(body.error).toBe('wrong_item_kind'));
    expect(inventory.listItems(String(created.body.code))[0]).toMatchObject({
      kind: 'camp_equipment',
      available: 7,
      damaged: 0,
    });
    expect(inventory.listLedger().map((event) => event.kind)).toEqual(['stock_added']);
    db.close();
  });

  it('issues consumables borrower-free and rejects borrower fields, invalid quantities, and insufficient stock', async () => {
    const { db, inventory, agent } = fixture();
    const item = inventory.createItem({ name: 'מים', kind: 'consumable' });
    inventory.addStock(item.id, 2);
    await agent
      .post('/api/issue')
      .send({ itemId: item.id, quantity: 1, borrowerId: 4 })
      .expect(400);
    await agent.post('/api/issue').send({ itemId: item.id, quantity: 0 }).expect(400);
    await agent
      .post('/api/issue')
      .send({ itemId: item.id, quantity: 3 })
      .expect(400)
      .expect(({ body }) => expect(body.error).toBe('insufficient_stock'));
    await agent.post('/api/issue').send({ itemId: item.id, quantity: 2 }).expect(201);
    expect(inventory.listLedger().find((event) => event.kind === 'issued')?.borrower_id).toBeNull();
    db.close();
  });

  it('checks out only to an active borrower and partially returns usable/damaged quantities atomically', async () => {
    const { db, inventory, agent } = fixture();
    const item = inventory.createItem({ name: 'אוהל', kind: 'non_consumable' });
    inventory.addStock(item.id, 3);
    const borrower = inventory.createBorrower({
      username: 'CampA',
      name: 'מחנה א',
      type: 'camp_organization',
    });
    const checkout = await agent
      .post('/api/checkout')
      .send({ itemId: item.id, borrowerId: borrower.id, quantity: 2 })
      .expect(201);
    await agent
      .post('/api/return')
      .send({ checkoutId: checkout.body.eventId, usable: 1, damaged: 0 })
      .expect(201);
    await agent
      .post('/api/return')
      .send({ checkoutId: checkout.body.eventId, usable: 2, damaged: 0 })
      .expect(400)
      .expect(({ body }) => expect(body.error).toBe('over_return'));
    expect(inventory.listLoans()[0]?.outstanding).toBe(1);
    inventory.archiveBorrower(borrower.id, false);
    const inactive = inventory.createBorrower({
      username: 'old-user',
      name: 'ישן',
      type: 'individual',
    });
    inventory.archiveBorrower(inactive.id, true);
    await agent
      .post('/api/checkout')
      .send({ itemId: item.id, borrowerId: inactive.id, quantity: 1 })
      .expect(400)
      .expect(({ body }) => expect(body.error).toBe('inactive_borrower'));
    db.close();
  });

  it('restricts marking lost to admins and rejects restoration and excessive quantities', async () => {
    const { db, inventory, agent } = fixture();
    const item = inventory.createItem({ name: 'גנרטור', kind: 'non_consumable' });
    inventory.addStock(item.id, 1);
    const borrower = inventory.createBorrower({ username: 'power', name: 'חשמל', type: 'other' });
    const checkoutId = inventory.checkout(item.id, borrower.id, 1);
    await agent.post('/api/lost').send({ checkoutId, quantity: 1, lost: true }).expect(403);
    await role(agent, 'admin', 'admin-pass');
    await agent.post('/api/lost').send({ checkoutId, quantity: 2, lost: true }).expect(400);
    await agent.post('/api/lost').send({ checkoutId, quantity: 1, lost: true }).expect(201);
    const beforeRestoration = inventory.listLedger();
    await agent.post('/api/lost').send({ checkoutId, quantity: 1, lost: false }).expect(400);
    expect(inventory.listLedger()).toEqual(beforeRestoration);
    expect(inventory.listLoans()[0]).toMatchObject({ outstanding: 0, lost: 1 });
    db.close();
  });

  it('lets operators restore damaged stock but never write it off, including after admin expiry', async () => {
    const clock = { now: 1_000 };
    const { db, inventory, agent } = fixture(clock);
    const item = inventory.createItem({ name: 'Damaged tool', kind: 'non_consumable' });
    inventory.addStock(item.id, 3);
    const borrower = inventory.createBorrower({
      username: 'damage-test',
      name: 'Borrower',
      type: 'individual',
    });
    const checkoutId = inventory.checkout(item.id, borrower.id, 2);
    inventory.returnCheckout(checkoutId, 0, 2);
    const loans = inventory.listLoans();
    const before = inventory.listLedger();
    const requestBody = { itemId: item.id, quantity: 1, note: 'checked' };

    await agent
      .post('/api/damage')
      .send({ ...requestBody, resolution: 'write_off' })
      .expect(403);
    await agent
      .post('/api/damage')
      .send({ ...requestBody, resolution: 'invalid' })
      .expect(400);
    expect(inventory.listLedger()).toEqual(before);
    await agent
      .post('/api/damage')
      .send({ ...requestBody, resolution: 'repair' })
      .expect(201);
    expect(inventory.listItems('', true)[0]).toMatchObject({ available: 2, damaged: 1 });
    expect(inventory.listLedger()[0]).toMatchObject({
      kind: 'repaired',
      quantity: 1,
      note: 'checked',
    });
    expect(inventory.listLoans()).toEqual(loans);

    const afterRepair = inventory.listLedger();
    await agent
      .post('/api/damage')
      .send({ ...requestBody, quantity: 2, resolution: 'repair' })
      .expect(400);
    await agent
      .post('/api/damage')
      .send({ ...requestBody, quantity: 0, resolution: 'repair' })
      .expect(400);
    await agent
      .post('/api/damage')
      .send({ ...requestBody, note: 'x'.repeat(501), resolution: 'repair' })
      .expect(400);
    expect(inventory.listLedger()).toEqual(afterRepair);

    await role(agent, 'admin', 'admin-pass').expect(200);
    await agent
      .post('/api/damage')
      .send({ ...requestBody, resolution: 'write_off' })
      .expect(201);
    expect(inventory.listLedger()[0]).toMatchObject({ kind: 'written_off', quantity: 1 });
    expect(inventory.listItems('', true)[0]).toMatchObject({ available: 2, damaged: 0 });
    expect(inventory.listLoans()).toEqual(loans);

    inventory.returnCheckout(inventory.checkout(item.id, borrower.id, 1), 0, 1);
    const beforeExpiry = inventory.listLedger();
    clock.now += 600_000;
    await agent
      .post('/api/damage')
      .send({ ...requestBody, resolution: 'write_off' })
      .expect(403);
    expect(inventory.listLedger()).toEqual(beforeExpiry);
    expect(inventory.listItems('', true)[0]).toMatchObject({ available: 1, damaged: 1 });
    await agent
      .post('/api/damage')
      .send({ ...requestBody, resolution: 'repair' })
      .expect(201);
    expect(inventory.listLedger()[0]).toMatchObject({ kind: 'repaired', quantity: 1 });
    expect(inventory.listItems('', true)[0]).toMatchObject({ available: 2, damaged: 0 });
    expect(inventory.listLoans()).toEqual(loans);
    db.close();
  });

  it('expires idle privilege server-side and returns a stale mutation as forbidden', async () => {
    const clock = { now: 1_000 };
    const { db, inventory, agent } = fixture(clock);
    const item = inventory.createItem({ name: 'כבל', kind: 'consumable' });
    await role(agent, 'admin', 'admin-pass')
      .expect(200)
      .expect(({ body }) => expect(body.deadline).toBe(601_000));
    clock.now = 601_001;
    await agent.post('/api/stock/add').send({ itemId: item.id, quantity: 1 }).expect(403);
    await agent
      .get('/api/session')
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ role: 'operator', deadline: null }));
    db.close();
  });

  it('extends the admin deadline only through explicit user activity', async () => {
    const { db, agent, clock } = fixture();
    await role(agent, 'admin', 'admin-pass')
      .expect(200)
      .expect(({ body }) => expect(body.deadline).toBe(601_000));
    clock.now = 100_000;
    await agent.get('/api/items').expect(200);
    await agent
      .get('/api/session')
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ role: 'admin', deadline: 601_000 }));
    await agent
      .post('/api/session/activity')
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ role: 'admin', deadline: 700_000 }));
    db.close();
  });

  it('keeps non-admin access active without an inactivity deadline', async () => {
    const clock = { now: 1_000 };
    const { db, inventory, agent } = fixture(clock);
    const item = inventory.createItem({ name: 'חבל', kind: 'consumable' });
    inventory.addStock(item.id, 2);
    await agent.post('/api/issue').send({ itemId: item.id, quantity: 1 }).expect(201);
    clock.now = 86_400_001_000;
    await agent.post('/api/issue').send({ itemId: item.id, quantity: 1 }).expect(201);
    await agent
      .get('/api/session')
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ role: 'operator', deadline: null }));
    db.close();
  });

  it('revokes admin sessions after an admin password change and accepts the new password', async () => {
    const { db, agent } = fixture();
    await role(agent, 'admin', 'admin-pass').expect(200);
    await agent.post('/api/password').send({ password: 'x' }).expect(204);
    await agent
      .get('/api/session')
      .expect(200)
      .expect(({ body }) => expect(body.role).toBe('operator'));
    await role(agent, 'admin', 'admin-pass').expect(401);
    await role(agent, 'admin', 'x').expect(200);
    db.close();
  });

  it('persists changed password hashes and ignores later bootstrap values on reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-credentials-'));
    cleanup.push(directory);
    const filename = join(directory, 'inventory.sqlite');
    let db = openDatabase(filename);
    const firstApp = createApp({
      database: db,
      adminPassword: 'first-admin',
      serveWeb: false,
    });
    const firstAgent = request.agent(firstApp);
    await role(firstAgent, 'admin', 'first-admin').expect(200);
    await firstAgent.post('/api/password').send({ password: 'persisted-admin' }).expect(204);
    db.close();

    db = openDatabase(filename);
    const app = createApp({
      database: db,
      adminPassword: 'replacement-admin',
      serveWeb: false,
    });
    const agent = request.agent(app);
    await role(agent, 'admin', 'replacement-admin').expect(401);
    await role(agent, 'admin', 'first-admin').expect(401);
    await role(agent, 'admin', 'persisted-admin').expect(200);
    db.close();
  });

  it('requires explicit bootstrap passwords only for missing credentials', () => {
    const db = openDatabase(':memory:');
    expect(() => createApp({ database: db, serveWeb: false })).toThrow(/ADMIN_PASSWORD/);
    expect(() =>
      db
        .prepare('INSERT INTO credentials(role,salt,password_hash) VALUES (?,?,?)')
        .run('operator', 'salt', 'hash'),
    ).toThrow();
    db.close();
  });

  it('returns structured errors for malformed or oversized JSON and unknown API routes', async () => {
    const { db, agent } = fixture();
    await agent
      .post('/api/session/role')
      .set('content-type', 'application/json')
      .send('{bad')
      .expect(400)
      .expect(({ body }) => expect(body).toMatchObject({ error: 'invalid_json' }));
    await agent
      .post('/api/session/role')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ role: 'operator', padding: 'x'.repeat(33_000) }))
      .expect(400)
      .expect(({ body }) => expect(body).toMatchObject({ error: 'invalid_json' }));
    await agent
      .get('/api/does-not-exist')
      .expect('content-type', /json/)
      .expect(404)
      .expect(({ body }) => expect(body).toMatchObject({ error: 'not_found' }));
    db.close();
  });

  it('enforces alias bounds at the API boundary', async () => {
    const { db, agent } = fixture();
    await role(agent, 'admin', 'admin-pass');
    await agent
      .post('/api/items')
      .send({ name: 'פריט', kind: 'consumable', aliases: [' '] })
      .expect(400);
    await agent
      .post('/api/items')
      .send({
        name: 'פריט',
        kind: 'consumable',
        aliases: Array.from({ length: 21 }, (_, index) => `alias-${index}`),
      })
      .expect(400);
    db.close();
  });

  it('returns a specific conflict for duplicate item creation and rename', async () => {
    const { db, inventory, agent } = fixture();
    const original = inventory.createItem({ name: 'Tent', kind: 'non_consumable' });
    inventory.archiveItem(original.id, true);
    const other = inventory.createItem({ name: 'Lantern', kind: 'non_consumable' });
    const nextCodeBeforeConflict = db
      .prepare('SELECT next_code FROM code_sequence WHERE singleton=1')
      .get();
    await role(agent, 'admin', 'admin-pass');

    await agent
      .post('/api/items')
      .send({ name: '  tEnT  ', kind: 'consumable' })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toEqual({
          error: 'duplicate_item_name',
          message: 'כבר קיים פריט בשם הזה',
        }),
      );
    expect(db.prepare('SELECT next_code FROM code_sequence WHERE singleton=1').get()).toEqual(
      nextCodeBeforeConflict,
    );

    await agent
      .put(`/api/items/${other.id}`)
      .send({ name: 'TENT' })
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe('duplicate_item_name'));
    expect(inventory.listItems('', true).find((item) => item.id === other.id)?.name).toBe(
      'Lantern',
    );
    db.close();
  });

  it('preserves history while hiding archived records and rejects archive with outstanding equipment', async () => {
    const { db, inventory, agent } = fixture();
    const item = inventory.createItem({ name: 'מקדחה', kind: 'non_consumable' });
    inventory.addStock(item.id, 1);
    const borrower = inventory.createBorrower({
      username: 'drill-user',
      name: 'קודח',
      type: 'individual',
    });
    const checkoutId = inventory.checkout(item.id, borrower.id, 1);
    await role(agent, 'admin', 'admin-pass');
    await agent
      .post(`/api/items/${item.id}/archive`)
      .send({ archived: true })
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe('nonzero_balances'));
    inventory.returnCheckout(checkoutId, 1, 0);
    await agent.post(`/api/items/${item.id}/archive`).send({ archived: true }).expect(204);
    await agent
      .get('/api/items')
      .expect(200)
      .expect(({ body }) => expect(body).toEqual([]));
    await agent
      .get('/api/items?all=1')
      .expect(200)
      .expect(({ body }) => expect(body[0]).toMatchObject({ archived: true, available: 0 }));
    expect(inventory.listLedger()).toHaveLength(4);
    db.close();
  });
});

describe('inventory management API', () => {
  it('authorizes keyed item deletion, replays it safely after name reuse, and reports commit-time blockers', async () => {
    const { db, inventory, agent } = fixture();
    const item = inventory.createItem({ name: 'Disposable item', kind: 'consumable' });
    inventory.addStock(item.id, 2);
    const preview = inventory.listItems('Disposable item')[0]!;
    const command = {
      key: 'api-delete-item-0001',
      ledgerEpoch: inventory.inventoryEpoch(),
      expectedStockRevision: preview.stockRevision,
      expectedCode: preview.code,
      expectedName: preview.name,
      expectedLocationId: preview.locationId,
    };
    await agent.post(`/api/inventory/items/${item.id}/delete`).send(command).expect(403);
    await role(agent, 'admin', 'admin-pass');
    await agent
      .post(`/api/inventory/items/${item.id}/delete`)
      .send({ ...command, unexpected: true })
      .expect(400);
    const deleted = await agent
      .post(`/api/inventory/items/${item.id}/delete`)
      .send(command)
      .expect(200);
    await agent
      .post(`/api/inventory/items/${item.id}/delete`)
      .send(command)
      .expect(200, deleted.body);
    const replacement = inventory.createItem({ name: 'Disposable item', kind: 'consumable' });
    expect(replacement.id).toBeGreaterThan(item.id);
    await agent
      .post(`/api/inventory/items/${item.id}/delete`)
      .send(command)
      .expect(200, deleted.body);
    expect(inventory.listItems('Disposable item')[0]?.id).toBe(replacement.id);

    const borrowedItem = inventory.createItem({ name: 'Checked out item', kind: 'non_consumable' });
    const borrower = inventory.createBorrower({
      username: 'delete-race',
      name: 'Race',
      type: 'individual',
    });
    inventory.addStock(borrowedItem.id, 1);
    const stalePreview = inventory.listItems('Checked out item')[0]!;
    inventory.checkout(borrowedItem.id, borrower.id, 1);
    await agent
      .post(`/api/inventory/items/${borrowedItem.id}/delete`)
      .send({
        key: 'api-delete-ineligible',
        ledgerEpoch: inventory.inventoryEpoch(),
        expectedStockRevision: stalePreview.stockRevision,
        expectedCode: stalePreview.code,
        expectedName: stalePreview.name,
        expectedLocationId: stalePreview.locationId,
      })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ error: 'deletion_ineligible' }));
    expect(inventory.listItems('Checked out item')[0]).toMatchObject({ borrowed: 1 });
    db.close();
  });

  it('deletes settled borrowers through an admin-only preview and preserves exact retries after username reuse', async () => {
    const { db, inventory, agent } = fixture();
    const item = inventory.createItem({ name: 'Borrower deletion item', kind: 'non_consumable' });
    const borrower = inventory.createBorrower({
      username: 'reuse-user',
      name: 'Old user',
      type: 'individual',
    });
    inventory.addStock(item.id, 2);
    const checkoutId = inventory.checkout(item.id, borrower.id, 1);
    inventory.returnCheckout(checkoutId, 1, 0);
    await agent.get(`/api/borrowers/${borrower.id}/deletion-status`).expect(403);
    await role(agent, 'admin', 'admin-pass');
    const status = await agent.get(`/api/borrowers/${borrower.id}/deletion-status`).expect(200);
    expect(status.body).toMatchObject({ borrower: { id: borrower.id }, outstanding: 0, lost: 0 });
    const command = {
      key: 'api-delete-borrower-0001',
      ledgerEpoch: inventory.inventoryEpoch(),
      expectedStateRevision: status.body.stateRevision,
      expectedOutstanding: 0,
      expectedLost: 0,
      expectedName: status.body.borrower.name,
      expectedUsername: status.body.borrower.username,
    };
    const deleted = await agent
      .post(`/api/borrowers/${borrower.id}/delete`)
      .send(command)
      .expect(200);
    await agent
      .post(`/api/borrowers/${borrower.id}/delete`)
      .send(command)
      .expect(200, deleted.body);
    const replacement = inventory.createBorrower({
      username: 'reuse-user',
      name: 'New user',
      type: 'individual',
    });
    expect(replacement.id).toBeGreaterThan(borrower.id);
    await agent
      .post(`/api/borrowers/${borrower.id}/delete`)
      .send(command)
      .expect(200, deleted.body);
    expect(
      inventory.listBorrowers('', true).find((entry) => entry.username === 'reuse-user'),
    ).toMatchObject({
      id: replacement.id,
      name: 'New user',
    });
    db.close();
  });

  it('retires occupied locations atomically after naming a different active destination', async () => {
    const { db, inventory, agent } = fixture();
    const source = inventory.createLocation('SOURCE', 'Source');
    const destination = inventory.createLocation('DEST', 'Destination');
    const active = inventory.createItem({
      name: 'Active item',
      kind: 'consumable',
      locationId: source.id,
    });
    const archived = inventory.createItem({
      name: 'Archived item',
      kind: 'consumable',
      locationId: source.id,
    });
    inventory.addStock(active.id, 3);
    inventory.archiveItem(archived.id, true);
    await role(agent, 'admin', 'admin-pass');
    const base = {
      key: 'api-retire-location-0001',
      ledgerEpoch: inventory.inventoryEpoch(),
      action: 'delete',
      expectedItemIds: [active.id, archived.id].sort((left, right) => left - right),
      expectedCode: source.code,
      expectedName: source.name,
    };
    await agent
      .post(`/api/inventory/locations/${source.id}/retire`)
      .send(base)
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe('destination_required'));
    const command = { ...base, replacementLocationId: destination.id };
    const retired = await agent
      .post(`/api/inventory/locations/${source.id}/retire`)
      .send(command)
      .expect(200);
    await agent
      .post(`/api/inventory/locations/${source.id}/retire`)
      .send(command)
      .expect(200, retired.body);
    expect(inventory.listItems('', true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: active.id, locationId: destination.id, available: 3 }),
        expect.objectContaining({ id: archived.id, locationId: destination.id, archived: true }),
      ]),
    );
    expect(inventory.listLocations(true).some((entry) => entry.id === source.id)).toBe(false);
    db.close();
  });

  it('replays keyed location creation and blocks the same request after admin expiry', async () => {
    const clock = { now: 1_000 };
    const { db, inventory, agent } = fixture(clock);
    const command = {
      key: 'api-location-0001',
      ledgerEpoch: inventory.inventoryEpoch(),
      code: 'A-2',
      name: 'Second storage',
    };
    await agent.post('/api/inventory/locations').send(command).expect(403);
    await role(agent, 'admin', 'admin-pass');
    const created = await agent.post('/api/inventory/locations').send(command).expect(201);
    await agent
      .post('/api/inventory/locations')
      .send(command)
      .expect(201)
      .expect(({ body }) => expect(body.id).toBe(created.body.id));
    expect(inventory.listLocations(true).filter((entry) => entry.code === 'A-2')).toHaveLength(1);
    clock.now += 600_001;
    await agent
      .put(`/api/inventory/locations/${created.body.id}`)
      .send({ ...command, key: 'api-location-0002', name: 'Changed' })
      .expect(403);
    expect(inventory.listLocations(true).find((entry) => entry.id === created.body.id)?.name).toBe(
      'Second storage',
    );
    db.close();
  });

  it('replays keyed location archive and reports its active item blockers', async () => {
    const { db, inventory, agent } = fixture();
    const location = inventory.createLocation('A-3', 'Third storage');
    const item = inventory.createItem({
      name: 'Stored item',
      kind: 'camp_equipment',
      locationId: Number(location.id),
    });
    await role(agent, 'admin', 'admin-pass');
    const command = {
      key: 'api-location-archive-1',
      ledgerEpoch: inventory.inventoryEpoch(),
      code: 'A-3',
      name: 'Third storage',
      archived: true,
    };
    await agent
      .put(`/api/inventory/locations/${location.id}`)
      .send(command)
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe('location_in_use'));
    inventory.archiveItem(item.id, true);
    await agent
      .put(`/api/inventory/locations/${location.id}`)
      .send(command)
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe('location_in_use'));
    const destination = inventory.createLocation('A-4', 'Fourth storage');
    await agent
      .post(`/api/inventory/locations/${location.id}/retire`)
      .send({
        key: 'api-location-retire-1',
        ledgerEpoch: inventory.inventoryEpoch(),
        action: 'archive',
        replacementLocationId: destination.id,
        expectedItemIds: [item.id],
        expectedCode: location.code,
        expectedName: location.name,
      })
      .expect(200);
    inventory.saveInventoryLocation({
      key: 'location-restore-1',
      ledgerEpoch: inventory.inventoryEpoch(),
      locationId: Number(location.id),
      code: 'A-3',
      name: 'Third storage',
      archived: false,
    });
    await agent.put(`/api/inventory/locations/${location.id}`).send(command).expect(200);
    await agent.put(`/api/inventory/locations/${location.id}`).send(command).expect(200);
    expect(inventory.listLocations(true).find((entry) => entry.id === location.id)?.archived).toBe(
      true,
    );
    db.close();
  });

  it('guards location archive against active item references and rejects operator catalog writes', async () => {
    const { db, inventory, agent } = fixture();
    const location = inventory.createLocation('workshop', 'Workshop');
    const item = inventory.createItem({
      name: 'Location blocker',
      kind: 'camp_equipment',
      locationId: Number(location.id),
    });
    const path = `/api/locations/${location.id}`;
    await agent.put(path).send({ code: 'workshop', name: 'Workshop', archived: true }).expect(403);
    await role(agent, 'admin', 'admin-pass');
    await agent
      .put(path)
      .send({ code: 'workshop', name: 'Workshop', archived: true })
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe('location_in_use'));
    expect(inventory.listLocations(true).find((entry) => entry.id === location.id)?.archived).toBe(
      false,
    );
    inventory.archiveItem(item.id, true);
    await agent
      .put(path)
      .send({ code: 'workshop', name: 'Workshop', archived: true })
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe('location_in_use'));
    const destination = inventory.createLocation('repair-bay', 'Repair bay');
    await agent
      .post(`/api/inventory/locations/${location.id}/retire`)
      .send({
        key: 'api-retire-workshop-1',
        ledgerEpoch: inventory.inventoryEpoch(),
        action: 'archive',
        replacementLocationId: destination.id,
        expectedItemIds: [item.id],
        expectedCode: location.code,
        expectedName: location.name,
      })
      .expect(200);
    await agent
      .post(`/api/inventory/items/${item.id}/archive`)
      .send({
        key: 'api-unarchive-workshop-item-1',
        ledgerEpoch: inventory.inventoryEpoch(),
        archived: false,
        locationId: location.id,
      })
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe('invalid_location'));
    await agent
      .post(`/api/inventory/items/${item.id}/archive`)
      .send({
        key: 'api-unarchive-workshop-item-2',
        ledgerEpoch: inventory.inventoryEpoch(),
        archived: false,
        locationId: destination.id,
      })
      .expect(200);
    expect(inventory.listItems('Location blocker')[0]?.locationId).toBe(destination.id);
    db.close();
  });
  it('enforces role, stale counts, and idempotent create/count commands', async () => {
    const { db, inventory, agent } = fixture();
    const creation = {
      key: 'api-create-0001',
      ledgerEpoch: inventory.inventoryEpoch(),
      name: 'Workbench',
      kind: 'camp_equipment',
      aliases: [],
      lotSize: null,
      locationId: null,
      targetAvailable: 20,
    };
    await agent.post('/api/inventory/items').send(creation).expect(403);
    await role(agent, 'admin', 'admin-pass');
    const created = await agent.post('/api/inventory/items').send(creation).expect(201);
    await agent
      .post('/api/inventory/items')
      .send(creation)
      .expect(201)
      .expect(({ body }) => expect(body.id).toBe(created.body.id));
    expect(inventory.listLedger()).toHaveLength(1);
    const itemId = created.body.id as number;
    const count = {
      key: 'api-count-00001',
      ledgerEpoch: inventory.inventoryEpoch(),
      name: 'Workbench edited',
      aliases: [],
      lotSize: null,
      locationId: null,
      targetAvailable: 17,
      stockRevision: created.body.stockRevision,
    };
    inventory.addStock(itemId, 1);
    await agent
      .put(`/api/inventory/items/${itemId}`)
      .send(count)
      .expect(409)
      .expect(({ body }) => expect(body.error).toBe('stale_stock'));
    expect(inventory.listItems('Workbench')[0]).toMatchObject({ name: 'Workbench', available: 21 });
    const latest = inventory.listItems('Workbench')[0]!;
    await agent
      .put(`/api/inventory/items/${itemId}`)
      .send({
        ...count,
        key: 'metadata-00001',
        targetAvailable: undefined,
        stockRevision: undefined,
      })
      .expect(200);
    expect(inventory.listItems('Workbench edited')[0]?.available).toBe(21);
    await agent
      .put(`/api/inventory/items/${itemId}`)
      .send({ ...count, key: 'reviewed-00001', stockRevision: latest.stockRevision })
      .expect(200);
    expect(inventory.listItems('Workbench edited')[0]?.available).toBe(17);
    expect(inventory.listLedger()[0]).toMatchObject({ kind: 'stock_removed', quantity: 4 });
    db.close();
  });

  it('forbids operator write-off after admin expiry while allowing explicit repair', async () => {
    const clock = { now: 1_000 };
    const { db, inventory, agent } = fixture(clock);
    const item = inventory.createItem({ name: 'Damaged saw', kind: 'non_consumable' });
    const borrower = inventory.createBorrower({
      username: 'api-saw',
      name: 'Saw user',
      type: 'individual',
    });
    inventory.addStock(item.id, 2);
    const checkout = inventory.checkout(item.id, borrower.id, 2);
    inventory.returnCheckout(checkout, 0, 2);
    await role(agent, 'admin', 'admin-pass');
    clock.now += 600_001;
    const base = {
      key: 'api-damage-0001',
      ledgerEpoch: inventory.inventoryEpoch(),
      itemId: item.id,
      quantity: 1,
      note: '',
    };
    await agent
      .post('/api/inventory/damage')
      .send({ ...base, resolution: 'write_off' })
      .expect(403);
    expect(inventory.listItems('Damaged saw')[0]?.damaged).toBe(2);
    await agent
      .post('/api/inventory/damage')
      .send({ ...base, resolution: 'repair' })
      .expect(201);
    await agent
      .post('/api/inventory/damage')
      .send({ ...base, resolution: 'repair' })
      .expect(201);
    expect(inventory.listItems('Damaged saw')[0]).toMatchObject({ available: 1, damaged: 1 });
    expect(inventory.listLedger().filter((event) => event.kind === 'repaired')).toHaveLength(1);
    db.close();
  });
});
