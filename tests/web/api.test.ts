import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BorrowerCreateRequest,
  BorrowerDeskSnapshot,
  BorrowerOperationRequest,
} from '../../src/contracts/borrower-workflow.js';
import {
  api,
  ApiError,
  classifyBorrowerCreateResponse,
  classifyBorrowerOperationResponse,
  sendClassifiedCommand,
} from '../../src/web/api.js';

const key = '00000000-0000-4000-8000-000000000001';
const operationRequest: BorrowerOperationRequest = {
  contractVersion: 1,
  ledgerEpoch: 3,
  items: [{ itemId: 11, borrow: [{ quantity: 1, note: '' }] }],
};
const operationContext = {
  idempotencyKey: key,
  borrowerId: 7,
  request: operationRequest,
  asOfEventId: 3,
};

const createRequest: BorrowerCreateRequest = {
  contractVersion: 1,
  ledgerEpoch: 3,
  username: 'new',
  name: 'New Name',
  contact: '',
  type: 'individual',
};

function snapshot(borrowerId = 7): BorrowerDeskSnapshot {
  return {
    borrower: {
      id: borrowerId,
      username: 'or',
      name: 'Or',
      contact: '',
      type: 'individual',
      archived: false,
    },
    inventory: [
      {
        id: 11,
        code: 101,
        name: 'Tent',
        kind: 'non_consumable',
        lotSize: null,
        locationId: null,
        archived: false,
        aliases: [],
        available: 4,
        damaged: 0,
        selectable: true,
      },
    ],
    holdings: [{ itemId: 11, returnable: 1, lost: 0 }],
    asOfEventId: 4,
    ledgerEpoch: 3,
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('command response classification', () => {
  it('classifies network, 5xx, unparseable, and invalid bodies as ambiguous', async () => {
    expect(
      await classifyBorrowerOperationResponse(new Response('oops', { status: 500 }), {
        idempotencyKey: key,
        borrowerId: 7,
        request: operationRequest,
        asOfEventId: 3,
      }),
    ).toMatchObject({ kind: 'ambiguous', reason: 'server' });
    expect(
      await classifyBorrowerOperationResponse(new Response('oops', { status: 409 }), {
        idempotencyKey: key,
        borrowerId: 7,
        request: operationRequest,
        asOfEventId: 3,
      }),
    ).toMatchObject({ kind: 'ambiguous', reason: 'unparseable' });
    expect(
      await classifyBorrowerOperationResponse(
        json(201, { outcome: 'committed', idempotencyKey: 'wrong', replayed: false }),
        operationContext,
      ),
    ).toMatchObject({ kind: 'ambiguous', reason: 'invalid-body' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(
      await sendClassifiedCommand('/borrowers/7/operations', { method: 'POST' }, (response) =>
        classifyBorrowerOperationResponse(response, {
          idempotencyKey: key,
          borrowerId: 7,
          request: operationRequest,
          asOfEventId: 3,
        }),
      ),
    ).toEqual({ kind: 'ambiguous', reason: 'network' });
  });

  it('accepts coherent committed and typed protocol responses', async () => {
    expect(
      await classifyBorrowerOperationResponse(
        json(201, { outcome: 'committed', idempotencyKey: key, replayed: false }),
        operationContext,
      ),
    ).toMatchObject({ kind: 'definitive', result: { outcome: 'committed' } });
    expect(
      await classifyBorrowerOperationResponse(
        json(400, { error: 'validation_error', message: 'invalid', fieldErrors: [] }),
        operationContext,
      ),
    ).toMatchObject({ kind: 'definitive', result: { error: 'validation_error' } });
    expect(
      await classifyBorrowerOperationResponse(
        json(400, {
          error: 'validation_error',
          message: 'invalid',
          fieldErrors: [],
          idempotencyKey: '00000000-0000-4000-8000-000000000099',
        }),
        operationContext,
      ),
    ).toMatchObject({ kind: 'ambiguous' });
    expect(
      await classifyBorrowerOperationResponse(
        json(409, {
          error: 'ledger_epoch_changed',
          message: 'changed',
          outcome: 'protocol_error',
          idempotencyKey: key,
        }),
        operationContext,
      ),
    ).toMatchObject({ kind: 'definitive', result: { error: 'ledger_epoch_changed' } });
    expect(
      await classifyBorrowerOperationResponse(json(401, { error: 'wrong_password' }), {
        idempotencyKey: key,
        borrowerId: 7,
        request: operationRequest,
        asOfEventId: 3,
      }),
    ).toEqual({ kind: 'authorization', status: 401 });
  });

  it('rejects cross-borrower, duplicate, cross-request, and contradictory operation results', async () => {
    const base = {
      error: 'borrower_operation_conflict',
      message: 'changed',
      outcome: 'rejected',
      idempotencyKey: key,
      replayed: false,
      conflicts: [],
      snapshot: {
        ...snapshot(),
        inventory: [{ ...snapshot().inventory[0]!, available: 0 }],
      },
    };
    for (const body of [
      { ...base, snapshot: snapshot(8) },
      {
        ...base,
        snapshot: { ...snapshot(), holdings: [...snapshot().holdings, snapshot().holdings[0]!] },
      },
      { ...base, idempotencyKey: '00000000-0000-4000-8000-000000000002' },
      { outcome: 'committed', error: 4, idempotencyKey: key, replayed: false },
    ]) {
      expect(
        await classifyBorrowerOperationResponse(json(409, body), {
          idempotencyKey: key,
          borrowerId: 7,
          request: operationRequest,
          asOfEventId: 3,
        }),
      ).toMatchObject({ kind: 'ambiguous' });
    }
    expect(
      await classifyBorrowerOperationResponse(
        json(409, { outcome: 'committed', idempotencyKey: key, replayed: false }),
        operationContext,
      ),
    ).toMatchObject({ kind: 'ambiguous' });
  });

  it('accepts attributable operation rejections and rejects unrelated or loose payloads', async () => {
    const conflict = {
      scope: 'borrow' as const,
      code: 'insufficient_stock' as const,
      itemId: 11,
      requested: 1,
      availableAfterUsableReturns: 0,
    };
    const first = {
      error: 'borrower_operation_conflict',
      message: 'changed',
      outcome: 'rejected',
      idempotencyKey: key,
      replayed: false,
      conflicts: [conflict],
      snapshot: {
        ...snapshot(),
        inventory: [{ ...snapshot().inventory[0]!, available: 0 }],
      },
    };
    expect(
      await classifyBorrowerOperationResponse(json(409, first), {
        idempotencyKey: key,
        borrowerId: 7,
        request: operationRequest,
        asOfEventId: 3,
      }),
    ).toMatchObject({ kind: 'definitive' });
    expect(
      await classifyBorrowerOperationResponse(json(409, first), {
        ...operationContext,
        asOfEventId: 5,
      }),
    ).toMatchObject({ kind: 'ambiguous' });
    expect(
      await classifyBorrowerOperationResponse(
        json(409, { ...first, conflicts: [{ ...conflict, requested: 2 }] }),
        operationContext,
      ),
    ).toMatchObject({ kind: 'ambiguous' });
    expect(
      await classifyBorrowerOperationResponse(json(409, { ...first, extra: true }), {
        idempotencyKey: key,
        borrowerId: 7,
        request: operationRequest,
        asOfEventId: 3,
      }),
    ).toMatchObject({ kind: 'ambiguous' });

    const replay = {
      error: 'borrower_operation_attempt_rejected',
      message: 'now valid',
      outcome: 'rejected',
      idempotencyKey: key,
      replayed: true,
      currentValidation: { status: 'now_valid', conflicts: [], snapshot: snapshot() },
    };
    expect(
      await classifyBorrowerOperationResponse(json(409, replay), {
        idempotencyKey: key,
        borrowerId: 7,
        request: operationRequest,
        asOfEventId: 3,
      }),
    ).toMatchObject({ kind: 'definitive' });
    expect(
      await classifyBorrowerOperationResponse(json(409, replay), {
        ...operationContext,
        asOfEventId: 5,
      }),
    ).toMatchObject({ kind: 'ambiguous' });
  });

  it('requires the complete deterministic operation conflict sequence', async () => {
    const request: BorrowerOperationRequest = {
      contractVersion: 1,
      ledgerEpoch: 3,
      items: [
        {
          itemId: 11,
          borrow: [{ quantity: 5, note: '' }],
          return: [{ usable: 2, damaged: 0, note: '' }],
        },
        { itemId: 12, borrow: [{ quantity: 2, note: '' }] },
      ],
    };
    const conflictSnapshot = {
      ...snapshot(),
      inventory: [
        { ...snapshot().inventory[0]!, available: 0 },
        { ...snapshot().inventory[0]!, id: 12, code: 102, available: 0 },
      ],
    };
    const base = {
      error: 'borrower_operation_conflict',
      message: 'changed',
      outcome: 'rejected',
      idempotencyKey: key,
      replayed: false,
      snapshot: conflictSnapshot,
    };
    const returnConflict = {
      scope: 'return',
      code: 'returnable_balance_changed',
      itemId: 11,
      requested: 2,
      returnable: 1,
    };
    const secondBorrowConflict = {
      scope: 'borrow',
      code: 'insufficient_stock',
      itemId: 12,
      requested: 2,
      availableAfterUsableReturns: 0,
    };
    const context = { idempotencyKey: key, borrowerId: 7, request, asOfEventId: 3 };
    expect(
      await classifyBorrowerOperationResponse(
        json(409, { ...base, conflicts: [returnConflict, secondBorrowConflict] }),
        context,
      ),
    ).toMatchObject({ kind: 'definitive' });
    for (const conflicts of [
      [returnConflict],
      [
        returnConflict,
        {
          scope: 'borrow',
          code: 'insufficient_stock',
          itemId: 11,
          requested: 5,
          availableAfterUsableReturns: 2,
        },
        secondBorrowConflict,
      ],
      [secondBorrowConflict, returnConflict],
    ])
      expect(
        await classifyBorrowerOperationResponse(json(409, { ...base, conflicts }), context),
      ).toMatchObject({ kind: 'ambiguous' });
  });

  it('binds creation commits to the normalized frozen body', async () => {
    const borrower = {
      id: 22,
      username: 'new',
      name: 'New Name',
      contact: '',
      type: 'individual',
      archived: false,
    };
    expect(
      await classifyBorrowerCreateResponse(
        json(201, { outcome: 'committed', idempotencyKey: key, replayed: false, borrower }),
        { idempotencyKey: key, request: createRequest },
      ),
    ).toMatchObject({ kind: 'definitive' });
    expect(
      await classifyBorrowerCreateResponse(
        json(201, { outcome: 'committed', idempotencyKey: key, replayed: false, borrower }),
        { idempotencyKey: key, request: { ...createRequest, username: ' new ' } },
      ),
    ).toMatchObject({ kind: 'ambiguous' });
    for (const contradictory of [
      { ...borrower, username: 'another' },
      { ...borrower, type: 'other' },
      { ...borrower, archived: true },
    ]) {
      expect(
        await classifyBorrowerCreateResponse(
          json(201, {
            outcome: 'committed',
            idempotencyKey: key,
            replayed: false,
            borrower: contradictory,
          }),
          { idempotencyKey: key, request: createRequest },
        ),
      ).toMatchObject({ kind: 'ambiguous' });
    }
  });

  it('rejects creation match status contradictory to archival state', async () => {
    const borrower = {
      id: 22,
      username: 'old',
      name: 'Old',
      contact: '',
      type: 'individual',
      archived: false,
    };
    const conflict = {
      error: 'borrower_conflict',
      message: 'match',
      outcome: 'rejected',
      idempotencyKey: key,
      replayed: false,
      fieldErrors: [
        {
          field: 'username',
          code: 'username_conflict',
          message: 'Username matches an existing borrower',
        },
        {
          field: 'name',
          code: 'full_name_conflict',
          message: 'Name matches an existing borrower',
        },
      ],
      matches: [{ borrower, status: 'archived', matchedBy: 'username' }],
    };
    expect(
      await classifyBorrowerCreateResponse(json(409, conflict), {
        idempotencyKey: key,
        request: createRequest,
      }),
    ).toMatchObject({ kind: 'ambiguous', reason: 'invalid-body' });
  });

  it('accepts truthful creation conflicts and rejects false match discriminators', async () => {
    const borrower = {
      id: 22,
      username: 'new',
      name: 'New Name',
      contact: '',
      type: 'individual' as const,
      archived: false,
    };
    const conflict = {
      error: 'borrower_conflict',
      message: 'match',
      outcome: 'rejected',
      idempotencyKey: key,
      replayed: false,
      fieldErrors: [
        {
          field: 'username',
          code: 'username_conflict',
          message: 'Username matches an existing borrower',
        },
        {
          field: 'name',
          code: 'full_name_conflict',
          message: 'Name matches an existing borrower',
        },
      ],
      matches: [{ borrower, status: 'active', matchedBy: 'username' }],
    };
    expect(
      await classifyBorrowerCreateResponse(json(409, conflict), {
        idempotencyKey: key,
        request: createRequest,
      }),
    ).toMatchObject({ kind: 'definitive' });
    expect(
      await classifyBorrowerCreateResponse(
        json(409, {
          ...conflict,
          matches: [
            {
              borrower: { ...borrower, username: 'other' },
              status: 'active',
              matchedBy: 'username',
            },
          ],
        }),
        { idempotencyKey: key, request: createRequest },
      ),
    ).toMatchObject({ kind: 'ambiguous' });
    expect(
      await classifyBorrowerCreateResponse(
        json(409, { ...conflict, fieldErrors: [], matches: [] }),
        { idempotencyKey: key, request: createRequest },
      ),
    ).toMatchObject({ kind: 'ambiguous' });
  });

  it('enforces exact status/body mapping, semantic conflicts, and HeadersInit preservation', async () => {
    const snapshotWithNoStock = {
      ...snapshot(),
      inventory: [{ ...snapshot().inventory[0]!, available: 0 }],
    };
    const rejection = {
      error: 'borrower_operation_conflict',
      message: 'stock',
      outcome: 'rejected',
      idempotencyKey: key,
      replayed: false,
      conflicts: [
        {
          scope: 'borrow',
          code: 'insufficient_stock',
          itemId: 11,
          requested: 1,
          availableAfterUsableReturns: 0,
        },
      ],
      snapshot: snapshotWithNoStock,
    };
    expect(
      await classifyBorrowerOperationResponse(json(400, rejection), {
        idempotencyKey: key,
        borrowerId: 7,
        request: operationRequest,
        asOfEventId: 3,
      }),
    ).toMatchObject({ kind: 'ambiguous' });
    expect(
      await classifyBorrowerOperationResponse(
        json(400, {
          error: 'validation_error',
          message: 'bad',
          fieldErrors: [],
          idempotencyKey: key,
        }),
        operationContext,
      ),
    ).toMatchObject({ kind: 'ambiguous' });
    expect(
      await classifyBorrowerOperationResponse(
        json(409, { ...rejection, conflicts: [...rejection.conflicts, ...rejection.conflicts] }),
        operationContext,
      ),
    ).toMatchObject({ kind: 'ambiguous' });

    const fetchMock = vi.fn().mockResolvedValue(json(201, {}));
    vi.stubGlobal('fetch', fetchMock);
    const headers = new Headers([['x-attempt', key]]);
    await sendClassifiedCommand('/borrowers', { method: 'POST', headers }, async () => ({
      kind: 'ambiguous',
      reason: 'invalid-body',
    }));
    const sentHeaders = fetchMock.mock.calls[0]![1]!.headers as Headers;
    expect(sentHeaders.get('x-attempt')).toBe(key);
    expect(sentHeaders.get('content-type')).toBe('application/json');
  });
});

describe('generic api compatibility', () => {
  it('preserves successful generic JSON behavior and ApiError behavior', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json(200, { ok: true }))
        .mockResolvedValueOnce(json(400, { error: 'bad', message: 'Bad request' })),
    );
    expect(await api<{ ok: boolean }>('/ok')).toEqual({ ok: true });
    const error = await api('/bad').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: 'bad' });
  });
});
