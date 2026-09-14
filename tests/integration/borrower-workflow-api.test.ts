import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type InventoryDatabase } from '../../src/db/database.js';
import { InventoryService } from '../../src/domain/inventory.js';
import { InventoryTransferService } from '../../src/domain/import-export.js';
import { DomainError } from '../../src/domain/types.js';
import { createApp } from '../../src/server/index.js';
import { apiRouter } from '../../src/server/routes.js';
import { SessionStore } from '../../src/server/session.js';

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
  it('accepts an operator lost-credit part and rejects malformed lost-credit payloads', async () => {
    const { db, inventory, agent } = fixture();
    const borrower = inventory.createBorrower({
      username: 'lost-credit',
      name: 'Lost Credit',
      type: 'individual',
    });
    const item = inventory.createItem({ name: 'Recovered tent', kind: 'non_consumable' });
    inventory.addStock(item.id, 1);
    const checkoutId = inventory.checkout(item.id, borrower.id, 1);
    inventory.markLost(checkoutId, 1, true);

    await agent
      .post(`/api/borrowers/${borrower.id}/operations`)
      .set('Idempotency-Key', '00000000-0000-4000-8000-000000000120')
      .send({
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [{ itemId: item.id, lostCredit: [{ quantity: 1, note: 'found' }] }],
      })
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ outcome: 'committed' }));
    expect(
      db.prepare("SELECT COUNT(*) count FROM inventory_events WHERE kind='marked_lost'").get(),
    ).toEqual({ count: 1 });

    await agent
      .post(`/api/borrowers/${borrower.id}/operations`)
      .set('Idempotency-Key', '00000000-0000-4000-8000-000000000121')
      .send({
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [{ itemId: item.id, lostCredit: [{ quantity: 1, note: '', extra: true }] }],
      })
      .expect(400)
      .expect(({ body }) => expect(body.error).toBe('validation_error'));
  });

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
      .get('/api/borrowers/search')
      .expect(200)
      .expect(({ body }) =>
        expect(body).toEqual({
          ledgerEpoch: 1,
          active: [borrower, usernameOnly],
          archivedMatches: [],
        }),
      );
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

  it('validates command transport strictly before writing receipts and preserves unknown borrower 404', async () => {
    const { db, agent } = fixture();
    await agent
      .post('/api/borrowers/not-an-id/operations')
      .set('Idempotency-Key', 'not-a-uuid')
      .send({ contractVersion: 2, ledgerEpoch: 0, items: [], extra: true })
      .expect(400)
      .expect(({ body }) => {
        expect(body).toMatchObject({ error: 'validation_error' });
        expect(body).not.toHaveProperty('idempotencyKey');
        expect(body.fieldErrors.map((error: { field: string }) => error.field)).toEqual([
          'borrowerId',
          'Idempotency-Key',
          'contractVersion',
          'ledgerEpoch',
          'items',
          'extra',
        ]);
      });
    expect(db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual({
      count: 0,
    });

    await agent
      .post('/api/borrowers/1/operations')
      .set('Idempotency-Key', '00000000-0000-4000-8000-000000000100')
      .send({
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          {
            itemId: 1,
            borrow: [{ quantity: Number.MAX_SAFE_INTEGER + 1, note: 'x'.repeat(501) }],
            return: [{ usable: 0, damaged: 0, note: '', extra: true }],
          },
          { itemId: 1, borrow: [{ quantity: 1, note: '' }] },
        ],
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body).toMatchObject({ error: 'validation_error' });
        expect(body.fieldErrors.map((error: { field: string }) => error.field)).toContain(
          'items[0].return[0].extra',
        );
      });
    expect(db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual({
      count: 0,
    });

    await agent
      .post('/api/borrowers/999999/operations')
      .set('Idempotency-Key', '00000000-0000-4000-8000-000000000101')
      .send({
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [{ itemId: 1, borrow: [{ quantity: 1, note: '' }] }],
      })
      .expect(404)
      .expect(({ body }) =>
        expect(body).toEqual({ error: 'not_found', message: 'Borrower not found' }),
      );
    expect(db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual({
      count: 0,
    });
  });

  it('rejects unsafe aggregate quantities before domain access', async () => {
    const { db, agent } = fixture();
    await agent
      .post('/api/borrowers/1/operations')
      .set('Idempotency-Key', '00000000-0000-4000-8000-000000000104')
      .send({
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          {
            itemId: 1,
            borrow: [
              { quantity: Number.MAX_SAFE_INTEGER, note: '' },
              { quantity: 1, note: '' },
            ],
            return: [
              { usable: Number.MAX_SAFE_INTEGER, damaged: 1, note: '' },
              { usable: 1, damaged: 0, note: '' },
            ],
          },
        ],
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.error).toBe('validation_error');
        expect(body.fieldErrors.map((error: { message: string }) => error.message)).toEqual(
          expect.arrayContaining([
            'Return part total must be a safe integer',
            'Per-item borrow total must be a safe integer',
            'Per-item return total must be a safe integer',
            'Per-item usable-return total must be a safe integer',
            'Command borrow total must be a safe integer',
            'Command return total must be a safe integer',
            'Command usable-return total must be a safe integer',
          ]),
        );
      });
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_events').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual({
      count: 0,
    });
  });

  it('strictly rejects malformed borrower creation before borrower or receipt insertion', async () => {
    const { db, agent } = fixture();
    await agent
      .post('/api/borrowers')
      .set('Idempotency-Key', 'invalid')
      .send({
        contractVersion: 2,
        ledgerEpoch: 0,
        username: 'x',
        name: '',
        contact: 'x'.repeat(501),
        type: 'invalid',
        extra: true,
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.error).toBe('validation_error');
        expect(body).not.toHaveProperty('idempotencyKey');
        expect(body.fieldErrors.map((error: { field: string }) => error.field)).toEqual([
          'Idempotency-Key',
          'contractVersion',
          'ledgerEpoch',
          'username',
          'name',
          'contact',
          'type',
          'extra',
        ]);
      });
    await agent
      .post('/api/borrowers')
      .send({
        contractVersion: 1,
        ledgerEpoch: 1,
        username: 'valid-name',
        name: 'Valid Name',
        type: 'individual',
      })
      .expect(400);
    expect(db.prepare('SELECT COUNT(*) count FROM borrowers').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual({
      count: 0,
    });
  });

  it.each([
    {
      name: 'empty item list',
      body: { contractVersion: 1, ledgerEpoch: 1, items: [] },
      fieldErrors: [
        {
          field: 'items',
          code: 'too_small',
          message: 'Too small: expected array to have >=1 items',
        },
      ],
    },
    {
      name: 'duplicate item groups',
      body: {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          { itemId: 1, borrow: [{ quantity: 1, note: '' }] },
          { itemId: 1, borrow: [{ quantity: 1, note: '' }] },
        ],
      },
      fieldErrors: [
        {
          field: 'items[1].itemId',
          code: 'custom',
          message: 'Item groups must have unique item IDs',
        },
      ],
    },
    {
      name: 'directionless group',
      body: { contractVersion: 1, ledgerEpoch: 1, items: [{ itemId: 1 }] },
      fieldErrors: [
        {
          field: 'items[0]',
          code: 'custom',
          message: 'An item group must include borrow, return, or lost-credit parts',
        },
      ],
    },
    {
      name: 'empty borrow parts',
      body: { contractVersion: 1, ledgerEpoch: 1, items: [{ itemId: 1, borrow: [] }] },
      fieldErrors: [
        {
          field: 'items[0].borrow',
          code: 'too_small',
          message: 'Too small: expected array to have >=1 items',
        },
      ],
    },
    {
      name: 'empty return parts',
      body: { contractVersion: 1, ledgerEpoch: 1, items: [{ itemId: 1, return: [] }] },
      fieldErrors: [
        {
          field: 'items[0].return',
          code: 'too_small',
          message: 'Too small: expected array to have >=1 items',
        },
      ],
    },
    {
      name: 'zero return',
      body: {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [{ itemId: 1, return: [{ usable: 0, damaged: 0, note: '' }] }],
      },
      fieldErrors: [
        {
          field: 'items[0].return[0]',
          code: 'custom',
          message: 'A return part must return at least one item',
        },
      ],
    },
    {
      name: 'unsafe item id',
      body: {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [{ itemId: Number.MAX_SAFE_INTEGER + 1, borrow: [{ quantity: 1, note: '' }] }],
      },
      fieldErrors: [
        {
          field: 'items[0].itemId',
          code: 'too_big',
          message: 'Too big: expected int to be <=9007199254740991',
        },
      ],
    },
    {
      name: 'unsafe borrow quantity',
      body: {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          {
            itemId: 1,
            borrow: [{ quantity: Number.MAX_SAFE_INTEGER + 1, note: '' }],
          },
        ],
      },
      fieldErrors: [
        {
          field: 'items[0].borrow[0].quantity',
          code: 'too_big',
          message: 'Too big: expected int to be <=9007199254740991',
        },
        {
          field: 'items[0].borrow',
          code: 'custom',
          message: 'Per-item borrow total must be a safe integer',
        },
        {
          field: 'items',
          code: 'custom',
          message: 'Command borrow total must be a safe integer',
        },
      ],
    },
    {
      name: 'negative usable return',
      body: {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [{ itemId: 1, return: [{ usable: -1, damaged: 2, note: '' }] }],
      },
      fieldErrors: [
        {
          field: 'items[0].return[0].usable',
          code: 'too_small',
          message: 'Too small: expected number to be >=0',
        },
      ],
    },
    {
      name: 'negative damaged return',
      body: {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [{ itemId: 1, return: [{ usable: 2, damaged: -1, note: '' }] }],
      },
      fieldErrors: [
        {
          field: 'items[0].return[0].damaged',
          code: 'too_small',
          message: 'Too small: expected number to be >=0',
        },
      ],
    },
    {
      name: 'overlong note',
      body: {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [{ itemId: 1, borrow: [{ quantity: 1, note: 'x'.repeat(501) }] }],
      },
      fieldErrors: [
        {
          field: 'items[0].borrow[0].note',
          code: 'too_big',
          message: 'Too big: expected string to have <=500 characters',
        },
      ],
    },
    {
      name: 'unknown nested field',
      body: {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [{ itemId: 1, borrow: [{ quantity: 1, note: '', extra: true }] }],
      },
      fieldErrors: [
        {
          field: 'items[0].borrow[0].extra',
          code: 'unrecognized_keys',
          message: 'Unrecognized key: "extra"',
        },
      ],
    },
  ])('reports exact isolated operation errors for $name', async ({ body, fieldErrors }) => {
    const { db, agent } = fixture();
    const commit = vi.spyOn(InventoryService.prototype, 'commitBorrowerOperations');
    await agent
      .post('/api/borrowers/1/operations')
      .set('Idempotency-Key', '00000000-0000-4000-8000-000000000108')
      .send(body)
      .expect(400)
      .expect(({ body: responseBody }) => {
        expect(responseBody).toEqual({
          error: 'validation_error',
          message: 'The command transport is invalid',
          fieldErrors,
        });
      });
    expect(commit).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual({
      count: 0,
    });
  });

  it('parses authorized command bodies locally and rejects malformed or oversized JSON without domain access', async () => {
    const create = vi.spyOn(InventoryService.prototype, 'createBorrowerCommand');
    const commit = vi.spyOn(InventoryService.prototype, 'commitBorrowerOperations');
    const getSession = vi.spyOn(SessionStore.prototype, 'get');
    const { db, agent } = fixture();
    const oversized = 'x'.repeat(33 * 1024);

    for (const path of [
      '/api/borrowers',
      '/api/borrowers/',
      '/api/borrowers/1/operations',
      '/api/borrowers/1/operations/',
      '/api/BORROWERS',
      '/api/BORROWERS/1/OPERATIONS',
    ])
      await agent
        .post(path)
        .set('Content-Type', 'application/json')
        .send('{"incomplete"')
        .expect(400)
        .expect({ error: 'invalid_json', message: 'גוף הבקשה אינו JSON תקין או גדול מדי' });

    await agent
      .post('/api/borrowers')
      .send({
        contractVersion: 1,
        ledgerEpoch: 1,
        username: 'oversized-create',
        name: 'Oversized Create',
        contact: oversized,
        type: 'individual',
      })
      .expect(400)
      .expect({ error: 'invalid_json', message: 'גוף הבקשה אינו JSON תקין או גדול מדי' });
    await agent
      .post('/api/borrowers/1/operations')
      .send({
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [{ itemId: 1, borrow: [{ quantity: 1, note: oversized }] }],
      })
      .expect(400)
      .expect({ error: 'invalid_json', message: 'גוף הבקשה אינו JSON תקין או גדול מדי' });

    expect(create).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalledTimes(8);
    expect(db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual({
      count: 0,
    });
  });

  it('rejects unsupported versions before epoch or receipt access for both commands', async () => {
    const { db, inventory, agent } = fixture();
    const borrower = inventory.createBorrower({
      username: 'version-subject',
      name: 'Version Subject',
      type: 'individual',
    });
    const item = inventory.createItem({ name: 'Version item', kind: 'non_consumable' });
    inventory.addStock(item.id, 2);
    const createKey = '00000000-0000-4000-8000-000000000109';
    const operationKey = '00000000-0000-4000-8000-000000000110';
    const createBody = {
      contractVersion: 1,
      ledgerEpoch: 1,
      username: 'version-created',
      name: 'Version Created',
      contact: '',
      type: 'individual',
    };
    const operationBody = {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [{ itemId: item.id, borrow: [{ quantity: 1, note: '' }] }],
    };
    await agent
      .post('/api/borrowers')
      .set('Idempotency-Key', createKey)
      .send(createBody)
      .expect(201);
    await agent
      .post(`/api/borrowers/${borrower.id}/operations`)
      .set('Idempotency-Key', operationKey)
      .send(operationBody)
      .expect(201);
    expect(db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual({
      count: 2,
    });
    const create = vi.spyOn(InventoryService.prototype, 'createBorrowerCommand');
    const commit = vi.spyOn(InventoryService.prototype, 'commitBorrowerOperations');

    const rejectUnsupportedVersions = async () => {
      await agent
        .post('/api/borrowers')
        .set('Idempotency-Key', createKey)
        .send({
          contractVersion: 2,
          ledgerEpoch: 1,
          username: 'changed-version-create',
          name: 'Changed Version Create',
          contact: '',
          type: 'individual',
        })
        .expect(400)
        .expect({
          error: 'validation_error',
          message: 'The command transport is invalid',
          fieldErrors: [
            {
              field: 'contractVersion',
              code: 'invalid_value',
              message: 'Invalid input: expected 1',
            },
          ],
        });
      await agent
        .post(`/api/borrowers/${borrower.id}/operations`)
        .set('Idempotency-Key', operationKey)
        .send({
          contractVersion: 2,
          ledgerEpoch: 1,
          items: [{ itemId: item.id, borrow: [{ quantity: 2, note: '' }] }],
        })
        .expect(400)
        .expect({
          error: 'validation_error',
          message: 'The command transport is invalid',
          fieldErrors: [
            {
              field: 'contractVersion',
              code: 'invalid_value',
              message: 'Invalid input: expected 1',
            },
          ],
        });
    };

    await rejectUnsupportedVersions();
    db.prepare('UPDATE inventory_replacement_guard SET ledger_epoch=2 WHERE singleton=1').run();
    const before = {
      borrowers: db.prepare('SELECT COUNT(*) count FROM borrowers').get(),
      events: db.prepare('SELECT COUNT(*) count FROM inventory_events').get(),
      receipts: db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get(),
    };
    await rejectUnsupportedVersions();

    expect(create).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    await agent
      .post('/api/borrowers')
      .set('Idempotency-Key', createKey)
      .send(createBody)
      .expect(409)
      .expect({
        error: 'ledger_epoch_changed',
        message: 'The inventory ledger has been replaced; refresh before retrying',
        outcome: 'protocol_error',
        idempotencyKey: createKey,
      });
    expect(create).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect({
      borrowers: db.prepare('SELECT COUNT(*) count FROM borrowers').get(),
      events: db.prepare('SELECT COUNT(*) count FROM inventory_events').get(),
      receipts: db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get(),
    }).toEqual(before);
  });

  it('maps command conflicts and protocol errors to receipt-safe 409 responses', async () => {
    const { db, inventory, agent } = fixture();
    const borrower = inventory.createBorrower({
      username: 'conflict-user',
      name: 'Conflict User',
      type: 'individual',
    });
    const item = inventory.createItem({ name: 'Unavailable', kind: 'non_consumable' });
    const operationKey = '00000000-0000-4000-8000-000000000105';
    const operation = {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [{ itemId: item.id, borrow: [{ quantity: 1, note: '' }] }],
    };
    await agent
      .post(`/api/borrowers/${borrower.id}/operations`)
      .set('Idempotency-Key', operationKey)
      .send(operation)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          error: 'borrower_operation_conflict',
          outcome: 'rejected',
          idempotencyKey: operationKey,
        }),
      );

    const createKey = '00000000-0000-4000-8000-000000000106';
    await agent
      .post('/api/borrowers')
      .set('Idempotency-Key', createKey)
      .send({
        contractVersion: 1,
        ledgerEpoch: 1,
        username: borrower.username,
        name: 'Other Name',
        contact: '',
        type: 'other',
      })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          error: 'borrower_conflict',
          outcome: 'rejected',
          idempotencyKey: createKey,
        }),
      );

    const beforeProtocolErrors = {
      borrowers: db.prepare('SELECT COUNT(*) count FROM borrowers').get(),
      events: db.prepare('SELECT COUNT(*) count FROM inventory_events').get(),
      receipts: db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get(),
      receiptRows: db.prepare('SELECT * FROM idempotency_receipts ORDER BY key').all(),
    };
    await agent
      .post(`/api/borrowers/${borrower.id}/operations`)
      .set('Idempotency-Key', operationKey)
      .send({ ...operation, items: [{ itemId: item.id, borrow: [{ quantity: 2, note: '' }] }] })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          error: 'idempotency_key_reused',
          outcome: 'protocol_error',
          idempotencyKey: operationKey,
        }),
      );
    db.prepare('UPDATE inventory_replacement_guard SET ledger_epoch=2 WHERE singleton=1').run();
    await agent
      .post(`/api/borrowers/${borrower.id}/operations`)
      .set('Idempotency-Key', operationKey)
      .send(operation)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toEqual({
          error: 'ledger_epoch_changed',
          message: 'The inventory ledger has been replaced; refresh before retrying',
          outcome: 'protocol_error',
          idempotencyKey: operationKey,
        }),
      );
    const staleKey = '00000000-0000-4000-8000-000000000107';
    await agent
      .post('/api/borrowers')
      .set('Idempotency-Key', staleKey)
      .send({
        contractVersion: 1,
        ledgerEpoch: 1,
        username: 'stale-create',
        name: 'Stale Create',
        contact: '',
        type: 'individual',
      })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toEqual({
          error: 'ledger_epoch_changed',
          message: 'The inventory ledger has been replaced; refresh before retrying',
          outcome: 'protocol_error',
          idempotencyKey: staleKey,
        }),
      );
    expect({
      borrowers: db.prepare('SELECT COUNT(*) count FROM borrowers').get(),
      events: db.prepare('SELECT COUNT(*) count FROM inventory_events').get(),
      receipts: db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get(),
      receiptRows: db.prepare('SELECT * FROM idempotency_receipts ORDER BY key').all(),
    }).toEqual(beforeProtocolErrors);
  });

  it('exposes atomic creation and borrower operation replay envelopes to operators', async () => {
    const { db, inventory, agent } = fixture();
    const createKey = '00000000-0000-4000-8000-000000000102';
    const createBody = {
      contractVersion: 1,
      ledgerEpoch: 1,
      username: 'command-user',
      name: 'Command User',
      contact: '',
      type: 'individual',
    };
    let borrowerId = 0;
    await agent
      .post('/api/borrowers')
      .set('Idempotency-Key', createKey)
      .send(createBody)
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          outcome: 'committed',
          idempotencyKey: createKey,
          replayed: false,
          borrower: { username: 'command-user' },
        });
        borrowerId = body.borrower.id;
      });
    inventory.updateBorrower(borrowerId, {
      username: 'edited-live-user',
      name: 'Edited Live User',
      contact: 'edited',
      type: 'other',
    });
    await agent
      .post('/api/borrowers')
      .set('Idempotency-Key', createKey)
      .send(createBody)
      .expect(201)
      .expect(({ body }) =>
        expect(body).toEqual({
          outcome: 'committed',
          idempotencyKey: createKey,
          replayed: true,
          borrower: {
            id: borrowerId,
            username: 'command-user',
            name: 'Command User',
            contact: '',
            type: 'individual',
            archived: false,
          },
        }),
      );
    expect(
      inventory.listBorrowers('', true).find((candidate) => candidate.id === borrowerId),
    ).toMatchObject({
      username: 'edited-live-user',
      name: 'Edited Live User',
      contact: 'edited',
      type: 'other',
    });
    const creationCounts = {
      borrowers: db.prepare('SELECT COUNT(*) count FROM borrowers').get(),
      receipts: db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get(),
    };
    await agent
      .post('/api/borrowers')
      .set('Idempotency-Key', createKey)
      .send({ ...createBody, contact: 'changed' })
      .expect(409)
      .expect({
        error: 'idempotency_key_reused',
        message: 'The idempotency key was already used for a different command',
        outcome: 'protocol_error',
        idempotencyKey: createKey,
      });
    expect({
      borrowers: db.prepare('SELECT COUNT(*) count FROM borrowers').get(),
      receipts: db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get(),
    }).toEqual(creationCounts);
    expect(
      inventory.listBorrowers('', true).find((candidate) => candidate.id === borrowerId),
    ).toEqual({
      id: borrowerId,
      username: 'edited-live-user',
      name: 'Edited Live User',
      contact: 'edited',
      type: 'other',
      archived: false,
    });

    const item = inventory.createItem({ name: 'Command item', kind: 'non_consumable' });
    inventory.addStock(item.id, 1);
    const operationKey = '00000000-0000-4000-8000-000000000103';
    const operationBody = {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [{ itemId: item.id, borrow: [{ quantity: 1, note: 'route' }] }],
    };
    await agent
      .post(`/api/borrowers/${borrowerId}/operations`)
      .set('Idempotency-Key', operationKey)
      .send(operationBody)
      .expect(201)
      .expect(({ body }) =>
        expect(body).toEqual({
          outcome: 'committed',
          idempotencyKey: operationKey,
          replayed: false,
        }),
      );
    await agent
      .post(`/api/borrowers/${borrowerId}/operations`)
      .set('Idempotency-Key', operationKey)
      .send(operationBody)
      .expect(201)
      .expect({
        outcome: 'committed',
        idempotencyKey: operationKey,
        replayed: true,
      });
    expect(
      db.prepare("SELECT COUNT(*) count FROM inventory_events WHERE kind='checked_out'").get(),
    ).toEqual({
      count: 1,
    });
  });

  it('rejects unauthorized command requests before transport parsing or domain access', async () => {
    const db = openDatabase(':memory:');
    databases.push(db);
    const inventory = new InventoryService(db);
    const commit = vi.spyOn(inventory, 'commitBorrowerOperations');
    const create = vi.spyOn(inventory, 'createBorrowerCommand');
    const app = express();
    app.use((_req, res, next) => {
      res.locals.session = { role: 'unauthorized' };
      next();
    });
    app.use(
      '/api',
      apiRouter(inventory, new InventoryTransferService(db), new SessionStore(db, 'admin-pass')),
    );
    app.use(((error: unknown, _req, res, _next) => {
      void _next;
      if (error instanceof DomainError)
        res.status(error.status).json({ error: error.code, message: error.message });
    }) as express.ErrorRequestHandler);

    for (const path of [
      '/api/borrowers',
      '/api/borrowers/',
      '/api/borrowers/not-an-id/operations',
      '/api/borrowers/not-an-id/operations/',
    ])
      await request(app)
        .post(path)
        .set('Content-Type', 'application/json')
        .send('{"entirely"')
        .expect(403)
        .expect({ error: 'forbidden', message: 'אין הרשאה לפעולה זו' });
    expect(commit).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) count FROM idempotency_receipts').get()).toEqual({
      count: 0,
    });
  });

  it('rejects malformed and oversized legacy JSON before production session resolution', async () => {
    const db = openDatabase(':memory:');
    databases.push(db);
    const getSession = vi.spyOn(SessionStore.prototype, 'get');
    const app = createApp({ database: db, adminPassword: 'admin-pass', serveWeb: false });

    await request(app)
      .post('/api/issue')
      .set('Content-Type', 'application/json')
      .send('{"itemId"')
      .expect(400)
      .expect({ error: 'invalid_json', message: 'גוף הבקשה אינו JSON תקין או גדול מדי' });

    await request(app)
      .post('/api/issue')
      .send({ note: 'x'.repeat(33 * 1024) })
      .expect(400)
      .expect({ error: 'invalid_json', message: 'גוף הבקשה אינו JSON תקין או גדול מדי' });

    await request(app)
      .post('/api/borrowers/1/operations/extra')
      .set('Content-Type', 'application/json')
      .send('{"itemId"')
      .expect(400)
      .expect({ error: 'invalid_json', message: 'גוף הבקשה אינו JSON תקין או גדול מדי' });

    expect(getSession).not.toHaveBeenCalled();
  });

  it('maps malformed encoded command paths to a client error', async () => {
    const db = openDatabase(':memory:');
    databases.push(db);
    const getSession = vi.spyOn(SessionStore.prototype, 'get');
    const app = createApp({ database: db, adminPassword: 'admin-pass', serveWeb: false });

    await request(app)
      .post('/api/borrowers/%ZZ/operations')
      .send({})
      .expect(400)
      .expect({ error: 'invalid_path', message: 'Invalid request path' });

    expect(getSession).toHaveBeenCalledTimes(1);
  });
});
