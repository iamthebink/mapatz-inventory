import type {
  BorrowerCreateRequest,
  BorrowerCreateResult,
  BorrowerDeskSnapshot,
  BorrowerOperationConflict,
  BorrowerOperationRequest,
  BorrowerOperationResult,
  CommandProtocolError,
} from '../contracts/borrower-workflow.js';
import type { Borrower } from '../domain/types.js';
import type { CommandClassification } from './api.js';
import { isBorrowerDeskSnapshot } from './borrower-workflow-state.js';

export const FROZEN_ATTEMPT_PREFIX = 'mapatz:frozen-attempt:v1:';

type FrozenBase = {
  version: 1;
  idempotencyKey: string;
  ledgerEpoch: number;
};

export type FrozenOperationAttempt = FrozenBase & {
  kind: 'operation';
  endpoint: string;
  subjectId: number;
  stateRevision: number;
  intent: 'save' | 'save-and-close';
  body: BorrowerOperationRequest;
};

export type FrozenCreateAttempt = FrozenBase & {
  kind: 'create';
  endpoint: '/borrowers';
  subjectId: null;
  intent: 'create';
  body: BorrowerCreateRequest;
};

export type FrozenAttempt = FrozenOperationAttempt | FrozenCreateAttempt;
export type FrozenResult<A extends FrozenAttempt> = A extends FrozenOperationAttempt
  ? BorrowerOperationResult
  : BorrowerCreateResult;
export type StorageFailure = {
  kind: 'storage-failure';
  operation: 'enumerate' | 'read' | 'write' | 'remove';
  key?: string;
};

export type FrozenDispatchResult<A extends FrozenAttempt = FrozenAttempt> =
  | {
      kind: 'definitive';
      attempt: A;
      result: FrozenResult<A> | CommandProtocolError;
      cleared: true;
    }
  | {
      kind: 'authorization';
      attempt: A;
      cleared: boolean;
      status: 401 | 403;
      clearFailure?: StorageFailure;
    }
  | { kind: 'ambiguous'; attempt: A; cleared: false; reason: string }
  | { kind: 'storage-failure'; attempt: A; cleared: false; failure: StorageFailure };

export type StorageLike = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const nonNegative = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const exactKeys = (value: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

function safeAggregate(values: number[]): boolean {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return false;
  }
  return true;
}

function validOperationBody(value: unknown, epoch: number): value is BorrowerOperationRequest {
  if (
    !isObject(value) ||
    !exactKeys(value, ['contractVersion', 'ledgerEpoch', 'items']) ||
    value.contractVersion !== 1 ||
    value.ledgerEpoch !== epoch ||
    !Array.isArray(value.items) ||
    value.items.length === 0
  )
    return false;
  const ids = new Set<number>();
  const commandBorrow: number[] = [];
  const commandIssue: number[] = [];
  const commandReturn: number[] = [];
  const commandUsable: number[] = [];
  const commandLost: number[] = [];
  const commandLostCredit: number[] = [];
  const groupsValid = value.items.every((group) => {
    if (
      !isObject(group) ||
      !exactKeys(group, ['itemId', 'borrow', 'issue', 'return', 'lost', 'lostCredit']) ||
      !positive(group.itemId) ||
      ids.has(group.itemId)
    )
      return false;
    ids.add(group.itemId);
    if (
      !(group.borrow === undefined || Array.isArray(group.borrow)) ||
      !(group.issue === undefined || Array.isArray(group.issue)) ||
      !(group.return === undefined || Array.isArray(group.return)) ||
      !(group.lost === undefined || Array.isArray(group.lost)) ||
      !(group.lostCredit === undefined || Array.isArray(group.lostCredit))
    )
      return false;
    const borrow: unknown[] = Array.isArray(group.borrow) ? group.borrow : [];
    const issue: unknown[] = Array.isArray(group.issue) ? group.issue : [];
    const returns: unknown[] = Array.isArray(group.return) ? group.return : [];
    const lost: unknown[] = Array.isArray(group.lost) ? group.lost : [];
    const lostCredits: unknown[] = Array.isArray(group.lostCredit) ? group.lostCredit : [];
    if (
      borrow.length === 0 &&
      issue.length === 0 &&
      returns.length === 0 &&
      lost.length === 0 &&
      lostCredits.length === 0
    )
      return false;
    if (borrow.length === 0 && group.borrow !== undefined) return false;
    if (issue.length === 0 && group.issue !== undefined) return false;
    if (returns.length === 0 && group.return !== undefined) return false;
    if (lost.length === 0 && group.lost !== undefined) return false;
    if (lostCredits.length === 0 && group.lostCredit !== undefined) return false;
    const borrowValid = borrow.every(
      (part) =>
        isObject(part) &&
        exactKeys(part, ['quantity', 'note']) &&
        positive(part.quantity) &&
        typeof part.note === 'string' &&
        part.note.length <= 500,
    );
    const returnsValid = returns.every(
      (part) =>
        isObject(part) &&
        exactKeys(part, ['usable', 'damaged', 'note']) &&
        nonNegative(part.usable) &&
        nonNegative(part.damaged) &&
        Number.isSafeInteger(part.usable + part.damaged) &&
        part.usable + part.damaged > 0 &&
        typeof part.note === 'string' &&
        part.note.length <= 500,
    );
    const lostCreditsValid = lostCredits.every(
      (part) =>
        isObject(part) &&
        exactKeys(part, ['quantity', 'condition', 'note']) &&
        positive(part.quantity) &&
        (part.condition === 'usable' || part.condition === 'damaged') &&
        typeof part.note === 'string' &&
        part.note.length <= 500,
    );
    const lostValid = lost.every(
      (part) =>
        isObject(part) &&
        exactKeys(part, ['quantity', 'note']) &&
        positive(part.quantity) &&
        typeof part.note === 'string' &&
        part.note.length <= 500,
    );
    const issueValid = issue.every(
      (part) =>
        isObject(part) &&
        exactKeys(part, ['quantity', 'note']) &&
        positive(part.quantity) &&
        typeof part.note === 'string' &&
        part.note.length <= 500,
    );
    if (!borrowValid || !issueValid || !returnsValid || !lostValid || !lostCreditsValid)
      return false;
    const borrowValues = borrow.map((part) => Number((part as Record<string, unknown>).quantity));
    const issueValues = issue.map((part) => Number((part as Record<string, unknown>).quantity));
    const returnValues = returns.map(
      (part) =>
        Number((part as Record<string, unknown>).usable) +
        Number((part as Record<string, unknown>).damaged),
    );
    const usableValues = returns.map((part) => Number((part as Record<string, unknown>).usable));
    const lostValues = lost.map((part) => Number((part as Record<string, unknown>).quantity));
    const lostCreditValues = lostCredits.map((part) =>
      Number((part as Record<string, unknown>).quantity),
    );
    commandBorrow.push(...borrowValues);
    commandIssue.push(...issueValues);
    commandReturn.push(...returnValues);
    commandUsable.push(...usableValues);
    commandLost.push(...lostValues);
    commandLostCredit.push(...lostCreditValues);
    return (
      safeAggregate(borrowValues) &&
      safeAggregate(issueValues) &&
      safeAggregate(returnValues) &&
      safeAggregate(usableValues) &&
      safeAggregate(lostValues) &&
      safeAggregate(lostCreditValues)
    );
  });
  return (
    groupsValid &&
    safeAggregate(commandBorrow) &&
    safeAggregate(commandIssue) &&
    safeAggregate(commandReturn) &&
    safeAggregate(commandUsable) &&
    safeAggregate(commandLost) &&
    safeAggregate(commandLostCredit)
  );
}

function validCreateBody(value: unknown, epoch: number): value is BorrowerCreateRequest {
  return (
    isObject(value) &&
    exactKeys(value, ['contractVersion', 'ledgerEpoch', 'username', 'name', 'contact', 'type']) &&
    value.contractVersion === 1 &&
    value.ledgerEpoch === epoch &&
    typeof value.username === 'string' &&
    value.username.trim() === value.username &&
    value.username.length >= 2 &&
    value.username.length <= 40 &&
    typeof value.name === 'string' &&
    value.name.trim() === value.name &&
    value.name.length >= 1 &&
    value.name.length <= 100 &&
    typeof value.contact === 'string' &&
    value.contact.trim() === value.contact &&
    value.contact.length <= 500 &&
    ['individual', 'camp_organization', 'other'].includes(String(value.type))
  );
}

export function isCommandUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isNormalizedBorrowerOperationRequest(
  value: unknown,
): value is BorrowerOperationRequest {
  return (
    isObject(value) && positive(value.ledgerEpoch) && validOperationBody(value, value.ledgerEpoch)
  );
}

export function isNormalizedBorrowerCreateRequest(value: unknown): value is BorrowerCreateRequest {
  return (
    isObject(value) && positive(value.ledgerEpoch) && validCreateBody(value, value.ledgerEpoch)
  );
}

export function parseFrozenAttempt(value: unknown): FrozenAttempt | null {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      'version',
      'kind',
      'endpoint',
      'subjectId',
      'idempotencyKey',
      'ledgerEpoch',
      'stateRevision',
      'intent',
      'body',
    ]) ||
    value.version !== 1 ||
    !isCommandUuid(value.idempotencyKey) ||
    !positive(value.ledgerEpoch)
  )
    return null;
  if (value.kind === 'operation') {
    if (
      !positive(value.subjectId) ||
      !nonNegative(value.stateRevision) ||
      value.endpoint !== `/borrowers/${value.subjectId}/operations` ||
      !['save', 'save-and-close'].includes(String(value.intent)) ||
      !validOperationBody(value.body, value.ledgerEpoch)
    )
      return null;
    return ownedAttempt(value as unknown as FrozenOperationAttempt);
  }
  if (
    value.kind !== 'create' ||
    value.endpoint !== '/borrowers' ||
    value.subjectId !== null ||
    Object.hasOwn(value, 'stateRevision') ||
    value.intent !== 'create' ||
    !validCreateBody(value.body, value.ledgerEpoch)
  )
    return null;
  return ownedAttempt(value as unknown as FrozenCreateAttempt);
}

function ownedAttempt<A extends FrozenAttempt>(attempt: A): A {
  return deepFreeze(structuredClone(attempt));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function frozenAttemptStorageKey(attempt: Pick<FrozenAttempt, 'idempotencyKey'>): string {
  return `${FROZEN_ATTEMPT_PREFIX}${attempt.idempotencyKey}`;
}

function serialized(attempt: FrozenAttempt): string {
  return JSON.stringify(attempt);
}

/** Writes and reads back the exact envelope. A silent no-op or collision fails closed. */
export function persistFrozenAttempt(
  storage: StorageLike,
  attempt: FrozenAttempt,
): { ok: true } | { ok: false; failure: StorageFailure } {
  const validated = parseFrozenAttempt(attempt);
  const key = frozenAttemptStorageKey(attempt);
  if (!validated)
    return { ok: false, failure: { kind: 'storage-failure', operation: 'write', key } };
  const expected = serialized(validated);
  try {
    const existing = storage.getItem(key);
    if (existing !== null && existing !== expected)
      return { ok: false, failure: { kind: 'storage-failure', operation: 'write', key } };
    storage.setItem(key, expected);
    if (storage.getItem(key) !== expected)
      return { ok: false, failure: { kind: 'storage-failure', operation: 'write', key } };
    return { ok: true };
  } catch {
    return { ok: false, failure: { kind: 'storage-failure', operation: 'write', key } };
  }
}

/** Compare, remove, and verify; never reports success while the exact record remains. */
export function clearFrozenAttempt(
  storage: StorageLike,
  attempt: FrozenAttempt,
): { ok: true } | { ok: false; failure: StorageFailure } {
  const validated = parseFrozenAttempt(attempt);
  const key = frozenAttemptStorageKey(attempt);
  if (!validated)
    return { ok: false, failure: { kind: 'storage-failure', operation: 'remove', key } };
  const expected = serialized(validated);
  try {
    const current = storage.getItem(key);
    if (current === null) return { ok: true };
    if (current !== expected)
      return { ok: false, failure: { kind: 'storage-failure', operation: 'remove', key } };
    storage.removeItem(key);
    if (storage.getItem(key) !== null)
      return { ok: false, failure: { kind: 'storage-failure', operation: 'remove', key } };
    return { ok: true };
  } catch {
    return { ok: false, failure: { kind: 'storage-failure', operation: 'remove', key } };
  }
}

export type FrozenEnumeration = {
  valid: FrozenAttempt[];
  invalidKeys: string[];
  failures: StorageFailure[];
};

export function enumerateFrozenAttempts(storage: StorageLike): FrozenEnumeration {
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(FROZEN_ATTEMPT_PREFIX)) keys.push(key);
    }
  } catch {
    return {
      valid: [],
      invalidKeys: [],
      failures: [{ kind: 'storage-failure', operation: 'enumerate' }],
    };
  }
  keys.sort();
  const valid: FrozenAttempt[] = [];
  const invalidKeys: string[] = [];
  const failures: StorageFailure[] = [];
  for (const key of keys) {
    try {
      const raw = storage.getItem(key);
      let parsed: unknown;
      try {
        parsed = raw === null ? null : JSON.parse(raw);
      } catch {
        parsed = null;
      }
      const attempt = parseFrozenAttempt(parsed);
      if (!attempt || frozenAttemptStorageKey(attempt) !== key) invalidKeys.push(key);
      else valid.push(attempt);
    } catch {
      failures.push({ kind: 'storage-failure', operation: 'read', key });
    }
  }
  return { valid, invalidKeys, failures };
}

export type FrozenTransport<A extends FrozenAttempt = FrozenAttempt> = (
  attempt: A,
) => Promise<CommandClassification<FrozenResult<A>>>;

async function settle<A extends FrozenAttempt>(
  storage: StorageLike,
  attempt: A,
  outcome: CommandClassification<FrozenResult<A>>,
  duringResolution: boolean,
): Promise<FrozenDispatchResult<A>> {
  if (outcome.kind === 'ambiguous')
    return { kind: 'ambiguous', attempt, cleared: false, reason: outcome.reason };
  if (outcome.kind === 'authorization' && duringResolution)
    return { kind: 'authorization', attempt, status: outcome.status, cleared: false };
  if (outcome.kind === 'definitive') {
    const expectedStatus =
      'error' in outcome.result && outcome.result.error === 'validation_error'
        ? 400
        : 'outcome' in outcome.result && outcome.result.outcome === 'committed'
          ? 201
          : 409;
    if (outcome.status !== expectedStatus || !resultBelongsToAttempt(attempt, outcome.result))
      return { kind: 'ambiguous', attempt, cleared: false, reason: 'invalid-body' };
  }
  const cleared = clearFrozenAttempt(storage, attempt);
  if (!cleared.ok) {
    if (outcome.kind === 'authorization')
      return {
        kind: 'authorization',
        attempt,
        status: outcome.status,
        cleared: false,
        clearFailure: cleared.failure,
      };
    return { kind: 'storage-failure', attempt, cleared: false, failure: cleared.failure };
  }
  if (outcome.kind === 'authorization')
    return { kind: 'authorization', attempt, status: outcome.status, cleared: true };
  return { kind: 'definitive', attempt, result: outcome.result, cleared: true };
}

/** First dispatch: durability is proven before transport is invoked. */
export async function dispatchFrozenAttempt<A extends FrozenAttempt>(
  storage: StorageLike,
  attempt: A,
  transport: FrozenTransport<NoInfer<A>>,
): Promise<FrozenDispatchResult<A>> {
  const validated = parseFrozenAttempt(attempt) as A | null;
  if (!validated)
    return {
      kind: 'storage-failure',
      attempt,
      cleared: false,
      failure: { kind: 'storage-failure', operation: 'write' },
    };
  const persisted = persistFrozenAttempt(storage, validated);
  if (!persisted.ok)
    return {
      kind: 'storage-failure',
      attempt: validated,
      cleared: false,
      failure: persisted.failure,
    };
  try {
    return await settle(storage, validated, await transport(validated), false);
  } catch {
    return { kind: 'ambiguous', attempt: validated, cleared: false, reason: 'network' };
  }
}

/** Recovery dispatches only an envelope which still exists byte-for-byte in storage. */
export async function resolveFrozenAttempt<A extends FrozenAttempt>(
  storage: StorageLike,
  attempt: A,
  transport: FrozenTransport<NoInfer<A>>,
): Promise<FrozenDispatchResult<A>> {
  const validated = parseFrozenAttempt(attempt) as A | null;
  if (!validated)
    return {
      kind: 'storage-failure',
      attempt,
      cleared: false,
      failure: { kind: 'storage-failure', operation: 'read' },
    };
  const key = frozenAttemptStorageKey(validated);
  try {
    if (storage.getItem(key) !== serialized(validated))
      return {
        kind: 'storage-failure',
        attempt,
        cleared: false,
        failure: { kind: 'storage-failure', operation: 'read', key },
      };
  } catch {
    return {
      kind: 'storage-failure',
      attempt,
      cleared: false,
      failure: { kind: 'storage-failure', operation: 'read', key },
    };
  }
  try {
    return await settle(storage, validated, await transport(validated), true);
  } catch {
    return { kind: 'ambiguous', attempt: validated, cleared: false, reason: 'network' };
  }
}

function resultBelongsToAttempt(
  attempt: FrozenAttempt,
  result: BorrowerOperationResult | BorrowerCreateResult | CommandProtocolError,
): boolean {
  if (!isObject(result)) return false;
  if ('error' in result) {
    if (result.error === 'validation_error')
      return (
        exactKeys(result, ['error', 'message', 'fieldErrors']) &&
        typeof result.message === 'string' &&
        validFieldErrors(result.fieldErrors)
      );
    if (result.error === 'idempotency_key_reused' || result.error === 'ledger_epoch_changed')
      return (
        exactKeys(result, ['error', 'message', 'outcome', 'idempotencyKey']) &&
        typeof result.message === 'string' &&
        result.outcome === 'protocol_error' &&
        result.idempotencyKey === attempt.idempotencyKey
      );
    if (attempt.kind === 'operation') {
      if (result.error === 'borrower_operation_conflict')
        return (
          exactKeys(result, [
            'error',
            'message',
            'outcome',
            'idempotencyKey',
            'replayed',
            'conflicts',
            'snapshot',
          ]) &&
          typeof result.message === 'string' &&
          result.outcome === 'rejected' &&
          result.idempotencyKey === attempt.idempotencyKey &&
          result.replayed === false &&
          isBorrowerDeskSnapshot(result.snapshot, attempt.subjectId) &&
          result.snapshot.ledgerEpoch === attempt.ledgerEpoch &&
          result.snapshot.stateRevision >= attempt.stateRevision &&
          validOperationConflicts(attempt, result.conflicts, result.snapshot)
        );
      if (result.error === 'borrower_operation_attempt_rejected')
        return (
          exactKeys(result, [
            'error',
            'message',
            'outcome',
            'idempotencyKey',
            'replayed',
            'currentValidation',
          ]) &&
          typeof result.message === 'string' &&
          result.outcome === 'rejected' &&
          result.idempotencyKey === attempt.idempotencyKey &&
          result.replayed === true &&
          isObject(result.currentValidation) &&
          exactKeys(result.currentValidation, ['status', 'conflicts', 'snapshot']) &&
          isBorrowerDeskSnapshot(result.currentValidation.snapshot, attempt.subjectId) &&
          result.currentValidation.snapshot.ledgerEpoch === attempt.ledgerEpoch &&
          result.currentValidation.snapshot.stateRevision >= attempt.stateRevision &&
          (result.currentValidation.status === 'now_valid'
            ? Array.isArray(result.currentValidation.conflicts) &&
              result.currentValidation.conflicts.length === 0
            : result.currentValidation.status === 'conflicted' &&
              validOperationConflicts(
                attempt,
                result.currentValidation.conflicts,
                result.currentValidation.snapshot,
              ))
        );
      return false;
    }
    if (result.error === 'borrower_conflict')
      return (
        exactKeys(result, [
          'error',
          'message',
          'outcome',
          'idempotencyKey',
          'replayed',
          'fieldErrors',
          'matches',
        ]) &&
        typeof result.message === 'string' &&
        result.outcome === 'rejected' &&
        result.idempotencyKey === attempt.idempotencyKey &&
        result.replayed === false &&
        validCreateAttribution(attempt, result)
      );
    if (result.error === 'borrower_create_attempt_rejected')
      return (
        exactKeys(result, [
          'error',
          'message',
          'outcome',
          'idempotencyKey',
          'replayed',
          'currentValidation',
        ]) &&
        typeof result.message === 'string' &&
        result.outcome === 'rejected' &&
        result.idempotencyKey === attempt.idempotencyKey &&
        result.replayed === true &&
        isObject(result.currentValidation) &&
        exactKeys(result.currentValidation, ['status', 'fieldErrors', 'matches']) &&
        (result.currentValidation.status === 'now_valid'
          ? Array.isArray(result.currentValidation.fieldErrors) &&
            result.currentValidation.fieldErrors.length === 0 &&
            Array.isArray(result.currentValidation.matches) &&
            result.currentValidation.matches.length === 0
          : result.currentValidation.status === 'conflicted' &&
            validCreateAttribution(attempt, result.currentValidation))
      );
    return false;
  }
  if (
    result.outcome !== 'committed' ||
    result.idempotencyKey !== attempt.idempotencyKey ||
    typeof result.replayed !== 'boolean'
  )
    return false;
  if (attempt.kind === 'operation')
    return exactKeys(result, ['outcome', 'idempotencyKey', 'replayed']);
  if (
    !('borrower' in result) ||
    !exactKeys(result, ['outcome', 'idempotencyKey', 'replayed', 'borrower'])
  )
    return false;
  if (!validBorrower(result.borrower)) return false;
  const expected = attempt.body;
  return (
    !result.borrower.archived &&
    result.borrower.username === expected.username &&
    result.borrower.name === expected.name &&
    result.borrower.contact === expected.contact &&
    result.borrower.type === expected.type
  );
}

function validBorrower(value: unknown): value is Borrower {
  return (
    isObject(value) &&
    exactKeys(value, ['id', 'username', 'name', 'contact', 'type', 'archived']) &&
    positive(value.id) &&
    typeof value.username === 'string' &&
    typeof value.name === 'string' &&
    typeof value.contact === 'string' &&
    ['individual', 'camp_organization', 'other'].includes(String(value.type)) &&
    typeof value.archived === 'boolean'
  );
}

function validFieldErrors(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (error) =>
        isObject(error) &&
        exactKeys(error, ['field', 'code', 'message']) &&
        typeof error.field === 'string' &&
        typeof error.code === 'string' &&
        typeof error.message === 'string',
    )
  );
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Mirrors InventoryService.validateBorrowerOperation, including ordering and early-continue rules. */
export function isExactBorrowerOperationConflictSet(
  value: unknown,
  borrowerId: number,
  request: BorrowerOperationRequest,
  snapshot: BorrowerDeskSnapshot,
): value is BorrowerOperationConflict[] {
  if (!Array.isArray(value) || !isBorrowerDeskSnapshot(snapshot, borrowerId)) return false;
  if (snapshot.borrower.archived)
    return (
      value.length === 1 &&
      isObject(value[0]) &&
      exactKeys(value[0], ['scope', 'code', 'borrowerId']) &&
      value[0].scope === 'borrower' &&
      value[0].code === 'borrower_inactive' &&
      value[0].borrowerId === borrowerId
    );

  const groups = [...request.items].sort((left, right) => left.itemId - right.itemId);
  if (value.length > groups.length) return false;
  let conflictIndex = 0;
  for (const group of groups) {
    const item = snapshot.inventory.find((entry) => entry.id === group.itemId);
    const candidate = value[conflictIndex];
    if (!item) {
      if (
        !isObject(candidate) ||
        !exactKeys(candidate, ['scope', 'code', 'itemId']) ||
        candidate.scope !== 'item' ||
        !['item_not_found', 'item_archived', 'wrong_item_kind'].includes(String(candidate.code)) ||
        candidate.itemId !== group.itemId
      )
        return false;
      conflictIndex += 1;
      continue;
    }
    if (item.archived) {
      if (
        !isObject(candidate) ||
        !exactKeys(candidate, ['scope', 'code', 'itemId']) ||
        candidate.scope !== 'item' ||
        candidate.code !== 'item_archived' ||
        candidate.itemId !== group.itemId
      )
        return false;
      conflictIndex += 1;
      continue;
    }
    if (
      item.kind === 'consumable' &&
      group.issue?.length &&
      !group.borrow &&
      !group.return &&
      !group.lost &&
      !group.lostCredit
    ) {
      const requested = sum(group.issue.map((part) => part.quantity));
      if (requested > item.available) {
        if (
          !isObject(candidate) ||
          !exactKeys(candidate, ['scope', 'code', 'itemId', 'requested', 'available']) ||
          candidate.scope !== 'issue' ||
          candidate.code !== 'insufficient_stock' ||
          candidate.itemId !== group.itemId ||
          candidate.requested !== requested ||
          candidate.available !== item.available
        )
          return false;
        conflictIndex += 1;
      }
      continue;
    }
    if (item.kind !== 'non_consumable' || group.issue) {
      if (
        !isObject(candidate) ||
        !exactKeys(candidate, ['scope', 'code', 'itemId']) ||
        candidate.scope !== 'item' ||
        candidate.code !== 'wrong_item_kind' ||
        candidate.itemId !== group.itemId
      )
        return false;
      conflictIndex += 1;
      continue;
    }
    const requestedReturn = sum((group.return ?? []).map((part) => part.usable + part.damaged));
    const requestedLost = sum((group.lost ?? []).map((part) => part.quantity));
    const returnable =
      snapshot.holdings.find((holding) => holding.itemId === group.itemId)?.returnable ?? 0;
    if (requestedReturn + requestedLost > returnable) {
      const scope = requestedLost > 0 ? 'held' : 'return';
      const code = requestedLost > 0 ? 'held_balance_changed' : 'returnable_balance_changed';
      if (
        !isObject(candidate) ||
        !exactKeys(candidate, ['scope', 'code', 'itemId', 'requested', 'returnable']) ||
        candidate.scope !== scope ||
        candidate.code !== code ||
        candidate.itemId !== group.itemId ||
        candidate.requested !== requestedReturn + requestedLost ||
        candidate.returnable !== returnable
      )
        return false;
      conflictIndex += 1;
      continue;
    }
    const requestedLostCredit = sum((group.lostCredit ?? []).map((part) => part.quantity));
    const lost = snapshot.holdings.find((holding) => holding.itemId === group.itemId)?.lost ?? 0;
    if (requestedLostCredit > lost + requestedLost) {
      if (
        !isObject(candidate) ||
        !exactKeys(candidate, ['scope', 'code', 'itemId', 'requested', 'lost']) ||
        candidate.scope !== 'lost-credit' ||
        candidate.code !== 'lost_balance_changed' ||
        candidate.itemId !== group.itemId ||
        candidate.requested !== requestedLostCredit ||
        candidate.lost !== lost + requestedLost
      )
        return false;
      conflictIndex += 1;
      continue;
    }
    const requestedBorrow = sum((group.borrow ?? []).map((part) => part.quantity));
    const usableReturns = sum((group.return ?? []).map((part) => part.usable));
    const usableLostCredit = sum(
      (group.lostCredit ?? [])
        .filter((part) => part.condition === 'usable')
        .map((part) => part.quantity),
    );
    const availableAfterUsableReturns = item.available + usableReturns + usableLostCredit;
    if (!Number.isSafeInteger(availableAfterUsableReturns)) return false;
    if (requestedBorrow > availableAfterUsableReturns) {
      if (
        !isObject(candidate) ||
        !exactKeys(candidate, [
          'scope',
          'code',
          'itemId',
          'requested',
          'availableAfterUsableReturns',
        ]) ||
        candidate.scope !== 'borrow' ||
        candidate.code !== 'insufficient_stock' ||
        candidate.itemId !== group.itemId ||
        candidate.requested !== requestedBorrow ||
        candidate.availableAfterUsableReturns !== availableAfterUsableReturns
      )
        return false;
      conflictIndex += 1;
    }
  }
  return conflictIndex > 0 && conflictIndex === value.length;
}

function validOperationConflicts(
  attempt: FrozenOperationAttempt,
  value: unknown,
  snapshot: BorrowerDeskSnapshot,
): boolean {
  return isExactBorrowerOperationConflictSet(value, attempt.subjectId, attempt.body, snapshot);
}

function validCreateAttribution(
  attempt: FrozenCreateAttempt,
  value: Record<string, unknown>,
): boolean {
  if (!validFieldErrors(value.fieldErrors) || !Array.isArray(value.matches)) return false;
  const matches = value.matches;
  const normalized = {
    username: normalizeIdentity(attempt.body.username),
    contact: normalizeIdentity(attempt.body.contact),
    full_name: normalizeIdentity(attempt.body.name),
  };
  const matchedKinds = new Set<string>();
  const borrowerIds = new Set<number>();
  const matchOrder = { username: 0, contact: 1, full_name: 2 } as const;
  const typedMatches: Array<{
    borrower: Borrower;
    status: 'active' | 'archived';
    matchedBy: keyof typeof matchOrder;
  }> = [];
  for (const candidate of matches) {
    if (
      !isObject(candidate) ||
      !exactKeys(candidate, ['borrower', 'status', 'matchedBy']) ||
      !validBorrower(candidate.borrower) ||
      !['active', 'archived'].includes(String(candidate.status)) ||
      !['username', 'contact', 'full_name'].includes(String(candidate.matchedBy)) ||
      borrowerIds.has(candidate.borrower.id)
    )
      return false;
    borrowerIds.add(candidate.borrower.id);
    const match = candidate as unknown as (typeof typedMatches)[number];
    const kinds = [
      normalizeIdentity(match.borrower.username) === normalized.username ? 'username' : null,
      normalized.contact.length > 0 &&
      normalizeIdentity(match.borrower.contact) === normalized.contact
        ? 'contact'
        : null,
      normalizeIdentity(match.borrower.name) === normalized.full_name ? 'full_name' : null,
    ].filter((kind): kind is 'username' | 'contact' | 'full_name' => kind !== null);
    if (match.matchedBy !== kinds[0] || (match.status === 'archived') !== match.borrower.archived)
      return false;
    for (const kind of kinds) matchedKinds.add(kind);
    typedMatches.push(match);
  }
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  for (let index = 1; index < typedMatches.length; index += 1) {
    const left = typedMatches[index - 1]!;
    const right = typedMatches[index]!;
    const ordering =
      Number(left.borrower.archived) - Number(right.borrower.archived) ||
      matchOrder[left.matchedBy] - matchOrder[right.matchedBy] ||
      compare(normalizeIdentity(left.borrower.name), normalizeIdentity(right.borrower.name)) ||
      compare(
        normalizeIdentity(left.borrower.username),
        normalizeIdentity(right.borrower.username),
      ) ||
      left.borrower.id - right.borrower.id;
    if (ordering > 0) return false;
  }
  const expectedErrors = [
    ['username', 'username', 'username_conflict', 'Username matches an existing borrower'],
    ['contact', 'contact', 'contact_conflict', 'Contact matches an existing borrower'],
    ['full_name', 'name', 'full_name_conflict', 'Name matches an existing borrower'],
  ]
    .filter(([kind]) => matchedKinds.has(kind!))
    .map(([, field, code, message]) => ({ field, code, message }));
  return (
    JSON.stringify(value.fieldErrors) === JSON.stringify(expectedErrors) &&
    typedMatches.length + expectedErrors.length > 0
  );
}

function normalizeIdentity(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export type RecoveryInitialization = {
  ready: boolean;
  results: FrozenDispatchResult[];
  invalidKeys: string[];
  failures: StorageFailure[];
};

export async function initializeFrozenAttemptRecovery(
  storage: StorageLike,
  transport: FrozenTransport,
): Promise<RecoveryInitialization> {
  const results: FrozenDispatchResult[] = [];
  const invalidKeys = new Set<string>();
  const failures: StorageFailure[] = [];
  let enumeration = enumerateFrozenAttempts(storage);
  let pass = 0;
  while (pass < 1000) {
    pass += 1;
    for (const key of enumeration.invalidKeys) invalidKeys.add(key);
    failures.push(...enumeration.failures);
    if (enumeration.valid.length === 0) break;
    const passResults: FrozenDispatchResult[] = [];
    for (const attempt of enumeration.valid)
      passResults.push(await resolveFrozenAttempt(storage, attempt, transport));
    results.push(...passResults);
    if (passResults.some((result) => !result.cleared)) break;
    enumeration = enumerateFrozenAttempts(storage);
  }
  if (pass >= 1000) failures.push({ kind: 'storage-failure', operation: 'enumerate' });

  const finalEnumeration = enumerateFrozenAttempts(storage);
  for (const key of finalEnumeration.invalidKeys) invalidKeys.add(key);
  failures.push(...finalEnumeration.failures);
  const stableEnumeration = enumerateFrozenAttempts(storage);
  for (const key of stableEnumeration.invalidKeys) invalidKeys.add(key);
  failures.push(...stableEnumeration.failures);
  const finalKeys = finalEnumeration.valid.map(frozenAttemptStorageKey);
  const stableKeys = stableEnumeration.valid.map(frozenAttemptStorageKey);
  const stable = JSON.stringify(finalKeys) === JSON.stringify(stableKeys);
  const unresolved = results.some((result) => !result.cleared);
  return {
    ready:
      stable &&
      finalKeys.length === 0 &&
      invalidKeys.size === 0 &&
      failures.length === 0 &&
      !unresolved,
    results,
    invalidKeys: [...invalidKeys].sort(),
    failures,
  };
}
