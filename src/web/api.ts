import {
  isBorrowerValidationEvidence,
  isValidBorrowerProfile,
} from '../domain/borrower-profile.js';
import { desktop } from './desktop';
import type {
  BorrowerImportMode,
  BorrowerImportPreview,
  BorrowerImportResult,
} from '../contracts/borrower-import.js';
import type {
  BorrowerCreateRequest,
  BorrowerCreateResult,
  BorrowerDeskSnapshot,
  BorrowerOperationRequest,
  BorrowerOperationResult,
  BorrowerSearchSnapshot,
  CommandProtocolError,
} from '../contracts/borrower-workflow.js';
import type { Borrower } from '../domain/types.js';
import type { RadioFleet } from '../domain/types.js';
import type { PeriodSummary } from '../contracts/period-summary.js';
import {
  isCommandUuid,
  isExactBorrowerOperationConflictSet,
  isNormalizedBorrowerCreateRequest,
  isNormalizedBorrowerOperationRequest,
  type FrozenAttempt,
  type FrozenTransport,
} from './borrower-workflow-recovery.js';
import { isBorrowerDeskSnapshot } from './borrower-workflow-state.js';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type CommandClassification<T> =
  | { kind: 'definitive'; status: number; result: T | CommandProtocolError }
  | { kind: 'authorization'; status: 401 | 403 }
  | {
      kind: 'ambiguous';
      reason: 'network' | 'server' | 'invalid-body' | 'unparseable';
      status?: number;
    };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isSafePositive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const isSafeNonNegative = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const exactKeys = (value: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

function validBorrower(value: unknown): value is Borrower {
  return (
    isObject(value) &&
    exactKeys(value, [
      'id',
      'playaName',
      'fullName',
      'phoneNumber',
      'campDepartment',
      'archived',
    ]) &&
    isSafePositive(value.id) &&
    isValidBorrowerProfile(value as unknown as Borrower) &&
    isBoolean(value.archived)
  );
}

function validBorrowerSearchSnapshot(value: unknown): value is BorrowerSearchSnapshot {
  if (
    !isObject(value) ||
    !exactKeys(value, ['ledgerEpoch', 'active', 'archivedMatches']) ||
    !isSafePositive(value.ledgerEpoch) ||
    !Array.isArray(value.active) ||
    !value.active.every((borrower) => validBorrower(borrower) && !borrower.archived) ||
    !Array.isArray(value.archivedMatches)
  )
    return false;
  const archivedValid = value.archivedMatches.every(
    (match) =>
      isObject(match) &&
      exactKeys(match, ['borrower', 'matchedBy']) &&
      validBorrower(match.borrower) &&
      match.borrower.archived &&
      ['playa_name', 'phone_number', 'full_name'].includes(String(match.matchedBy)),
  );
  if (!archivedValid) return false;
  const ids = [
    ...value.active.map((candidate) => candidate.id),
    ...value.archivedMatches.map((match) => (match as { borrower: Borrower }).borrower.id),
  ];
  return new Set(ids).size === ids.length;
}

function validFieldErrors(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isObject(entry) &&
        exactKeys(entry, ['field', 'code', 'message']) &&
        isString(entry.field) &&
        isString(entry.code) &&
        isString(entry.message),
    )
  );
}

function validProtocolError(body: Record<string, unknown>, key: string): boolean {
  if (!isString(body.error) || !isString(body.message)) return false;
  if (body.error === 'validation_error')
    return (
      exactKeys(body, ['error', 'message', 'fieldErrors']) && validFieldErrors(body.fieldErrors)
    );
  if (body.error === 'idempotency_key_reused' || body.error === 'ledger_epoch_changed')
    return (
      exactKeys(body, ['error', 'message', 'outcome', 'idempotencyKey']) &&
      body.outcome === 'protocol_error' &&
      body.idempotencyKey === key
    );
  return false;
}

function validOperationResult(
  body: Record<string, unknown>,
  key: string,
  borrowerId: number,
  request: BorrowerOperationRequest,
  stateRevision: number,
): body is Record<string, unknown> & BorrowerOperationResult {
  if ('error' in body && !isString(body.error)) return false;
  if (body.idempotencyKey !== key || !isBoolean(body.replayed)) return false;
  if (body.outcome === 'committed')
    return exactKeys(body, ['outcome', 'idempotencyKey', 'replayed']) && !('error' in body);
  if (body.outcome !== 'rejected' || !isString(body.message) || body.replayed === undefined)
    return false;
  if (body.error === 'borrower_operation_conflict')
    return (
      body.replayed === false &&
      exactKeys(body, [
        'error',
        'message',
        'outcome',
        'idempotencyKey',
        'replayed',
        'conflicts',
        'snapshot',
      ]) &&
      isBorrowerDeskSnapshot(body.snapshot, borrowerId) &&
      body.snapshot.ledgerEpoch === request.ledgerEpoch &&
      body.snapshot.stateRevision >= stateRevision &&
      isExactBorrowerOperationConflictSet(body.conflicts, borrowerId, request, body.snapshot)
    );
  if (body.error !== 'borrower_operation_attempt_rejected' || body.replayed !== true) return false;
  if (
    !exactKeys(body, [
      'error',
      'message',
      'outcome',
      'idempotencyKey',
      'replayed',
      'currentValidation',
    ])
  )
    return false;
  const validation = body.currentValidation;
  if (
    !isObject(validation) ||
    !isBorrowerDeskSnapshot(validation.snapshot, borrowerId) ||
    validation.snapshot.ledgerEpoch !== request.ledgerEpoch ||
    validation.snapshot.stateRevision < stateRevision
  )
    return false;
  if (validation.status === 'now_valid')
    return (
      exactKeys(validation, ['status', 'conflicts', 'snapshot']) &&
      Array.isArray(validation.conflicts) &&
      validation.conflicts.length === 0
    );
  return (
    validation.status === 'conflicted' &&
    exactKeys(validation, ['status', 'conflicts', 'snapshot']) &&
    isExactBorrowerOperationConflictSet(
      validation.conflicts,
      borrowerId,
      request,
      validation.snapshot,
    )
  );
}

function normalizedCreate(request: BorrowerCreateRequest): BorrowerCreateRequest {
  return {
    ...request,
    playaName: request.playaName.trim(),
    fullName: request.fullName.trim(),
    campDepartment: request.campDepartment.trim(),
    phoneNumber: request.phoneNumber.trim(),
  };
}

function borrowerMatchesRequest(borrower: Borrower, request: BorrowerCreateRequest): boolean {
  const expected = normalizedCreate(request);
  return (
    !borrower.archived &&
    borrower.playaName === expected.playaName &&
    borrower.fullName === expected.fullName &&
    borrower.phoneNumber === expected.phoneNumber &&
    borrower.campDepartment === expected.campDepartment
  );
}

function validCreateValidation(value: unknown, request: BorrowerCreateRequest): boolean {
  return isBorrowerValidationEvidence(value, normalizedCreate(request));
}

function validCreateResult(
  body: Record<string, unknown>,
  key: string,
  request: BorrowerCreateRequest,
): body is Record<string, unknown> & BorrowerCreateResult {
  if ('error' in body && !isString(body.error)) return false;
  if (body.idempotencyKey !== key || !isBoolean(body.replayed)) return false;
  if (body.outcome === 'committed')
    return (
      exactKeys(body, ['outcome', 'idempotencyKey', 'replayed', 'borrower']) &&
      !('error' in body) &&
      validBorrower(body.borrower) &&
      borrowerMatchesRequest(body.borrower, request)
    );
  if (body.outcome !== 'rejected' || !isString(body.message)) return false;
  if (body.error === 'borrower_conflict')
    return (
      exactKeys(body, [
        'error',
        'message',
        'outcome',
        'idempotencyKey',
        'replayed',
        'fieldErrors',
        'matches',
      ]) &&
      body.replayed === false &&
      validCreateValidation(body, request) &&
      (body.fieldErrors as unknown[]).length + (body.matches as unknown[]).length > 0
    );
  if (body.error !== 'borrower_create_attempt_rejected' || body.replayed !== true) return false;
  if (
    !exactKeys(body, [
      'error',
      'message',
      'outcome',
      'idempotencyKey',
      'replayed',
      'currentValidation',
    ])
  )
    return false;
  const validation = body.currentValidation;
  if (!isObject(validation)) return false;
  if (validation.status === 'now_valid')
    return (
      exactKeys(validation, ['status', 'fieldErrors', 'matches']) &&
      Array.isArray(validation.fieldErrors) &&
      validation.fieldErrors.length === 0 &&
      Array.isArray(validation.matches) &&
      validation.matches.length === 0
    );
  return (
    validation.status === 'conflicted' &&
    exactKeys(validation, ['status', 'fieldErrors', 'matches']) &&
    validCreateValidation(validation, request) &&
    (validation.fieldErrors as unknown[]).length + (validation.matches as unknown[]).length > 0
  );
}

async function parseCommandBody(response: Response): Promise<unknown | typeof UNPARSEABLE> {
  try {
    return await response.json();
  } catch {
    return UNPARSEABLE;
  }
}
const UNPARSEABLE = Symbol('unparseable');

export async function classifyBorrowerOperationResponse(
  response: Response,
  context: {
    idempotencyKey: string;
    borrowerId: number;
    request: BorrowerOperationRequest;
    stateRevision: number;
  },
): Promise<CommandClassification<BorrowerOperationResult>> {
  if (response.status === 401 || response.status === 403)
    return { kind: 'authorization', status: response.status };
  if (response.status >= 500)
    return { kind: 'ambiguous', reason: 'server', status: response.status };
  if (
    !isCommandUuid(context.idempotencyKey) ||
    !isSafePositive(context.borrowerId) ||
    !isSafeNonNegative(context.stateRevision) ||
    !isNormalizedBorrowerOperationRequest(context.request)
  )
    return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
  const body = await parseCommandBody(response);
  if (body === UNPARSEABLE)
    return { kind: 'ambiguous', reason: 'unparseable', status: response.status };
  if (!isObject(body))
    return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
  const validStatus = response.status === 201 || response.status === 400 || response.status === 409;
  if (!validStatus) return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
  if (validProtocolError(body, context.idempotencyKey)) {
    if (response.status !== (body.error === 'validation_error' ? 400 : 409))
      return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
    return { kind: 'definitive', status: response.status, result: body as CommandProtocolError };
  }
  if (
    !validOperationResult(
      body,
      context.idempotencyKey,
      context.borrowerId,
      context.request,
      context.stateRevision,
    )
  )
    return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
  if (response.status !== (body.outcome === 'committed' ? 201 : 409))
    return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
  return { kind: 'definitive', status: response.status, result: body };
}

export async function classifyBorrowerCreateResponse(
  response: Response,
  context: { idempotencyKey: string; request: BorrowerCreateRequest },
): Promise<CommandClassification<BorrowerCreateResult>> {
  if (response.status === 401 || response.status === 403)
    return { kind: 'authorization', status: response.status };
  if (response.status >= 500)
    return { kind: 'ambiguous', reason: 'server', status: response.status };
  if (!isCommandUuid(context.idempotencyKey) || !isNormalizedBorrowerCreateRequest(context.request))
    return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
  const body = await parseCommandBody(response);
  if (body === UNPARSEABLE)
    return { kind: 'ambiguous', reason: 'unparseable', status: response.status };
  if (!isObject(body))
    return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
  const validStatus = response.status === 201 || response.status === 400 || response.status === 409;
  if (!validStatus) return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
  if (validProtocolError(body, context.idempotencyKey)) {
    if (response.status !== (body.error === 'validation_error' ? 400 : 409))
      return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
    return { kind: 'definitive', status: response.status, result: body as CommandProtocolError };
  }
  if (!validCreateResult(body, context.idempotencyKey, context.request))
    return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
  if (response.status !== (body.outcome === 'committed' ? 201 : 409))
    return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
  return { kind: 'definitive', status: response.status, result: body };
}

export async function sendClassifiedCommand<T>(
  path: string,
  init: RequestInit,
  classify: (response: Response) => Promise<CommandClassification<T>>,
): Promise<CommandClassification<T>> {
  try {
    const response = await fetch(`/api${path}`, {
      ...init,
      headers: commandHeaders(init.headers),
    });
    const result = await classify(response);
    if (result.kind === 'authorization') window.dispatchEvent(new Event('mapatz-auth-stale'));
    return result;
  } catch {
    return { kind: 'ambiguous', reason: 'network' };
  }
}

async function workflowRead(path: string): Promise<unknown> {
  const response = await fetch(`/api${path}`, { headers: commandHeaders() });
  await requireSuccess(response);
  try {
    return await response.json();
  } catch {
    throw new ApiError(response.status, 'invalid_server_truth', 'השרת החזיר מידע לא תקין');
  }
}

export async function fetchBorrowerSearch(query: string): Promise<BorrowerSearchSnapshot> {
  const value = await workflowRead(`/borrowers/search?q=${encodeURIComponent(query)}`);
  if (!validBorrowerSearchSnapshot(value))
    throw new ApiError(200, 'invalid_server_truth', 'השרת החזיר תוצאות חיפוש לא תקינות');
  return value;
}

export async function fetchBorrowerDeskSnapshot(borrowerId: number): Promise<BorrowerDeskSnapshot> {
  if (!isSafePositive(borrowerId))
    throw new ApiError(400, 'invalid_borrower_id', 'מזהה השואל אינו תקין');
  const value = await workflowRead(`/borrowers/${borrowerId}/desk-snapshot`);
  if (!isBorrowerDeskSnapshot(value, borrowerId))
    throw new ApiError(200, 'invalid_server_truth', 'השרת החזיר כרטיס שואל לא תקין');
  return value;
}

export function sendBorrowerOperationCommand(context: {
  idempotencyKey: string;
  borrowerId: number;
  request: BorrowerOperationRequest;
  stateRevision: number;
}): Promise<CommandClassification<BorrowerOperationResult>> {
  return sendClassifiedCommand(
    `/borrowers/${context.borrowerId}/operations`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': context.idempotencyKey },
      body: JSON.stringify(context.request),
    },
    (response) => classifyBorrowerOperationResponse(response, context),
  );
}

export function sendBorrowerCreateCommand(context: {
  idempotencyKey: string;
  request: BorrowerCreateRequest;
}): Promise<CommandClassification<BorrowerCreateResult>> {
  return sendClassifiedCommand(
    '/borrowers',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': context.idempotencyKey },
      body: JSON.stringify(context.request),
    },
    (response) => classifyBorrowerCreateResponse(response, context),
  );
}

export type ConsumableBatchRequest = {
  ledgerEpoch: number;
  items: Array<{ itemId: number; locationId: number; quantity: number; note: string }>;
};
export type ConsumableBatchResult = {
  outcome: 'committed' | 'rejected';
  idempotencyKey: string;
  replayed: boolean;
  conflicts: Array<{
    itemId: number;
    code:
      | 'item_not_found'
      | 'item_archived'
      | 'wrong_item_kind'
      | 'insufficient_stock'
      | 'invalid_location';
    locationId?: number;
    available?: number;
  }>;
};

export async function sendConsumableBatchCommand(context: {
  idempotencyKey: string;
  request: ConsumableBatchRequest;
}): Promise<
  | CommandClassification<ConsumableBatchResult>
  | { kind: 'stale' }
  | { kind: 'protocol-rejected' }
  | { kind: 'key-conflict' }
> {
  try {
    const response = await fetch('/api/issue-batch', {
      method: 'POST',
      headers: commandHeaders({ 'Idempotency-Key': context.idempotencyKey }),
      body: JSON.stringify(context.request),
    });
    if (response.status === 401 || response.status === 403) {
      window.dispatchEvent(new Event('mapatz-auth-stale'));
      return { kind: 'authorization', status: response.status };
    }
    if (response.status >= 500)
      return { kind: 'ambiguous', reason: 'server', status: response.status };
    const body = await parseCommandBody(response);
    if (
      response.status === 409 &&
      isObject(body) &&
      exactKeys(body, ['error', 'message']) &&
      body.error === 'stale_ledger' &&
      isString(body.message)
    )
      return { kind: 'stale' };
    if (
      response.status === 400 &&
      isObject(body) &&
      exactKeys(body, ['error', 'message', 'fieldErrors']) &&
      body.error === 'validation_error' &&
      isString(body.message) &&
      validFieldErrors(body.fieldErrors)
    )
      return { kind: 'protocol-rejected' };
    if (
      response.status === 409 &&
      isObject(body) &&
      exactKeys(body, ['error', 'message']) &&
      body.error === 'idempotency_conflict' &&
      isString(body.message)
    )
      return { kind: 'key-conflict' };
    if (
      !isObject(body) ||
      !isCommandUuid(context.idempotencyKey) ||
      body.idempotencyKey !== context.idempotencyKey ||
      !isBoolean(body.replayed) ||
      !Array.isArray(body.conflicts) ||
      !exactKeys(body, ['outcome', 'idempotencyKey', 'replayed', 'conflicts'])
    )
      return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
    if (body.outcome !== 'committed' && body.outcome !== 'rejected')
      return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
    if (response.status !== (body.outcome === 'committed' ? 201 : 409))
      return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
    if (body.outcome === 'committed' && body.conflicts.length !== 0)
      return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
    if (body.outcome === 'rejected' && body.conflicts.length === 0)
      return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
    if (
      !body.conflicts.every(
        (conflict) =>
          isObject(conflict) &&
          isSafePositive(conflict.itemId) &&
          context.request.items.some((item) => item.itemId === conflict.itemId) &&
          [
            'item_not_found',
            'item_archived',
            'wrong_item_kind',
            'insufficient_stock',
            'invalid_location',
          ].includes(String(conflict.code)) &&
          (conflict.code === 'insufficient_stock'
            ? exactKeys(conflict, ['itemId', 'locationId', 'code', 'available']) &&
              isSafePositive(conflict.locationId) &&
              context.request.items.some(
                (p) => p.itemId === conflict.itemId && p.locationId === conflict.locationId,
              ) &&
              isSafeNonNegative(conflict.available)
            : conflict.code === 'invalid_location'
              ? exactKeys(conflict, ['itemId', 'locationId', 'code']) &&
                isSafePositive(conflict.locationId)
              : exactKeys(conflict, ['itemId', 'code'])),
      )
    )
      return { kind: 'ambiguous', reason: 'invalid-body', status: response.status };
    return { kind: 'definitive', status: response.status, result: body as ConsumableBatchResult };
  } catch {
    return { kind: 'ambiguous', reason: 'network' };
  }
}

export const sendFrozenBorrowerAttempt: FrozenTransport = (attempt: FrozenAttempt) =>
  attempt.kind === 'operation'
    ? sendBorrowerOperationCommand({
        idempotencyKey: attempt.idempotencyKey,
        borrowerId: attempt.subjectId,
        request: attempt.body,
        stateRevision: attempt.stateRevision,
      })
    : sendBorrowerCreateCommand({
        idempotencyKey: attempt.idempotencyKey,
        request: attempt.body,
      });

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: commandHeaders(init?.headers),
  });
  await requireSuccess(response);
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export function fetchRadios(): Promise<RadioFleet> {
  return api<RadioFleet>('/radios');
}

export function radioCommand(
  path: string,
  method: 'PUT' | 'POST',
  body: object,
): Promise<RadioFleet> {
  return api<RadioFleet>(path, { method, body: JSON.stringify(body) });
}

export function fetchPeriodSummary(start: string, end: string): Promise<PeriodSummary> {
  return api<PeriodSummary>(
    `/period-summary?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
  );
}

function commandHeaders(source?: HeadersInit): Headers {
  const headers = new Headers(source);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return headers;
}

async function requireSuccess(response: Response): Promise<void> {
  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ error: 'request_failed', message: 'הפעולה נכשלה' }));
    if (response.status === 401 || response.status === 403)
      window.dispatchEvent(new Event('mapatz-auth-stale'));
    throw new ApiError(response.status, body.error, body.message);
  }
}

export async function downloadInventoryWorkbook(
  resetAllocationLocation?: string,
): Promise<void | 'cancelled'> {
  const response = await fetch(
    `/api/workbook${resetAllocationLocation ? `?resetAllocationLocation=${encodeURIComponent(resetAllocationLocation)}` : ''}`,
  );
  await requireSuccess(response);
  if (desktop) {
    const result = await desktop.saveWorkbook(new Uint8Array(await response.arrayBuffer()));
    return result === 'cancelled' ? 'cancelled' : undefined;
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? 'mapatz-inventory.xlsx';
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function importResetWorkbook(file: File): Promise<void> {
  const response = await fetch('/api/workbook/reset', {
    method: 'POST',
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'x-mapatz-confirmed': 'true',
    },
    body: file,
  });
  await requireSuccess(response);
}

export async function importRecoveryWorkbook(file: File): Promise<void> {
  const response = await fetch('/api/workbook/recovery', {
    method: 'POST',
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'x-mapatz-confirmed': 'true',
    },
    body: file,
  });
  await requireSuccess(response);
}

export function previewBorrowerImport(
  file: File,
  mode: BorrowerImportMode,
  returnLocationId?: number,
): Promise<BorrowerImportPreview> {
  return api(
    `/borrowers/import/preview?mode=${mode}${returnLocationId ? `&returnLocationId=${returnLocationId}` : ''}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      body: file,
    },
  );
}
export function commitBorrowerImport(
  file: File,
  mode: BorrowerImportMode,
  confirmationToken: string,
  returnLocationId?: number,
): Promise<BorrowerImportResult> {
  return api(
    `/borrowers/import/commit?mode=${mode}${returnLocationId ? `&returnLocationId=${returnLocationId}` : ''}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'x-borrower-import-confirmation': confirmationToken,
      },
      body: file,
    },
  );
}
