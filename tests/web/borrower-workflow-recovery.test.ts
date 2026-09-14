import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FrozenAttempt,
  FrozenCreateAttempt,
  FrozenOperationAttempt,
} from '../../src/web/borrower-workflow-recovery.js';
import {
  clearFrozenAttempt,
  dispatchFrozenAttempt,
  enumerateFrozenAttempts,
  frozenAttemptStorageKey,
  initializeFrozenAttemptRecovery,
  isExactBorrowerOperationConflictSet,
  parseFrozenAttempt,
  persistFrozenAttempt,
  resolveFrozenAttempt,
} from '../../src/web/borrower-workflow-recovery.js';

const key1 = '00000000-0000-4000-8000-000000000001';
const key2 = '00000000-0000-4000-8000-000000000002';

function operation(key = key1): FrozenOperationAttempt {
  return {
    version: 1,
    kind: 'operation',
    endpoint: '/borrowers/7/operations',
    subjectId: 7,
    asOfEventId: 3,
    idempotencyKey: key,
    ledgerEpoch: 3,
    intent: 'save',
    body: {
      contractVersion: 1,
      ledgerEpoch: 3,
      items: [{ itemId: 11, borrow: [{ quantity: 2, note: 'ordered' }] }],
    },
  };
}

function creation(key = key2): FrozenCreateAttempt {
  return {
    version: 1,
    kind: 'create',
    endpoint: '/borrowers',
    subjectId: null,
    idempotencyKey: key,
    ledgerEpoch: 3,
    intent: 'create',
    body: {
      contractVersion: 1,
      ledgerEpoch: 3,
      username: 'new',
      name: 'New',
      contact: '',
      type: 'individual',
    },
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

let testStorage = new MemoryStorage();
const storage = (): Storage => testStorage;

beforeEach(() => {
  testStorage = new MemoryStorage();
});

describe('frozen attempt validation and storage', () => {
  it('validates and mirrors a frozen lost-credit conflict exactly', () => {
    const attempt = operation();
    attempt.body.items = [{ itemId: 11, lostCredit: [{ quantity: 2, note: 'recover' }] }];
    expect(parseFrozenAttempt(attempt)).toEqual(attempt);
    const snapshot = {
      borrower: {
        id: 7,
        username: 'or',
        name: 'Or',
        contact: '',
        type: 'individual' as const,
        archived: false,
      },
      inventory: [
        {
          id: 11,
          code: 101,
          name: 'Tent',
          kind: 'non_consumable' as const,
          lotSize: null,
          locationId: null,
          archived: false,
          aliases: [],
          available: 0,
          damaged: 0,
          selectable: true,
        },
      ],
      holdings: [{ itemId: 11, returnable: 0, lost: 1 }],
      asOfEventId: 4,
      ledgerEpoch: 3,
    };
    expect(
      isExactBorrowerOperationConflictSet(
        [
          {
            scope: 'lost-credit',
            code: 'lost_balance_changed',
            itemId: 11,
            requested: 2,
            lost: 1,
          },
        ],
        7,
        attempt.body,
        snapshot,
      ),
    ).toBe(true);
  });

  it('validates complete self-routing envelopes and rejects inconsistent bodies', () => {
    expect(parseFrozenAttempt(operation())).toEqual(operation());
    expect(parseFrozenAttempt(creation())).toEqual(creation());
    const invalid = [
      { ...operation(), version: 2 },
      { ...operation(), endpoint: '/borrowers/8/operations' },
      { ...operation(), asOfEventId: -1 },
      { ...operation(), ledgerEpoch: 4 },
      { ...operation(), body: { ...operation().body, ledgerEpoch: 2 } },
      {
        ...operation(),
        body: {
          ...operation().body,
          items: [
            { itemId: 11, borrow: [{ quantity: 1, note: '' }] },
            { itemId: 11, return: [{ usable: 1, damaged: 0, note: '' }] },
          ],
        },
      },
      { ...creation(), subjectId: 1 },
      { ...creation(), asOfEventId: undefined },
      { ...creation(), body: { ...creation().body, username: ' x ' } },
    ];
    for (const candidate of invalid) expect(parseFrozenAttempt(candidate)).toBeNull();
  });

  it('mirrors strict server UUID, note, key, and safe-aggregate invariants', () => {
    const huge = Number.MAX_SAFE_INTEGER;
    const invalid = [
      { ...operation(), idempotencyKey: '00000000-0000-0000-8000-000000000001' },
      { ...operation(), extra: true },
      {
        ...operation(),
        body: { ...operation().body, extra: true },
      },
      {
        ...operation(),
        body: {
          ...operation().body,
          items: [{ itemId: 11, borrow: [{ quantity: 1, note: 'x'.repeat(501) }] }],
        },
      },
      {
        ...operation(),
        body: {
          ...operation().body,
          items: [
            {
              itemId: 11,
              borrow: [
                { quantity: huge, note: '' },
                { quantity: 1, note: '' },
              ],
            },
          ],
        },
      },
      { ...creation(), body: { ...creation().body, extra: true } },
      { ...creation(), body: { ...creation().body, contact: ' x ' } },
    ];
    for (const candidate of invalid) expect(parseFrozenAttempt(candidate)).toBeNull();
  });

  it('verifies writes, rejects collisions, and detects silent writes', () => {
    expect(persistFrozenAttempt(storage(), operation())).toEqual({ ok: true });
    expect(
      persistFrozenAttempt(storage(), { ...operation(), intent: 'save-and-close' }),
    ).toMatchObject({ ok: false });
    const silent = {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(persistFrozenAttempt(silent, operation())).toMatchObject({
      ok: false,
      failure: { operation: 'write' },
    });
  });

  it('removes only an exact match and detects silent removal', () => {
    persistFrozenAttempt(storage(), operation());
    expect(
      clearFrozenAttempt(storage(), { ...operation(), intent: 'save-and-close' }),
    ).toMatchObject({ ok: false });
    const silentRemove = {
      length: storage().length,
      key: storage().key.bind(storage()),
      getItem: storage().getItem.bind(storage()),
      setItem: storage().setItem.bind(storage()),
      removeItem: () => undefined,
    };
    expect(clearFrozenAttempt(silentRemove, operation())).toMatchObject({
      ok: false,
      failure: { operation: 'remove' },
    });
    expect(storage().getItem(frozenAttemptStorageKey(operation()))).not.toBeNull();
    storage().removeItem(frozenAttemptStorageKey(operation()));
    expect(clearFrozenAttempt(storage(), operation())).toEqual({ ok: true });
  });

  it('enumerates deterministically, preserves invalid records, and continues after per-record reads fail', () => {
    storage().setItem(frozenAttemptStorageKey(creation()), JSON.stringify(creation()));
    storage().setItem(frozenAttemptStorageKey(operation()), JSON.stringify(operation()));
    storage().setItem('mapatz:frozen-attempt:v1:bad', '{');
    const base = storage();
    const throwingRead = {
      length: base.length,
      key: base.key.bind(base),
      setItem: base.setItem.bind(base),
      removeItem: base.removeItem.bind(base),
      getItem(key: string) {
        if (key.endsWith('000000000002')) throw new Error('blocked');
        return base.getItem(key);
      },
    };
    const result = enumerateFrozenAttempts(throwingRead);
    expect(result.valid.map((entry) => entry.idempotencyKey)).toEqual([key1]);
    expect(result.invalidKeys).toEqual(['mapatz:frozen-attempt:v1:bad']);
    expect(result.failures).toHaveLength(1);
    expect(base.getItem('mapatz:frozen-attempt:v1:bad')).toBe('{');
  });

  it('fails closed when enumeration throws', () => {
    const storage = {
      get length(): number {
        throw new Error('denied');
      },
      key: () => null,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(enumerateFrozenAttempts(storage)).toMatchObject({
      valid: [],
      failures: [{ operation: 'enumerate' }],
    });
  });
});

describe('frozen dispatch and recovery', () => {
  it('persists before fetch, sends the exact envelope, and clears a definitive result', async () => {
    const seen: FrozenAttempt[] = [];
    const result = await dispatchFrozenAttempt(storage(), operation(), async (attempt) => {
      expect(storage().getItem(frozenAttemptStorageKey(attempt))).toBe(JSON.stringify(attempt));
      seen.push(attempt);
      return {
        kind: 'definitive',
        status: 201,
        result: { outcome: 'committed', idempotencyKey: key1, replayed: false },
      };
    });
    expect(seen).toEqual([operation()]);
    expect(result).toMatchObject({ kind: 'definitive', cleared: true });
    expect(storage().length).toBe(0);
  });

  it('owns and freezes the exact bytes handed to transport', async () => {
    const callerAttempt = operation();
    const result = await dispatchFrozenAttempt(storage(), callerAttempt, async (attempt) => {
      callerAttempt.body.items[0]!.borrow![0]!.quantity = 99;
      expect(attempt.body.items[0]!.borrow![0]!.quantity).toBe(2);
      expect(Object.isFrozen(attempt)).toBe(true);
      expect(Object.isFrozen(attempt.body.items[0]!.borrow![0])).toBe(true);
      expect(storage().getItem(frozenAttemptStorageKey(attempt))).toBe(JSON.stringify(attempt));
      return {
        kind: 'definitive',
        status: 201,
        result: { outcome: 'committed', idempotencyKey: key1, replayed: false },
      };
    });
    expect(result).toMatchObject({ kind: 'definitive', cleared: true });
  });

  it('does not dispatch after silent persistence failure', async () => {
    const transport = vi.fn();
    const storage = {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const result = await dispatchFrozenAttempt(storage, operation(), transport);
    expect(result).toMatchObject({ kind: 'storage-failure', cleared: false });
    expect(transport).not.toHaveBeenCalled();
  });

  it('preserves exact attempts for network, 5xx ambiguity, and recovery authorization', async () => {
    for (const outcome of [
      { kind: 'ambiguous' as const, reason: 'network' as const },
      { kind: 'ambiguous' as const, reason: 'server' as const, status: 500 },
    ]) {
      storage().clear();
      const result = await dispatchFrozenAttempt(storage(), operation(), async () => outcome);
      expect(result).toMatchObject({ kind: 'ambiguous', cleared: false });
      expect(storage().getItem(frozenAttemptStorageKey(operation()))).toBe(
        JSON.stringify(operation()),
      );
    }
    const auth = await resolveFrozenAttempt(storage(), operation(), async () => ({
      kind: 'authorization',
      status: 401,
    }));
    expect(auth).toMatchObject({ kind: 'authorization', cleared: false });
    expect(storage().getItem(frozenAttemptStorageKey(operation()))).not.toBeNull();
  });

  it('clears first-dispatch authorization but blocks on silent clear failure', async () => {
    const result = await dispatchFrozenAttempt(storage(), operation(), async () => ({
      kind: 'authorization',
      status: 403,
    }));
    expect(result).toMatchObject({ kind: 'authorization', cleared: true });

    persistFrozenAttempt(storage(), operation());
    const silentRemove = {
      length: storage().length,
      key: storage().key.bind(storage()),
      getItem: storage().getItem.bind(storage()),
      setItem: storage().setItem.bind(storage()),
      removeItem: () => undefined,
    };
    const blocked = await resolveFrozenAttempt(silentRemove, operation(), async () => ({
      kind: 'definitive',
      status: 201,
      result: { outcome: 'committed', idempotencyKey: key1, replayed: true },
    }));
    expect(blocked).toMatchObject({
      kind: 'storage-failure',
      cleared: false,
      failure: { operation: 'remove' },
    });
  });

  it('resolves all readable valid startup records and remains fail closed for invalid records', async () => {
    persistFrozenAttempt(storage(), operation());
    persistFrozenAttempt(storage(), creation());
    storage().setItem('mapatz:frozen-attempt:v1:unsupported', JSON.stringify({ version: 2 }));
    const resolved: string[] = [];
    const initialized = await initializeFrozenAttemptRecovery(storage(), async (attempt) => {
      resolved.push(attempt.idempotencyKey);
      return attempt.kind === 'operation'
        ? {
            kind: 'definitive',
            status: 201,
            result: {
              outcome: 'committed',
              idempotencyKey: attempt.idempotencyKey,
              replayed: true,
            },
          }
        : {
            kind: 'definitive',
            status: 201,
            result: {
              outcome: 'committed',
              idempotencyKey: attempt.idempotencyKey,
              replayed: true,
              borrower: {
                id: 2,
                username: 'new',
                name: 'New',
                contact: '',
                type: 'individual',
                archived: false,
              },
            },
          };
    });
    expect(resolved).toEqual([key1, key2]);
    expect(initialized.ready).toBe(false);
    expect(initialized.invalidKeys).toEqual(['mapatz:frozen-attempt:v1:unsupported']);
    expect(storage().getItem('mapatz:frozen-attempt:v1:unsupported')).not.toBeNull();
  });

  it('reports startup readiness only after every valid attempt is definitively resolved', async () => {
    expect(await initializeFrozenAttemptRecovery(storage(), vi.fn())).toMatchObject({
      ready: true,
      results: [],
    });

    persistFrozenAttempt(storage(), operation());
    const ambiguous = await initializeFrozenAttemptRecovery(storage(), async () => ({
      kind: 'ambiguous',
      reason: 'network',
    }));
    expect(ambiguous.ready).toBe(false);
    expect(ambiguous.results[0]).toMatchObject({ kind: 'ambiguous', cleared: false });

    const authorization = await initializeFrozenAttemptRecovery(storage(), async () => ({
      kind: 'authorization',
      status: 403,
    }));
    expect(authorization.ready).toBe(false);
    expect(authorization.results[0]).toMatchObject({ kind: 'authorization', cleared: false });
  });

  it('re-enumerates after awaited recovery and resolves records added during transport', async () => {
    persistFrozenAttempt(storage(), operation());
    const seen: string[] = [];
    const initialized = await initializeFrozenAttemptRecovery(storage(), async (attempt) => {
      seen.push(attempt.idempotencyKey);
      if (attempt.kind === 'operation') persistFrozenAttempt(storage(), creation());
      return attempt.kind === 'operation'
        ? {
            kind: 'definitive',
            status: 201,
            result: {
              outcome: 'committed',
              idempotencyKey: attempt.idempotencyKey,
              replayed: true,
            },
          }
        : {
            kind: 'definitive',
            status: 201,
            result: {
              outcome: 'committed',
              idempotencyKey: attempt.idempotencyKey,
              replayed: true,
              borrower: {
                id: 2,
                username: 'new',
                name: 'New',
                contact: '',
                type: 'individual',
                archived: false,
              },
            },
          };
    });
    expect(seen).toEqual([key1, key2]);
    expect(initialized.ready).toBe(true);
  });

  it('validates direct recovery input and preserves wrong-kind definitive outcomes', async () => {
    const malformed = { ...operation(), endpoint: '/borrowers/8/operations' };
    storage().setItem(frozenAttemptStorageKey(malformed), JSON.stringify(malformed));
    const transport = vi.fn();
    const rejected = await resolveFrozenAttempt(
      storage(),
      malformed as FrozenOperationAttempt,
      transport,
    );
    expect(rejected).toMatchObject({ kind: 'storage-failure', cleared: false });
    expect(transport).not.toHaveBeenCalled();

    storage().clear();
    persistFrozenAttempt(storage(), operation());
    const wrongKind = await resolveFrozenAttempt(storage(), operation(), async () => ({
      kind: 'definitive',
      status: 201,
      result: {
        outcome: 'committed',
        idempotencyKey: key1,
        replayed: true,
        borrower: {
          id: 2,
          username: 'new',
          name: 'New',
          contact: '',
          type: 'individual',
          archived: false,
        },
      },
    }));
    expect(wrongKind).toMatchObject({ kind: 'ambiguous', cleared: false });
    expect(storage().getItem(frozenAttemptStorageKey(operation()))).not.toBeNull();

    storage().clear();
    persistFrozenAttempt(storage(), creation());
    const reverseWrongKind = await resolveFrozenAttempt(
      storage(),
      creation(),
      async () =>
        ({
          kind: 'definitive',
          status: 201,
          result: { outcome: 'committed', idempotencyKey: key2, replayed: true },
        }) as never,
    );
    expect(reverseWrongKind).toMatchObject({ kind: 'ambiguous', cleared: false });

    const wrongStatus = await resolveFrozenAttempt(storage(), creation(), async () => ({
      kind: 'definitive',
      status: 409,
      result: {
        outcome: 'committed',
        idempotencyKey: key2,
        replayed: true,
        borrower: {
          id: 2,
          username: 'new',
          name: 'New',
          contact: '',
          type: 'individual',
          archived: false,
        },
      },
    }));
    expect(wrongStatus).toMatchObject({ kind: 'ambiguous', cleared: false });
  });

  it('revalidates exact same-kind result attribution before clearing', async () => {
    const operationSnapshot = {
      borrower: {
        id: 7,
        username: 'or',
        name: 'Or',
        contact: '',
        type: 'individual' as const,
        archived: false,
      },
      inventory: [
        {
          id: 11,
          code: 101,
          name: 'Tent',
          kind: 'non_consumable' as const,
          lotSize: null,
          locationId: null,
          archived: false,
          aliases: [],
          available: 0,
          damaged: 0,
          selectable: true,
        },
      ],
      holdings: [],
      asOfEventId: 4,
      ledgerEpoch: 3,
    };
    const contradictoryOperationResults = [
      {
        outcome: 'committed',
        idempotencyKey: key1,
        replayed: true,
        extra: true,
      },
      {
        error: 'borrower_operation_conflict',
        message: 'stock',
        outcome: 'rejected',
        idempotencyKey: key1,
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
        snapshot: operationSnapshot,
      },
      {
        error: 'borrower_operation_conflict',
        message: 'stale',
        outcome: 'rejected',
        idempotencyKey: key1,
        replayed: false,
        conflicts: [
          {
            scope: 'borrow',
            code: 'insufficient_stock',
            itemId: 11,
            requested: 2,
            availableAfterUsableReturns: 0,
          },
        ],
        snapshot: { ...operationSnapshot, asOfEventId: 2 },
      },
    ];
    for (const result of contradictoryOperationResults) {
      storage().clear();
      persistFrozenAttempt(storage(), operation());
      const resolved = await resolveFrozenAttempt(
        storage(),
        operation(),
        async () =>
          ({
            kind: 'definitive',
            status: result.outcome === 'committed' ? 201 : 409,
            result,
          }) as never,
      );
      expect(resolved).toMatchObject({ kind: 'ambiguous', cleared: false });
      expect(storage().getItem(frozenAttemptStorageKey(operation()))).not.toBeNull();
    }

    const multiItemAttempt: FrozenOperationAttempt = {
      ...operation(),
      body: {
        ...operation().body,
        items: [...operation().body.items, { itemId: 12, borrow: [{ quantity: 2, note: '' }] }],
      },
    };
    const incompleteSnapshot = {
      ...operationSnapshot,
      inventory: [
        ...operationSnapshot.inventory,
        { ...operationSnapshot.inventory[0]!, id: 12, code: 102 },
      ],
    };
    storage().clear();
    persistFrozenAttempt(storage(), multiItemAttempt);
    const incomplete = await resolveFrozenAttempt(storage(), multiItemAttempt, async () => ({
      kind: 'definitive',
      status: 409,
      result: {
        error: 'borrower_operation_conflict',
        message: 'incomplete',
        outcome: 'rejected',
        idempotencyKey: key1,
        replayed: false,
        conflicts: [
          {
            scope: 'borrow',
            code: 'insufficient_stock',
            itemId: 11,
            requested: 2,
            availableAfterUsableReturns: 0,
          },
        ],
        snapshot: incompleteSnapshot,
      },
    }));
    expect(incomplete).toMatchObject({ kind: 'ambiguous', cleared: false });
    expect(storage().getItem(frozenAttemptStorageKey(multiItemAttempt))).not.toBeNull();

    const contradictoryCreateResults = [
      {
        outcome: 'committed',
        idempotencyKey: key2,
        replayed: true,
        borrower: {
          id: 0,
          username: 'new',
          name: 'New',
          contact: '',
          type: 'individual',
          archived: false,
        },
      },
      {
        error: 'borrower_conflict',
        message: 'match',
        outcome: 'rejected',
        idempotencyKey: key2,
        replayed: false,
        fieldErrors: [],
        matches: [],
      },
    ];
    for (const result of contradictoryCreateResults) {
      storage().clear();
      persistFrozenAttempt(storage(), creation());
      const resolved = await resolveFrozenAttempt(
        storage(),
        creation(),
        async () =>
          ({
            kind: 'definitive',
            status: result.outcome === 'committed' ? 201 : 409,
            result,
          }) as never,
      );
      expect(resolved).toMatchObject({ kind: 'ambiguous', cleared: false });
      expect(storage().getItem(frozenAttemptStorageKey(creation()))).not.toBeNull();
    }
  });
});
