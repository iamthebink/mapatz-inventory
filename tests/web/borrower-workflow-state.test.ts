import { describe, expect, it } from 'vitest';
import type { BorrowerDeskSnapshot } from '../../src/contracts/borrower-workflow.js';
import {
  canSave,
  createCreationState,
  createOperationState,
  creationLocks,
  creationReducer,
  isBorrowerDeskSnapshot,
  operationLocks,
  operationPresentation,
  operationReducer,
  operationRequest,
  projectItem,
  projectedItems,
} from '../../src/web/borrower-workflow-state.js';

const key1 = '00000000-0000-4000-8000-000000000001';
const key2 = '00000000-0000-4000-8000-000000000002';
const key3 = '00000000-0000-4000-8000-000000000003';

function snapshot(overrides: Partial<BorrowerDeskSnapshot> = {}): BorrowerDeskSnapshot {
  return {
    borrower: {
      id: 7,
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
        available: 6,
        damaged: 0,
        selectable: true,
      },
    ],
    holdings: [{ itemId: 11, returnable: 5, lost: 2 }],
    asOfEventId: 8,
    ledgerEpoch: 3,
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('borrower operation state', () => {
  it('stages lost credits against the independent lost balance and projects usable stock', () => {
    let state = createOperationState(
      7,
      snapshot({
        inventory: [{ ...snapshot().inventory[0]!, available: 0 }],
        holdings: [{ itemId: 11, returnable: 0, lost: 2 }],
      }),
    );
    state = operationReducer(state, {
      type: 'stage-lost-credit',
      itemId: 11,
      part: { quantity: 1, note: 'found' },
    });

    expect(operationRequest(state).items).toEqual([
      { itemId: 11, lostCredit: [{ quantity: 1, note: 'found' }] },
    ]);
    expect(projectItem(state, 11)).toMatchObject({
      returnableNow: 0,
      lost: 2,
      lostNow: 1,
      stagedLostCredit: 1,
      projectedAvailability: 1,
      compatible: true,
    });
    expect(canSave(state)).toBe(true);

    state = operationReducer(state, { type: 'rollback', itemId: 11, direction: 'lostCredit' });
    expect(state.staged).toEqual([]);
  });

  it('preserves ordered directional buckets, immutable truth, projection formulas, and announcements', () => {
    const base = deepFreeze(snapshot());
    let state = createOperationState(7, base);
    state = operationReducer(state, {
      type: 'stage-borrow',
      itemId: 11,
      part: { quantity: 2, note: 'first' },
    });
    state = operationReducer(state, {
      type: 'stage-return',
      itemId: 11,
      part: { usable: 1, damaged: 1, note: 'second' },
    });
    state = operationReducer(state, {
      type: 'stage-borrow',
      itemId: 11,
      part: { quantity: 1, note: 'third' },
    });

    expect(operationRequest(state).items[0]).toEqual({
      itemId: 11,
      borrow: [
        { quantity: 2, note: 'first' },
        { quantity: 1, note: 'third' },
      ],
      return: [{ usable: 1, damaged: 1, note: 'second' }],
    });
    expect(projectItem(state, 11)).toMatchObject({
      stagedBorrow: 3,
      stagedReturn: 2,
      projectedHeld: 6,
      returnableNow: 3,
      lost: 2,
      projectedAvailability: 4,
      compatible: true,
    });
    expect(state.announcement).toContain('השאלה, כמות 1; באחריות השואל כעת 6');
    expect(base.holdings[0]).toEqual({ itemId: 11, returnable: 5, lost: 2 });

    state = operationReducer(state, { type: 'rollback', itemId: 11, direction: 'return' });
    expect(state.staged[0]?.borrow).toHaveLength(2);
    expect(state.staged[0]?.return).toEqual([]);
  });

  it('updates ordered borrow parts and ignores fractional indexes without an announcement', () => {
    let state = operationReducer(createOperationState(7, snapshot()), {
      type: 'stage-borrow',
      itemId: 11,
      part: { quantity: 1, note: 'a' },
    });
    state = { ...state, announcement: null };
    const unchanged = operationReducer(state, {
      type: 'update-borrow',
      itemId: 11,
      index: 0.5,
      part: { quantity: 4, note: 'bad' },
    });
    expect(unchanged).toBe(state);
    expect(unchanged.announcement).toBeNull();
    const updated = operationReducer(state, {
      type: 'update-borrow',
      itemId: 11,
      index: 0,
      part: { quantity: 2, note: 'updated' },
    });
    expect(updated.staged[0]?.borrow).toEqual([{ quantity: 2, note: 'updated' }]);
  });

  it('fails closed for unsafe arithmetic and duplicate snapshot identities', () => {
    const unsafe = snapshot({
      inventory: [{ ...snapshot().inventory[0]!, available: Number.MAX_SAFE_INTEGER }],
    });
    let state = createOperationState(7, unsafe);
    state = operationReducer(state, {
      type: 'stage-return',
      itemId: 11,
      part: { usable: 1, damaged: 0, note: '' },
    });
    expect(canSave(state)).toBe(false);

    const duplicateItem = {
      ...snapshot(),
      inventory: [...snapshot().inventory, snapshot().inventory[0]!],
    };
    const duplicateHolding = {
      ...snapshot(),
      holdings: [...snapshot().holdings, snapshot().holdings[0]!],
    };
    expect(isBorrowerDeskSnapshot(duplicateItem)).toBe(false);
    expect(isBorrowerDeskSnapshot(duplicateHolding)).toBe(false);
  });

  it('does not credit incompatible usable returns to availability', () => {
    let state = createOperationState(7, snapshot());
    state = operationReducer(state, {
      type: 'stage-return',
      itemId: 11,
      part: { usable: 6, damaged: 0, note: '' },
    });
    expect(projectItem(state, 11)).toMatchObject({
      returnableNow: -1,
      projectedAvailability: 6,
      compatible: false,
    });
    expect(canSave(state)).toBe(false);

    state = createOperationState(
      7,
      snapshot({
        inventory: [
          {
            ...snapshot().inventory[0]!,
            archived: true,
            selectable: false,
          },
        ],
      }),
    );
    state = operationReducer(state, {
      type: 'stage-return',
      itemId: 11,
      part: { usable: 1, damaged: 0, note: '' },
    });
    expect(projectItem(state, 11)).toMatchObject({
      projectedAvailability: 6,
      compatible: false,
    });

    state = operationReducer(createOperationState(7, snapshot()), {
      type: 'stage-return',
      itemId: 12,
      part: { usable: 1, damaged: 0, note: '' },
    });
    expect(projectItem(state, 12)).toMatchObject({
      projectedAvailability: 0,
      compatible: false,
    });
  });

  it('guards attempt identity, preserves unknown authorization, and retires rejected keys', () => {
    let state = operationReducer(createOperationState(7, snapshot()), {
      type: 'stage-borrow',
      itemId: 11,
      part: { quantity: 1, note: '' },
    });
    state = operationReducer(state, { type: 'dispatch', attemptKey: key1, intent: 'save' });
    expect(operationLocks(state)).toEqual({ mutation: true, exit: true });
    expect(operationReducer(state, { type: 'ambiguous', attemptKey: key2 })).toBe(state);
    state = operationReducer(state, { type: 'ambiguous', attemptKey: key1 });
    const frozen = operationReducer(state, { type: 'authorization', attemptKey: key1 });
    expect(frozen.phase.kind).toBe('unknown');
    expect(frozen.staged).toHaveLength(1);

    const nowValid = operationReducer(frozen, {
      type: 'result',
      attemptKey: key1,
      result: {
        error: 'borrower_operation_attempt_rejected',
        message: 'changed',
        outcome: 'rejected',
        idempotencyKey: key1,
        replayed: true,
        currentValidation: { status: 'now_valid', conflicts: [], snapshot: snapshot() },
      },
    });
    expect(nowValid.phase.kind).toBe('ready');
    expect(operationReducer(nowValid, { type: 'dispatch', attemptKey: key1, intent: 'save' })).toBe(
      nowValid,
    );
    expect(
      operationReducer(nowValid, { type: 'dispatch', attemptKey: key2, intent: 'save' }).phase.kind,
    ).toBe('saving');
  });

  it('replaces valid conflict truth but rejects cross-borrower and duplicate snapshots', () => {
    let state = operationReducer(createOperationState(7, snapshot()), {
      type: 'stage-borrow',
      itemId: 11,
      part: { quantity: 1, note: '' },
    });
    state = operationReducer(state, { type: 'dispatch', attemptKey: key1, intent: 'save' });
    const conflict = {
      error: 'borrower_operation_conflict' as const,
      message: 'stock changed',
      outcome: 'rejected' as const,
      idempotencyKey: key1,
      replayed: false as const,
      conflicts: [
        {
          scope: 'borrow' as const,
          code: 'insufficient_stock' as const,
          itemId: 11,
          requested: 1,
          availableAfterUsableReturns: 0,
        },
      ],
      snapshot: snapshot({
        asOfEventId: 9,
        inventory: [{ ...snapshot().inventory[0]!, available: 0 }],
      }),
    };
    const conflicted = operationReducer(state, {
      type: 'result',
      attemptKey: key1,
      result: conflict,
    });
    expect(conflicted.phase.kind).toBe('conflicted');
    expect(conflicted.snapshot.asOfEventId).toBe(9);
    expect(conflicted.staged).toHaveLength(1);
    expect(canSave(conflicted)).toBe(false);
    expect(operationLocks(conflicted).mutation).toBe(false);

    for (const badSnapshot of [
      snapshot({ borrower: { ...snapshot().borrower, id: 99 } }),
      { ...snapshot(), holdings: [...snapshot().holdings, snapshot().holdings[0]!] },
    ]) {
      const ignored = operationReducer(state, {
        type: 'result',
        attemptKey: key1,
        result: { ...conflict, snapshot: badSnapshot },
      });
      expect(ignored).toBe(state);
    }
  });

  it('clears staging before identity-owned refresh and restores recovery after repeat failures', () => {
    let state = operationReducer(createOperationState(7, snapshot()), {
      type: 'stage-borrow',
      itemId: 11,
      part: { quantity: 1, note: '' },
    });
    state = operationReducer(state, { type: 'dispatch', attemptKey: key1, intent: 'save' });
    state = operationReducer(state, {
      type: 'result',
      attemptKey: key1,
      result: { outcome: 'committed', idempotencyKey: key1, replayed: false },
    });
    expect(state.staged).toEqual([]);
    expect(state.unverifiedProjection).toEqual([
      expect.objectContaining({ itemId: 11, projectedHeld: 6, returnableNow: 5 }),
    ]);
    state = operationReducer(state, {
      type: 'refresh-started',
      refreshId: '00000000-0000-4000-8000-000000000101',
    });
    expect(
      operationReducer(state, {
        type: 'refresh-succeeded',
        refreshId: 'old',
        snapshot: snapshot(),
      }),
    ).toBe(state);
    state = operationReducer(state, {
      type: 'refresh-failed',
      refreshId: '00000000-0000-4000-8000-000000000101',
    });
    expect(state.focus).toBe('retry-refresh');
    state = operationReducer(state, {
      type: 'refresh-started',
      refreshId: '00000000-0000-4000-8000-000000000102',
    });
    state = operationReducer(state, {
      type: 'refresh-failed',
      refreshId: '00000000-0000-4000-8000-000000000102',
    });
    expect(state.phase).toMatchObject({
      kind: 'refresh-required',
      intent: 'save',
    });
    expect(state.focus).toBe('retry-refresh');
    expect(
      operationReducer(state, {
        type: 'refresh-started',
        refreshId: '00000000-0000-4000-8000-000000000102',
      }),
    ).toBe(state);
  });

  it('refreshes a normal save and models save-and-close recovery truthfully', () => {
    let state = operationReducer(createOperationState(7, snapshot()), {
      type: 'stage-borrow',
      itemId: 11,
      part: { quantity: 1, note: '' },
    });
    state = operationReducer(state, { type: 'dispatch', attemptKey: key1, intent: 'save' });
    state = operationReducer(state, {
      type: 'result',
      attemptKey: key1,
      result: { outcome: 'committed', idempotencyKey: key1, replayed: false },
    });
    state = operationReducer(state, {
      type: 'refresh-started',
      refreshId: '00000000-0000-4000-8000-000000000104',
    });
    state = operationReducer(state, {
      type: 'refresh-succeeded',
      refreshId: '00000000-0000-4000-8000-000000000104',
      snapshot: snapshot({ asOfEventId: 10 }),
    });
    expect(state).toMatchObject({
      phase: { kind: 'ready' },
      focus: 'item-search',
      unverifiedProjection: null,
    });

    let closed = operationReducer(createOperationState(7, snapshot()), {
      type: 'stage-borrow',
      itemId: 11,
      part: { quantity: 1, note: '' },
    });
    closed = operationReducer(closed, {
      type: 'dispatch',
      attemptKey: key2,
      intent: 'save-and-close',
    });
    closed = operationReducer(closed, {
      type: 'result',
      attemptKey: key2,
      result: { outcome: 'committed', idempotencyKey: key2, replayed: false },
    });
    expect(operationPresentation(closed)).toEqual({ cardOpen: false, searchEnabled: false });
    expect(operationLocks(closed).exit).toBe(false);
    closed = operationReducer(closed, {
      type: 'refresh-started',
      refreshId: '00000000-0000-4000-8000-000000000103',
    });
    closed = operationReducer(closed, {
      type: 'refresh-succeeded',
      refreshId: '00000000-0000-4000-8000-000000000103',
      snapshot: snapshot({ asOfEventId: 11 }),
    });
    expect(closed.phase.kind).toBe('closed');
    expect(operationPresentation(closed)).toEqual({ cardOpen: false, searchEnabled: true });

    let epochClosed = operationReducer(createOperationState(7, snapshot()), {
      type: 'stage-borrow',
      itemId: 11,
      part: { quantity: 1, note: '' },
    });
    epochClosed = operationReducer(epochClosed, {
      type: 'dispatch',
      attemptKey: key3,
      intent: 'save-and-close',
    });
    epochClosed = operationReducer(epochClosed, {
      type: 'result',
      attemptKey: key3,
      result: { outcome: 'committed', idempotencyKey: key3, replayed: false },
    });
    const refreshId = '00000000-0000-4000-8000-000000000105';
    epochClosed = operationReducer(epochClosed, { type: 'refresh-started', refreshId });
    epochClosed = operationReducer(epochClosed, {
      type: 'refresh-succeeded',
      refreshId,
      snapshot: snapshot({ ledgerEpoch: 4, asOfEventId: 12 }),
    });
    expect(epochClosed.phase).toMatchObject({
      kind: 'reload-required',
      confirmedIntent: 'save-and-close',
    });
    expect(operationPresentation(epochClosed)).toEqual({ cardOpen: false, searchEnabled: false });
    const reloadId = '00000000-0000-4000-8000-000000000106';
    epochClosed = operationReducer(epochClosed, { type: 'reload-started', reloadId });
    epochClosed = operationReducer(epochClosed, {
      type: 'reload-succeeded',
      reloadId,
      snapshot: snapshot({ ledgerEpoch: 4, asOfEventId: 12 }),
    });
    expect(epochClosed).toMatchObject({
      phase: { kind: 'closed' },
      focus: 'borrower-search',
      feedback: { code: 'operation_saved' },
    });
    expect(operationPresentation(epochClosed)).toEqual({ cardOpen: false, searchEnabled: true });
  });

  it('requires authoritative reload after an epoch change', () => {
    let state = operationReducer(createOperationState(7, snapshot()), {
      type: 'stage-borrow',
      itemId: 11,
      part: { quantity: 1, note: '' },
    });
    state = operationReducer(state, { type: 'dispatch', attemptKey: key1, intent: 'save' });
    state = operationReducer(state, {
      type: 'result',
      attemptKey: key1,
      result: {
        error: 'ledger_epoch_changed',
        message: 'epoch',
        outcome: 'protocol_error',
        idempotencyKey: key1,
      },
    });
    expect(state.phase.kind).toBe('reload-required');
    expect(canSave(state)).toBe(false);
    expect(
      operationReducer(state, {
        type: 'reload-succeeded',
        reloadId: '00000000-0000-4000-8000-000000000301',
        snapshot: snapshot({ borrower: { ...snapshot().borrower, id: 8 } }),
      }),
    ).toBe(state);

    const reloadId = '00000000-0000-4000-8000-000000000301';
    state = operationReducer(state, { type: 'reload-started', reloadId });
    expect(
      operationReducer(state, {
        type: 'reload-succeeded',
        reloadId: key2,
        snapshot: snapshot({ ledgerEpoch: 4 }),
      }),
    ).toBe(state);
    state = operationReducer(state, {
      type: 'reload-succeeded',
      reloadId,
      snapshot: snapshot({ ledgerEpoch: 4 }),
    });
    expect(state).toMatchObject({
      phase: { kind: 'ready' },
      conflicts: [],
      staged: [],
      snapshot: { ledgerEpoch: 4 },
    });
    expect(state.usedReloadIds).toContain(reloadId);
  });

  it('rejects invalid identities, makes empty rollback inert, and models storage failure', () => {
    let state = operationReducer(createOperationState(7, snapshot()), {
      type: 'stage-borrow',
      itemId: 11,
      part: { quantity: 1, note: '' },
    });
    expect(operationReducer(state, { type: 'rollback', itemId: 11, direction: 'return' })).toBe(
      state,
    );
    expect(
      operationReducer(state, { type: 'dispatch', attemptKey: 'not-a-uuid', intent: 'save' }),
    ).toBe(state);
    state = operationReducer(state, { type: 'dispatch', attemptKey: key1, intent: 'save' });
    const failed = operationReducer(state, {
      type: 'storage-failure',
      attemptKey: key1,
      operation: 'clear',
    });
    expect(failed.phase.kind).toBe('storage-recovery');
    expect(failed.staged).toHaveLength(1);
    expect(failed.feedback?.code).toBe('storage_clear_failed');
    expect(operationLocks(failed)).toEqual({ mutation: true, exit: true });
    expect(
      operationReducer(failed, {
        type: 'stage-borrow',
        itemId: 11,
        part: { quantity: 2, note: '' },
      }),
    ).toBe(failed);
    const recovered = operationReducer(failed, {
      type: 'storage-reconciled',
      attemptKey: key1,
      record: 'recoverable',
    });
    expect(recovered.phase.kind).toBe('unknown');
  });

  it('owns caller data, keeps staged-only rows and notes visible, and retires every attempt key', () => {
    const source = snapshot();
    let state = createOperationState(7, source);
    source.inventory[0]!.available = 0;
    expect(state.snapshot.inventory[0]!.available).toBe(6);

    const part = { quantity: 2, note: 'owned' };
    state = operationReducer(state, { type: 'stage-borrow', itemId: 99, part });
    part.quantity = 9;
    const row = projectedItems(state).find((candidate) => candidate.itemId === 99);
    expect(row).toMatchObject({
      borrowParts: [{ quantity: 2, note: 'owned' }],
      comments: ['owned'],
      compatible: false,
    });
    expect(canSave(state)).toBe(false);
    const materialized = operationRequest(state);
    materialized.items[0]!.borrow![0]!.quantity = 8;
    expect(state.staged[0]!.borrow[0]!.quantity).toBe(2);

    state = operationReducer(state, { type: 'rollback', itemId: 99, direction: 'borrow' });
    state = operationReducer(state, {
      type: 'stage-borrow',
      itemId: 11,
      part: { quantity: 1, note: '' },
    });
    state = operationReducer(state, { type: 'dispatch', attemptKey: key1, intent: 'save' });
    state = operationReducer(state, { type: 'authorization', attemptKey: key1 });
    state = operationReducer(state, { type: 'dispatch', attemptKey: key2, intent: 'save' });
    state = operationReducer(state, { type: 'authorization', attemptKey: key2 });
    expect(operationReducer(state, { type: 'dispatch', attemptKey: key1, intent: 'save' })).toBe(
      state,
    );
    expect(
      operationReducer(state, { type: 'dispatch', attemptKey: key3, intent: 'save' }).phase.kind,
    ).toBe('saving');
  });

  it('rejects non-monotonic conflict, refresh, and reload truth', () => {
    let state = operationReducer(createOperationState(7, snapshot()), {
      type: 'stage-borrow',
      itemId: 11,
      part: { quantity: 1, note: '' },
    });
    state = operationReducer(state, { type: 'dispatch', attemptKey: key1, intent: 'save' });
    const conflict = {
      error: 'borrower_operation_conflict' as const,
      message: 'stock',
      outcome: 'rejected' as const,
      idempotencyKey: key1,
      replayed: false as const,
      conflicts: [
        {
          scope: 'borrow' as const,
          code: 'insufficient_stock' as const,
          itemId: 11,
          requested: 1,
          availableAfterUsableReturns: 0,
        },
      ],
      snapshot: snapshot({
        asOfEventId: 7,
        inventory: [{ ...snapshot().inventory[0]!, available: 0 }],
      }),
    };
    expect(operationReducer(state, { type: 'result', attemptKey: key1, result: conflict })).toBe(
      state,
    );
    expect(
      operationReducer(state, {
        type: 'result',
        attemptKey: key1,
        result: {
          ...conflict,
          snapshot: snapshot({
            ledgerEpoch: 4,
            inventory: [{ ...snapshot().inventory[0]!, available: 0 }],
          }),
        },
      }),
    ).toBe(state);

    state = operationReducer(state, {
      type: 'result',
      attemptKey: key1,
      result: { outcome: 'committed', idempotencyKey: key1, replayed: false },
    });
    const refreshId = '00000000-0000-4000-8000-000000000401';
    state = operationReducer(state, { type: 'refresh-started', refreshId });
    const stale = operationReducer(state, {
      type: 'refresh-succeeded',
      refreshId,
      snapshot: snapshot({ asOfEventId: 8 }),
    });
    expect(stale.phase.kind).toBe('refresh-required');
    const epochChanged = operationReducer(state, {
      type: 'refresh-succeeded',
      refreshId,
      snapshot: snapshot({ ledgerEpoch: 4, asOfEventId: 9 }),
    });
    expect(epochChanged.phase.kind).toBe('reload-required');
  });
});

describe('borrower creation state', () => {
  const request = {
    contractVersion: 1 as const,
    ledgerEpoch: 3,
    username: 'new',
    name: 'New',
    contact: '',
    type: 'individual' as const,
  };
  const borrower = {
    id: 22,
    username: 'new',
    name: 'New',
    contact: '',
    type: 'individual' as const,
    archived: false,
  };

  it('preserves values on first authorization and freezes unknown authorization', () => {
    let state = creationReducer(createCreationState(request), {
      type: 'dispatch',
      attemptKey: key1,
    });
    expect(creationLocks(state)).toEqual({ dismissal: true, dispatch: true });
    const editable = creationReducer(state, { type: 'authorization', attemptKey: key1 });
    expect(editable.phase.kind).toBe('editing');
    expect(editable.values).toEqual(request);
    state = creationReducer(state, { type: 'ambiguous', attemptKey: key1 });
    expect(creationReducer(state, { type: 'authorization', attemptKey: key1 }).phase.kind).toBe(
      'unknown',
    );
  });

  it('identity-owns initial and retried card loads', () => {
    let state = creationReducer(createCreationState(request), {
      type: 'dispatch',
      attemptKey: key1,
    });
    state = creationReducer(state, {
      type: 'result',
      attemptKey: key1,
      loadId: '00000000-0000-4000-8000-000000000201',
      result: { outcome: 'committed', idempotencyKey: key1, replayed: false, borrower },
    });
    expect(
      creationReducer(state, {
        type: 'card-load-failed',
        loadId: '00000000-0000-4000-8000-000000000299',
      }),
    ).toBe(state);
    state = creationReducer(state, {
      type: 'card-load-failed',
      loadId: '00000000-0000-4000-8000-000000000201',
    });
    expect(
      creationReducer(state, {
        type: 'card-load-retry',
        loadId: '00000000-0000-4000-8000-000000000201',
      }),
    ).toBe(state);
    state = creationReducer(state, {
      type: 'card-load-retry',
      loadId: '00000000-0000-4000-8000-000000000202',
    });
    expect(
      creationReducer(state, {
        type: 'card-loaded',
        loadId: '00000000-0000-4000-8000-000000000202',
        snapshot: snapshot({ borrower, ledgerEpoch: 4 }),
      }).phase.kind,
    ).toBe('card-load-failed');
    expect(
      creationReducer(state, {
        type: 'card-loaded',
        loadId: '00000000-0000-4000-8000-000000000201',
        snapshot: snapshot({ borrower }),
      }),
    ).toBe(state);
    state = creationReducer(state, {
      type: 'card-loaded',
      loadId: '00000000-0000-4000-8000-000000000202',
      snapshot: snapshot({ borrower }),
    });
    expect(state.phase.kind).toBe('opened');
    expect(state.openCardBorrower?.id).toBe(22);
    expect(state.openCardSnapshot?.borrower.id).toBe(22);
    expect(
      creationReducer(state, {
        type: 'card-load-failed',
        loadId: '00000000-0000-4000-8000-000000000202',
      }),
    ).toBe(state);
  });

  it('preserves validation values, exposes conflicts, and requires a new key after now-valid replay', () => {
    let state = creationReducer(createCreationState(request), {
      type: 'dispatch',
      attemptKey: key1,
    });
    state = creationReducer(state, {
      type: 'result',
      attemptKey: key1,
      result: {
        error: 'borrower_conflict',
        message: 'match',
        outcome: 'rejected',
        idempotencyKey: key1,
        replayed: false,
        fieldErrors: [{ field: 'username', code: 'duplicate', message: 'Used' }],
        matches: [{ borrower, status: 'active', matchedBy: 'username' }],
      },
    });
    expect(state.phase.kind).toBe('conflicted');
    expect(state.values).toEqual(request);
    state = creationReducer(state, { type: 'change', field: 'username', value: 'changed' });
    expect(state.fieldErrors).toEqual([]);
    expect(state.values.username).toBe('changed');

    state = creationReducer(state, { type: 'dispatch', attemptKey: key2 });
    state = creationReducer(state, {
      type: 'result',
      attemptKey: key2,
      result: {
        error: 'borrower_create_attempt_rejected',
        message: 'now valid',
        outcome: 'rejected',
        idempotencyKey: key2,
        replayed: true,
        currentValidation: { status: 'now_valid', fieldErrors: [], matches: [] },
      },
    });
    expect(creationReducer(state, { type: 'dispatch', attemptKey: key2 })).toBe(state);
  });

  it('validates creation dispatch and routes invalid current card snapshots to retry recovery', () => {
    const invalid = createCreationState({ ...request, username: ' x ' });
    expect(creationReducer(invalid, { type: 'dispatch', attemptKey: key1 })).toBe(invalid);

    let state = creationReducer(createCreationState(request), {
      type: 'dispatch',
      attemptKey: key1,
    });
    state = creationReducer(state, {
      type: 'result',
      attemptKey: key1,
      loadId: '00000000-0000-4000-8000-000000000210',
      result: { outcome: 'committed', idempotencyKey: key1, replayed: false, borrower },
    });
    state = creationReducer(state, {
      type: 'card-loaded',
      loadId: '00000000-0000-4000-8000-000000000210',
      snapshot: snapshot(),
    });
    expect(state.phase.kind).toBe('card-load-failed');
    expect(state.focus).toBe('retry-card');
  });

  it('identity-owns creation epoch reloads and exposes persistence failures', () => {
    let state = creationReducer(createCreationState(request), {
      type: 'dispatch',
      attemptKey: key1,
    });
    state = creationReducer(state, {
      type: 'result',
      attemptKey: key1,
      result: {
        error: 'ledger_epoch_changed',
        message: 'epoch',
        outcome: 'protocol_error',
        idempotencyKey: key1,
      },
    });
    const reloadId = '00000000-0000-4000-8000-000000000310';
    state = creationReducer(state, { type: 'reload-started', reloadId });
    expect(
      creationReducer(state, { type: 'reload-succeeded', reloadId: key2, ledgerEpoch: 4 }),
    ).toBe(state);
    expect(creationReducer(state, { type: 'reload-succeeded', reloadId, ledgerEpoch: 3 })).toBe(
      state,
    );
    state = creationReducer(state, { type: 'reload-succeeded', reloadId, ledgerEpoch: 4 });
    expect(state.values.ledgerEpoch).toBe(4);
    expect(state.phase.kind).toBe('editing');

    state = creationReducer(state, { type: 'dispatch', attemptKey: key2 });
    state = creationReducer(state, {
      type: 'storage-failure',
      attemptKey: key2,
      operation: 'persist',
    });
    expect(state.phase.kind).toBe('storage-recovery');
    expect(state.feedback?.code).toBe('storage_persist_failed');
    expect(creationLocks(state)).toEqual({ dismissal: true, dispatch: true });
    state = creationReducer(state, {
      type: 'storage-reconciled',
      attemptKey: key2,
      record: 'absent',
    });
    expect(state.phase.kind).toBe('editing');
    expect(creationReducer(state, { type: 'dispatch', attemptKey: key2 })).toBe(state);
  });
});
