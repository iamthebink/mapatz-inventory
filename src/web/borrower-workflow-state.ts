import {
  BORROWER_WORKFLOW_CONTRACT_VERSION,
  type BorrowPart,
  type BorrowerCreateRequest,
  type BorrowerCreateResult,
  type BorrowerDeskSnapshot,
  type BorrowerOperationConflict,
  type BorrowerOperationRequest,
  type BorrowerOperationResult,
  type CommandProtocolError,
  type ReturnPart,
  type ValidationFieldError,
} from '../contracts/borrower-workflow.js';
import type { Borrower } from '../domain/types.js';

export type SaveIntent = 'save' | 'save-and-close';
export type WorkflowFocus = 'item-search' | 'retry-refresh' | 'borrower-search' | 'retry-card';
export type WorkflowFeedback = {
  kind: 'success' | 'warning' | 'error';
  code: string;
  message: string;
};

export type StagedItem = {
  itemId: number;
  borrow: BorrowPart[];
  return: ReturnPart[];
};

type ReadyPhase = { kind: 'ready'; retiredAttemptKey?: string };
type SavingPhase = { kind: 'saving'; attemptKey: string; intent: SaveIntent };
type UnknownPhase = { kind: 'unknown'; attemptKey: string; intent: SaveIntent };
type ConflictedPhase = {
  kind: 'conflicted';
  conflicts: BorrowerOperationConflict[];
  retiredAttemptKey: string;
};
type RefreshRequiredPhase = {
  kind: 'refresh-required';
  intent: SaveIntent;
  attemptKey: string;
  dispatchEpoch: number;
  preDispatchEventId: number;
  refreshId?: string;
};
type ReloadRequiredPhase = {
  kind: 'reload-required';
  attemptKey: string;
  confirmedIntent?: SaveIntent;
  reloadId?: string;
};
type StorageRecoveryPhase = {
  kind: 'storage-recovery';
  attemptKey: string;
  intent: SaveIntent;
  operation: 'persist' | 'clear';
};
type ClosedPhase = { kind: 'closed' };

export type OperationPhase =
  | ReadyPhase
  | SavingPhase
  | UnknownPhase
  | ConflictedPhase
  | RefreshRequiredPhase
  | ReloadRequiredPhase
  | StorageRecoveryPhase
  | ClosedPhase;

export type OperationState = {
  borrowerId: number;
  snapshot: BorrowerDeskSnapshot;
  staged: StagedItem[];
  conflicts: BorrowerOperationConflict[];
  phase: OperationPhase;
  announcement: string | null;
  feedback: WorkflowFeedback | null;
  focus: WorkflowFocus | null;
  unverifiedProjection: ItemProjection[] | null;
  usedRefreshIds: string[];
  usedReloadIds: string[];
  usedAttemptKeys: string[];
};

export type OperationAction =
  | { type: 'stage-borrow'; itemId: number; part: BorrowPart }
  | { type: 'stage-return'; itemId: number; part: ReturnPart }
  | { type: 'update-borrow'; itemId: number; index: number; part: BorrowPart }
  | { type: 'update-return'; itemId: number; index: number; part: ReturnPart }
  | { type: 'rollback'; itemId: number; direction: 'borrow' | 'return' }
  | { type: 'dispatch'; attemptKey: string; intent: SaveIntent }
  | { type: 'dispatch-unknown'; attemptKey: string }
  | {
      type: 'result';
      attemptKey: string;
      result: BorrowerOperationResult | CommandProtocolError;
    }
  | { type: 'authorization'; attemptKey: string }
  | { type: 'ambiguous'; attemptKey: string }
  | { type: 'refresh-started'; refreshId: string }
  | { type: 'refresh-succeeded'; refreshId: string; snapshot: BorrowerDeskSnapshot }
  | { type: 'refresh-failed'; refreshId: string }
  | { type: 'reload-started'; reloadId: string }
  | { type: 'reload-succeeded'; reloadId: string; snapshot: BorrowerDeskSnapshot }
  | { type: 'reload-failed'; reloadId: string }
  | { type: 'storage-failure'; attemptKey: string; operation: 'persist' | 'clear' }
  | { type: 'storage-reconciled'; attemptKey: string; record: 'absent' | 'recoverable' }
  | { type: 'clear-feedback' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
const isSafeNonNegative = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isSafePositive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

function isBorrower(value: unknown): value is Borrower {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'username', 'name', 'contact', 'type', 'archived']) &&
    isSafePositive(value.id) &&
    typeof value.username === 'string' &&
    typeof value.name === 'string' &&
    typeof value.contact === 'string' &&
    ['individual', 'camp_organization', 'other'].includes(String(value.type)) &&
    typeof value.archived === 'boolean'
  );
}

/** Runtime validation for truth entering the client outside the typed reducer boundary. */
export function isBorrowerDeskSnapshot(
  value: unknown,
  expectedBorrowerId?: number,
): value is BorrowerDeskSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['borrower', 'inventory', 'holdings', 'asOfEventId', 'ledgerEpoch']) ||
    !isBorrower(value.borrower)
  )
    return false;
  if (expectedBorrowerId !== undefined && value.borrower.id !== expectedBorrowerId) return false;
  if (!isSafeNonNegative(value.asOfEventId) || !isSafePositive(value.ledgerEpoch)) return false;
  if (!Array.isArray(value.inventory) || !Array.isArray(value.holdings)) return false;

  const itemIds = new Set<number>();
  const itemCodes = new Set<number>();
  for (const item of value.inventory) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, [
        'id',
        'code',
        'name',
        'kind',
        'lotSize',
        'locationId',
        'archived',
        'aliases',
        'available',
        'damaged',
        'selectable',
      ]) ||
      !isSafePositive(item.id) ||
      !isSafePositive(item.code) ||
      typeof item.name !== 'string' ||
      item.kind !== 'non_consumable' ||
      !(item.lotSize === null || isSafePositive(item.lotSize)) ||
      !(item.locationId === null || isSafePositive(item.locationId)) ||
      typeof item.archived !== 'boolean' ||
      !Array.isArray(item.aliases) ||
      !item.aliases.every((alias) => typeof alias === 'string') ||
      !isSafeNonNegative(item.available) ||
      !isSafeNonNegative(item.damaged) ||
      typeof item.selectable !== 'boolean' ||
      item.selectable === item.archived ||
      itemIds.has(Number(item.id)) ||
      itemCodes.has(Number(item.code))
    )
      return false;
    itemIds.add(Number(item.id));
    itemCodes.add(Number(item.code));
  }
  const holdingIds = new Set<number>();
  for (const holding of value.holdings) {
    if (
      !isRecord(holding) ||
      !hasExactKeys(holding, ['itemId', 'returnable', 'lost']) ||
      !isSafePositive(holding.itemId) ||
      !isSafeNonNegative(holding.returnable) ||
      !isSafeNonNegative(holding.lost) ||
      holding.returnable + holding.lost <= 0 ||
      !Number.isSafeInteger(holding.returnable + holding.lost) ||
      holdingIds.has(holding.itemId) ||
      !itemIds.has(holding.itemId)
    )
      return false;
    holdingIds.add(holding.itemId);
  }
  return true;
}

function cloneBorrower(borrower: Borrower): Borrower {
  return { ...borrower };
}

function cloneSnapshot(snapshot: BorrowerDeskSnapshot): BorrowerDeskSnapshot {
  return {
    borrower: cloneBorrower(snapshot.borrower),
    inventory: snapshot.inventory.map((item) => ({ ...item, aliases: [...item.aliases] })),
    holdings: snapshot.holdings.map((holding) => ({ ...holding })),
    asOfEventId: snapshot.asOfEventId,
    ledgerEpoch: snapshot.ledgerEpoch,
  };
}

function cloneConflicts(conflicts: BorrowerOperationConflict[]): BorrowerOperationConflict[] {
  return conflicts.map((conflict) => ({ ...conflict }));
}

export function createOperationState(
  borrowerId: number,
  snapshot: BorrowerDeskSnapshot,
): OperationState {
  if (!isSafePositive(borrowerId) || !isBorrowerDeskSnapshot(snapshot, borrowerId))
    throw new Error('Invalid borrower desk snapshot');
  return {
    borrowerId,
    snapshot: cloneSnapshot(snapshot),
    staged: [],
    conflicts: [],
    phase: { kind: 'ready' },
    announcement: null,
    feedback: null,
    focus: null,
    unverifiedProjection: null,
    usedRefreshIds: [],
    usedReloadIds: [],
    usedAttemptKeys: [],
  };
}

const totalBorrow = (parts: BorrowPart[]): number | null =>
  safeSum(parts.map((part) => part.quantity));
const totalReturn = (parts: ReturnPart[]): number | null =>
  safeSum(parts.flatMap((part) => [part.usable, part.damaged]));
const usableReturn = (parts: ReturnPart[]): number | null =>
  safeSum(parts.map((part) => part.usable));

function safeSum(values: number[]): number | null {
  let result = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) return null;
    result += value;
    if (!Number.isSafeInteger(result)) return null;
  }
  return result;
}

function safeArithmetic(...values: number[]): number | null {
  return safeSum(values);
}

function validBorrow(part: BorrowPart): boolean {
  return isSafePositive(part.quantity) && typeof part.note === 'string' && part.note.length <= 500;
}

function validReturn(part: ReturnPart): boolean {
  return (
    isSafeNonNegative(part.usable) &&
    isSafeNonNegative(part.damaged) &&
    part.usable + part.damaged > 0 &&
    Number.isSafeInteger(part.usable + part.damaged) &&
    typeof part.note === 'string' &&
    part.note.length <= 500
  );
}

function editable(state: OperationState): boolean {
  return state.phase.kind === 'ready' || state.phase.kind === 'conflicted';
}

function retiredKey(phase: OperationPhase): string | undefined {
  return phase.kind === 'ready' || phase.kind === 'conflicted'
    ? phase.retiredAttemptKey
    : undefined;
}

function itemName(state: OperationState, itemId: number): string {
  return state.snapshot.inventory.find((item) => item.id === itemId)?.name ?? `#${itemId}`;
}

function holdingAfter(state: OperationState, itemId: number, staged = state.staged): number | null {
  const base =
    state.snapshot.holdings.find((holding) => holding.itemId === itemId)?.returnable ?? 0;
  const group = staged.find((entry) => entry.itemId === itemId);
  const borrowed = totalBorrow(group?.borrow ?? []);
  const returned = totalReturn(group?.return ?? []);
  return borrowed === null || returned === null ? null : safeArithmetic(base, -returned, borrowed);
}

function announcement(
  state: OperationState,
  itemId: number,
  direction: 'borrow' | 'return',
  quantity: number,
  staged: StagedItem[],
): string | null {
  const resulting = holdingAfter(state, itemId, staged);
  if (resulting === null) return null;
  const directionLabel = direction === 'borrow' ? 'השאלה' : 'החזרה';
  return `${itemName(state, itemId)}: ${directionLabel}, כמות ${quantity}; באחריות השואל כעת ${resulting}`;
}

function updateGroup(
  staged: StagedItem[],
  itemId: number,
  update: (group: StagedItem) => StagedItem,
): StagedItem[] {
  const index = staged.findIndex((group) => group.itemId === itemId);
  if (index < 0) return [...staged, update({ itemId, borrow: [], return: [] })];
  return staged.map((group, position) => (position === index ? update(group) : group));
}

function retainNonEmpty(staged: StagedItem[]): StagedItem[] {
  return staged.filter((group) => group.borrow.length > 0 || group.return.length > 0);
}

export type ItemProjection = {
  itemId: number;
  borrowParts: BorrowPart[];
  returnParts: ReturnPart[];
  comments: string[];
  stagedBorrow: number;
  stagedReturn: number;
  projectedHeld: number;
  returnableNow: number;
  lost: number;
  projectedAvailability: number;
  compatible: boolean;
  conflicts: BorrowerOperationConflict[];
};

export function projectedItems(state: OperationState): ItemProjection[] {
  const itemIds = new Set(state.snapshot.inventory.map((item) => item.id));
  for (const group of state.staged) itemIds.add(group.itemId);
  for (const conflict of state.conflicts)
    if (conflict.scope !== 'borrower') itemIds.add(conflict.itemId);
  return [...itemIds]
    .map((itemId) => projectItem(state, itemId))
    .filter((projection): projection is ItemProjection => projection !== null);
}

export function projectItem(state: OperationState, itemId: number): ItemProjection | null {
  const item = state.snapshot.inventory.find((candidate) => candidate.id === itemId);
  const holding = state.snapshot.holdings.find((candidate) => candidate.itemId === itemId);
  const group = state.staged.find((candidate) => candidate.itemId === itemId);
  const scopedConflicts = state.conflicts.filter(
    (conflict) => conflict.scope === 'borrower' || conflict.itemId === itemId,
  );
  if (!item && !group && scopedConflicts.length === 0) return null;
  const borrowed = totalBorrow(group?.borrow ?? []);
  const returned = totalReturn(group?.return ?? []);
  const usable = usableReturn(group?.return ?? []);
  const baseReturnable = holding?.returnable ?? 0;
  const lost = holding?.lost ?? 0;
  const conflicts = scopedConflicts.filter((conflict) => {
    if (conflict.scope === 'return') return returned !== null && returned > baseReturnable;
    if (conflict.scope === 'borrow') {
      if (!item || borrowed === null || usable === null) return true;
      const usableCredit = returned !== null && returned <= baseReturnable ? usable : 0;
      const available = safeArithmetic(item.available, usableCredit);
      return available === null || borrowed > available;
    }
    return true;
  });
  const projectedHeld =
    borrowed === null || returned === null
      ? null
      : safeArithmetic(baseReturnable, -returned, borrowed);
  const returnableNow = returned === null ? null : safeArithmetic(baseReturnable, -returned);
  const returnBlocked = conflicts.some(
    (conflict) =>
      conflict.scope === 'borrower' || conflict.scope === 'item' || conflict.scope === 'return',
  );
  const returnCompatible =
    item !== undefined &&
    item.selectable &&
    item.kind === 'non_consumable' &&
    !item.archived &&
    returned !== null &&
    returnableNow !== null &&
    returnableNow >= 0 &&
    !returnBlocked &&
    (group?.return ?? []).every(validReturn);
  const projectedAvailability =
    borrowed === null || usable === null
      ? null
      : safeArithmetic(item?.available ?? 0, returnCompatible ? usable : 0, -borrowed);
  const compatible =
    item !== undefined &&
    item.selectable &&
    item.kind === 'non_consumable' &&
    !item.archived &&
    borrowed !== null &&
    returned !== null &&
    usable !== null &&
    projectedHeld !== null &&
    returnableNow !== null &&
    projectedAvailability !== null &&
    returnableNow >= 0 &&
    projectedAvailability >= 0 &&
    conflicts.length === 0;
  return {
    itemId,
    borrowParts: (group?.borrow ?? []).map((part) => ({ ...part })),
    returnParts: (group?.return ?? []).map((part) => ({ ...part })),
    comments: [
      ...(group?.borrow ?? []).map((part) => part.note),
      ...(group?.return ?? []).map((part) => part.note),
    ],
    stagedBorrow: borrowed ?? 0,
    stagedReturn: returned ?? 0,
    projectedHeld: projectedHeld ?? 0,
    returnableNow: returnableNow ?? 0,
    lost,
    projectedAvailability: projectedAvailability ?? 0,
    compatible,
    conflicts,
  };
}

function clearDirectionalConflict(
  conflicts: BorrowerOperationConflict[],
  itemId: number,
  direction: 'borrow' | 'return',
): BorrowerOperationConflict[] {
  return conflicts.filter(
    (conflict) => !(conflict.scope === direction && conflict.itemId === itemId),
  );
}

export function operationRequest(state: OperationState): BorrowerOperationRequest {
  return {
    contractVersion: 1,
    ledgerEpoch: state.snapshot.ledgerEpoch,
    items: state.staged.map((group) => ({
      itemId: group.itemId,
      ...(group.borrow.length > 0 ? { borrow: group.borrow.map((part) => ({ ...part })) } : {}),
      ...(group.return.length > 0 ? { return: group.return.map((part) => ({ ...part })) } : {}),
    })),
  };
}

export function canSave(state: OperationState): boolean {
  if (state.phase.kind !== 'ready' && state.phase.kind !== 'conflicted') return false;
  if (state.staged.length === 0) return false;
  if (state.snapshot.borrower.archived) return false;
  if (
    safeSum(state.staged.flatMap((group) => group.borrow.map((part) => part.quantity))) === null ||
    safeSum(
      state.staged.flatMap((group) => group.return.map((part) => part.usable + part.damaged)),
    ) === null ||
    safeSum(state.staged.flatMap((group) => group.return.map((part) => part.usable))) === null
  )
    return false;
  return state.staged.every((group) => {
    if (!group.borrow.every(validBorrow) || !group.return.every(validReturn)) return false;
    return projectItem(state, group.itemId)?.compatible === true;
  });
}

export function operationLocks(state: OperationState): { mutation: boolean; exit: boolean } {
  const frozen = ['saving', 'unknown', 'storage-recovery'].includes(state.phase.kind);
  if (state.phase.kind === 'refresh-required' && state.phase.intent === 'save-and-close')
    return { mutation: true, exit: false };
  return {
    mutation:
      frozen || ['refresh-required', 'reload-required', 'closed'].includes(state.phase.kind),
    exit: frozen,
  };
}

export function operationPresentation(state: OperationState): {
  cardOpen: boolean;
  searchEnabled: boolean;
} {
  const closeRecovery =
    (state.phase.kind === 'refresh-required' && state.phase.intent === 'save-and-close') ||
    (state.phase.kind === 'reload-required' && state.phase.confirmedIntent === 'save-and-close');
  return {
    cardOpen: !closeRecovery && state.phase.kind !== 'closed',
    searchEnabled: !closeRecovery,
  };
}

function matchingAttempt(state: OperationState, key: string): SavingPhase | UnknownPhase | null {
  const phase = state.phase;
  return (phase.kind === 'saving' || phase.kind === 'unknown') && phase.attemptKey === key
    ? phase
    : null;
}

function withoutRefreshIdentity(phase: RefreshRequiredPhase): RefreshRequiredPhase {
  return {
    kind: 'refresh-required',
    intent: phase.intent,
    attemptKey: phase.attemptKey,
    dispatchEpoch: phase.dispatchEpoch,
    preDispatchEventId: phase.preDispatchEventId,
  };
}

function acceptableConflictSnapshot(
  state: OperationState,
  snapshot: BorrowerDeskSnapshot,
): boolean {
  return (
    isBorrowerDeskSnapshot(snapshot, state.borrowerId) &&
    snapshot.ledgerEpoch === state.snapshot.ledgerEpoch &&
    snapshot.asOfEventId >= state.snapshot.asOfEventId
  );
}

function conflictsBelongToState(
  state: OperationState,
  conflicts: BorrowerOperationConflict[],
  snapshot: BorrowerDeskSnapshot,
): boolean {
  if (conflicts.length === 0) return false;
  const request = operationRequest(state);
  const seen = new Set<string>();
  return conflicts.every((conflict) => {
    const identity = JSON.stringify(conflict);
    if (seen.has(identity)) return false;
    seen.add(identity);
    if (conflict.scope === 'borrower')
      return conflict.borrowerId === state.borrowerId && snapshot.borrower.archived;
    const group = request.items.find((item) => item.itemId === conflict.itemId);
    if (!group) return false;
    const item = snapshot.inventory.find((candidate) => candidate.id === conflict.itemId);
    if (conflict.scope === 'item')
      return conflict.code === 'item_archived' ? item?.archived === true : item === undefined;
    if (conflict.scope === 'return') {
      const requested = totalReturn(group.return ?? []);
      const returnable =
        snapshot.holdings.find((holding) => holding.itemId === conflict.itemId)?.returnable ?? 0;
      return (
        requested === conflict.requested &&
        conflict.returnable === returnable &&
        requested > returnable
      );
    }
    const requested = totalBorrow(group.borrow ?? []);
    const usable = usableReturn(group.return ?? []);
    const available = item && usable !== null ? safeArithmetic(item.available, usable) : null;
    return (
      requested === conflict.requested &&
      available === conflict.availableAfterUsableReturns &&
      requested !== null &&
      available !== null &&
      requested > available
    );
  });
}

export function operationReducer(state: OperationState, action: OperationAction): OperationState {
  if (action.type === 'clear-feedback') return { ...state, feedback: null, focus: null };
  if (action.type === 'stage-borrow' && editable(state) && validBorrow(action.part)) {
    const ownedPart = { ...action.part };
    const staged = updateGroup(state.staged, action.itemId, (group) => ({
      ...group,
      borrow: [...group.borrow, ownedPart],
    }));
    return {
      ...state,
      staged,
      conflicts: clearDirectionalConflict(state.conflicts, action.itemId, 'borrow'),
      phase: { kind: 'ready', retiredAttemptKey: retiredKey(state.phase) },
      announcement: announcement(state, action.itemId, 'borrow', action.part.quantity, staged),
    };
  }
  if (action.type === 'stage-return' && editable(state) && validReturn(action.part)) {
    const ownedPart = { ...action.part };
    const quantity = action.part.usable + action.part.damaged;
    const staged = updateGroup(state.staged, action.itemId, (group) => ({
      ...group,
      return: [...group.return, ownedPart],
    }));
    return {
      ...state,
      staged,
      conflicts: clearDirectionalConflict(state.conflicts, action.itemId, 'return'),
      phase: { kind: 'ready', retiredAttemptKey: retiredKey(state.phase) },
      announcement: announcement(state, action.itemId, 'return', quantity, staged),
    };
  }
  if (
    (action.type === 'update-borrow' || action.type === 'update-return') &&
    (!editable(state) || !Number.isInteger(action.index) || action.index < 0)
  )
    return state;
  if (action.type === 'update-borrow' && validBorrow(action.part)) {
    const group = state.staged.find((candidate) => candidate.itemId === action.itemId);
    if (!group || action.index >= group.borrow.length) return state;
    const ownedPart = { ...action.part };
    const staged = updateGroup(state.staged, action.itemId, (entry) => ({
      ...entry,
      borrow: entry.borrow.map((part, index) => (index === action.index ? ownedPart : part)),
    }));
    return {
      ...state,
      staged,
      conflicts: clearDirectionalConflict(state.conflicts, action.itemId, 'borrow'),
      phase: { kind: 'ready', retiredAttemptKey: retiredKey(state.phase) },
      announcement: announcement(state, action.itemId, 'borrow', action.part.quantity, staged),
    };
  }
  if (action.type === 'update-return' && validReturn(action.part)) {
    const group = state.staged.find((candidate) => candidate.itemId === action.itemId);
    if (!group || action.index >= group.return.length) return state;
    const ownedPart = { ...action.part };
    const staged = updateGroup(state.staged, action.itemId, (entry) => ({
      ...entry,
      return: entry.return.map((part, index) => (index === action.index ? ownedPart : part)),
    }));
    const quantity = action.part.usable + action.part.damaged;
    return {
      ...state,
      staged,
      conflicts: clearDirectionalConflict(state.conflicts, action.itemId, 'return'),
      phase: { kind: 'ready', retiredAttemptKey: retiredKey(state.phase) },
      announcement: announcement(state, action.itemId, 'return', quantity, staged),
    };
  }
  if (action.type === 'rollback' && editable(state)) {
    const group = state.staged.find((candidate) => candidate.itemId === action.itemId);
    if (!group) return state;
    const quantity =
      action.direction === 'borrow' ? totalBorrow(group.borrow) : totalReturn(group.return);
    if (quantity === null || quantity === 0) return state;
    const staged = retainNonEmpty(
      updateGroup(state.staged, action.itemId, (entry) => ({
        ...entry,
        [action.direction]: [],
      })),
    );
    return {
      ...state,
      staged,
      conflicts: clearDirectionalConflict(state.conflicts, action.itemId, action.direction),
      phase: { kind: 'ready', retiredAttemptKey: retiredKey(state.phase) },
      announcement: announcement(state, action.itemId, action.direction, quantity, staged),
    };
  }
  if (action.type === 'dispatch') {
    if (!canSave(state) || !validUuid(action.attemptKey)) return state;
    const retired = retiredKey(state.phase);
    if (retired === action.attemptKey || state.usedAttemptKeys.includes(action.attemptKey))
      return state;
    return {
      ...state,
      phase: { kind: 'saving', attemptKey: action.attemptKey, intent: action.intent },
      usedAttemptKeys: [...state.usedAttemptKeys, action.attemptKey],
      feedback: null,
      focus: null,
    };
  }
  if (action.type === 'dispatch-unknown') {
    return state.phase.kind === 'unknown' && state.phase.attemptKey === action.attemptKey
      ? state
      : state;
  }
  if (action.type === 'ambiguous') {
    const phase = matchingAttempt(state, action.attemptKey);
    return phase
      ? {
          ...state,
          phase: { kind: 'unknown', attemptKey: phase.attemptKey, intent: phase.intent },
          feedback: {
            kind: 'warning',
            code: 'outcome_unknown',
            message: 'Command outcome unknown',
          },
        }
      : state;
  }
  if (action.type === 'authorization') {
    const phase = matchingAttempt(state, action.attemptKey);
    if (!phase) return state;
    if (phase.kind === 'unknown')
      return {
        ...state,
        feedback: {
          kind: 'error',
          code: 'authorization_required',
          message: 'Authorization required',
        },
      };
    return {
      ...state,
      phase: { kind: 'ready' },
      feedback: {
        kind: 'error',
        code: 'authorization_required',
        message: 'Authorization required',
      },
    };
  }
  if (action.type === 'result') {
    const phase = matchingAttempt(state, action.attemptKey);
    if (!phase) return state;
    const result = action.result;
    if ('idempotencyKey' in result && result.idempotencyKey !== action.attemptKey) return state;
    if ('error' in result && result.error === 'ledger_epoch_changed')
      return {
        ...state,
        phase: { kind: 'reload-required', attemptKey: action.attemptKey },
        feedback: { kind: 'warning', code: result.error, message: result.message },
        focus: 'borrower-search',
      };
    if ('error' in result && result.error === 'validation_error')
      return {
        ...state,
        phase: { kind: 'ready', retiredAttemptKey: action.attemptKey },
        feedback: { kind: 'error', code: result.error, message: result.message },
      };
    if ('error' in result && result.error === 'idempotency_key_reused')
      return {
        ...state,
        phase: { kind: 'ready', retiredAttemptKey: action.attemptKey },
        feedback: { kind: 'error', code: result.error, message: result.message },
      };
    if ('outcome' in result && result.outcome === 'committed')
      return {
        ...state,
        staged: [],
        phase: {
          kind: 'refresh-required',
          intent: phase.intent,
          attemptKey: phase.attemptKey,
          dispatchEpoch: state.snapshot.ledgerEpoch,
          preDispatchEventId: state.snapshot.asOfEventId,
        },
        unverifiedProjection: projectedItems(state),
        feedback: null,
      };
    if ('error' in result && result.error === 'borrower_operation_conflict') {
      if (
        !acceptableConflictSnapshot(state, result.snapshot) ||
        !conflictsBelongToState(state, result.conflicts, result.snapshot)
      )
        return state;
      const ownedSnapshot = cloneSnapshot(result.snapshot);
      const ownedConflicts = cloneConflicts(result.conflicts);
      return {
        ...state,
        snapshot: ownedSnapshot,
        conflicts: ownedConflicts,
        phase: {
          kind: 'conflicted',
          conflicts: cloneConflicts(ownedConflicts),
          retiredAttemptKey: action.attemptKey,
        },
        feedback: { kind: 'warning', code: result.error, message: result.message },
      };
    }
    if ('error' in result && result.error === 'borrower_operation_attempt_rejected') {
      const validation = result.currentValidation;
      if (!acceptableConflictSnapshot(state, validation.snapshot)) return state;
      const ownedSnapshot = cloneSnapshot(validation.snapshot);
      if (validation.status === 'now_valid')
        return {
          ...state,
          snapshot: ownedSnapshot,
          conflicts: [],
          phase: { kind: 'ready', retiredAttemptKey: action.attemptKey },
          feedback: { kind: 'warning', code: result.error, message: result.message },
        };
      if (!conflictsBelongToState(state, validation.conflicts, validation.snapshot)) return state;
      const ownedConflicts = cloneConflicts(validation.conflicts);
      return {
        ...state,
        snapshot: ownedSnapshot,
        conflicts: ownedConflicts,
        phase: {
          kind: 'conflicted',
          conflicts: cloneConflicts(ownedConflicts),
          retiredAttemptKey: action.attemptKey,
        },
        feedback: { kind: 'warning', code: result.error, message: result.message },
      };
    }
    return state;
  }
  if (action.type === 'refresh-started') {
    if (
      state.phase.kind !== 'refresh-required' ||
      state.phase.refreshId ||
      !validUuid(action.refreshId) ||
      state.usedRefreshIds.includes(action.refreshId)
    )
      return state;
    return {
      ...state,
      phase: { ...state.phase, refreshId: action.refreshId },
      usedRefreshIds: [...state.usedRefreshIds, action.refreshId],
      feedback: null,
    };
  }
  if (action.type === 'refresh-succeeded') {
    if (state.phase.kind !== 'refresh-required' || state.phase.refreshId !== action.refreshId)
      return state;
    if (
      !isBorrowerDeskSnapshot(action.snapshot, state.borrowerId) ||
      action.snapshot.ledgerEpoch !== state.phase.dispatchEpoch ||
      action.snapshot.asOfEventId <= state.phase.preDispatchEventId
    )
      return {
        ...state,
        phase:
          isBorrowerDeskSnapshot(action.snapshot, state.borrowerId) &&
          action.snapshot.ledgerEpoch !== state.phase.dispatchEpoch
            ? {
                kind: 'reload-required',
                attemptKey: state.phase.attemptKey,
                confirmedIntent: state.phase.intent,
              }
            : withoutRefreshIdentity(state.phase),
        feedback: { kind: 'warning', code: 'refresh_required', message: 'Refresh required' },
        focus: state.phase.intent === 'save' ? 'retry-refresh' : 'borrower-search',
      };
    return {
      ...state,
      snapshot: cloneSnapshot(action.snapshot),
      conflicts: [],
      phase: state.phase.intent === 'save' ? { kind: 'ready' } : { kind: 'closed' },
      unverifiedProjection: null,
      feedback: { kind: 'success', code: 'operation_saved', message: 'Operation saved' },
      focus: state.phase.intent === 'save' ? 'item-search' : 'borrower-search',
    };
  }
  if (action.type === 'refresh-failed') {
    if (state.phase.kind !== 'refresh-required' || state.phase.refreshId !== action.refreshId)
      return state;
    return {
      ...state,
      phase: {
        kind: 'refresh-required',
        intent: state.phase.intent,
        attemptKey: state.phase.attemptKey,
        dispatchEpoch: state.phase.dispatchEpoch,
        preDispatchEventId: state.phase.preDispatchEventId,
      },
      feedback: { kind: 'warning', code: 'refresh_required', message: 'Refresh required' },
      focus: state.phase.intent === 'save' ? 'retry-refresh' : 'borrower-search',
    };
  }
  if (action.type === 'reload-started') {
    if (
      state.phase.kind !== 'reload-required' ||
      state.phase.reloadId ||
      !validUuid(action.reloadId) ||
      state.usedReloadIds.includes(action.reloadId)
    )
      return state;
    return {
      ...state,
      phase: { ...state.phase, reloadId: action.reloadId },
      usedReloadIds: [...state.usedReloadIds, action.reloadId],
      feedback: null,
    };
  }
  if (action.type === 'reload-succeeded') {
    if (
      state.phase.kind !== 'reload-required' ||
      state.phase.reloadId !== action.reloadId ||
      !isBorrowerDeskSnapshot(action.snapshot, state.borrowerId) ||
      action.snapshot.ledgerEpoch <= state.snapshot.ledgerEpoch
    )
      return state;
    return {
      ...state,
      snapshot: cloneSnapshot(action.snapshot),
      staged: [],
      conflicts: [],
      phase:
        state.phase.confirmedIntent === 'save-and-close' ? { kind: 'closed' } : { kind: 'ready' },
      announcement: null,
      feedback: state.phase.confirmedIntent
        ? { kind: 'success', code: 'operation_saved', message: 'Operation saved' }
        : null,
      focus: state.phase.confirmedIntent === 'save-and-close' ? 'borrower-search' : 'item-search',
      unverifiedProjection: null,
    };
  }
  if (action.type === 'reload-failed') {
    if (state.phase.kind !== 'reload-required' || state.phase.reloadId !== action.reloadId)
      return state;
    return {
      ...state,
      phase: {
        kind: 'reload-required',
        attemptKey: state.phase.attemptKey,
        confirmedIntent: state.phase.confirmedIntent,
      },
      feedback: { kind: 'error', code: 'reload_required', message: 'Reload required' },
      focus: 'borrower-search',
    };
  }
  if (action.type === 'storage-failure') {
    const phase = matchingAttempt(state, action.attemptKey);
    if (!phase) return state;
    return {
      ...state,
      phase: {
        kind: 'storage-recovery',
        attemptKey: phase.attemptKey,
        intent: phase.intent,
        operation: action.operation,
      },
      feedback: {
        kind: 'error',
        code: `storage_${action.operation}_failed`,
        message: 'Storage failure',
      },
      focus: null,
    };
  }
  if (
    action.type === 'storage-reconciled' &&
    state.phase.kind === 'storage-recovery' &&
    state.phase.attemptKey === action.attemptKey
  ) {
    if (action.record === 'recoverable')
      return {
        ...state,
        phase: {
          kind: 'unknown',
          attemptKey: state.phase.attemptKey,
          intent: state.phase.intent,
        },
      };
    return { ...state, phase: { kind: 'ready' }, feedback: null };
  }
  return state;
}

export type CreationPhase =
  | { kind: 'editing'; retiredAttemptKey?: string }
  | { kind: 'pending'; attemptKey: string }
  | { kind: 'unknown'; attemptKey: string }
  | {
      kind: 'conflicted';
      validation: Extract<BorrowerCreateResult, { outcome: 'rejected' }>;
      retiredAttemptKey: string;
    }
  | { kind: 'committed'; borrower: Borrower; ledgerEpoch: number; loadId: string }
  | { kind: 'card-load-failed'; borrower: Borrower; ledgerEpoch: number; loadId: string }
  | { kind: 'opened'; borrower: Borrower; snapshot: BorrowerDeskSnapshot }
  | { kind: 'reload-required'; attemptKey: string; reloadId?: string }
  | {
      kind: 'storage-recovery';
      attemptKey: string;
      operation: 'persist' | 'clear';
    };

export type CreationState = {
  values: BorrowerCreateRequest;
  phase: CreationPhase;
  fieldErrors: ValidationFieldError[];
  feedback: WorkflowFeedback | null;
  focus: WorkflowFocus | null;
  openCardBorrower: Borrower | null;
  openCardSnapshot: BorrowerDeskSnapshot | null;
  usedLoadIds: string[];
  usedReloadIds: string[];
  usedAttemptKeys: string[];
};

export type CreationAction =
  | {
      type: 'change';
      field: 'username' | 'name' | 'contact' | 'type';
      value: string;
    }
  | { type: 'dispatch'; attemptKey: string }
  | { type: 'ambiguous'; attemptKey: string }
  | { type: 'authorization'; attemptKey: string }
  | {
      type: 'result';
      attemptKey: string;
      result: BorrowerCreateResult | CommandProtocolError;
      loadId?: string;
    }
  | { type: 'card-load-retry'; loadId: string }
  | { type: 'card-loaded'; loadId: string; snapshot: BorrowerDeskSnapshot }
  | { type: 'card-load-failed'; loadId: string }
  | { type: 'reload-started'; reloadId: string }
  | { type: 'reload-succeeded'; reloadId: string; ledgerEpoch: number }
  | { type: 'reload-failed'; reloadId: string }
  | { type: 'storage-failure'; attemptKey: string; operation: 'persist' | 'clear' }
  | { type: 'storage-reconciled'; attemptKey: string; record: 'absent' | 'recoverable' };

export function createCreationState(values: BorrowerCreateRequest): CreationState {
  return {
    values: { ...values },
    phase: { kind: 'editing' },
    fieldErrors: [],
    feedback: null,
    focus: null,
    openCardBorrower: null,
    openCardSnapshot: null,
    usedLoadIds: [],
    usedReloadIds: [],
    usedAttemptKeys: [],
  };
}

function sameBorrowerIdentity(left: Borrower, right: Borrower): boolean {
  return (
    left.id === right.id &&
    left.username === right.username &&
    left.name === right.name &&
    left.contact === right.contact &&
    left.type === right.type &&
    left.archived === right.archived
  );
}

function creationAttempt(state: CreationState, key: string): 'pending' | 'unknown' | null {
  return (state.phase.kind === 'pending' || state.phase.kind === 'unknown') &&
    state.phase.attemptKey === key
    ? state.phase.kind
    : null;
}

export function creationReducer(state: CreationState, action: CreationAction): CreationState {
  if (action.type === 'change') {
    if (state.phase.kind !== 'editing' && state.phase.kind !== 'conflicted') return state;
    if (
      action.field === 'type' &&
      !['individual', 'camp_organization', 'other'].includes(action.value)
    )
      return state;
    return {
      ...state,
      values: { ...state.values, [action.field]: action.value },
      phase: { kind: 'editing', retiredAttemptKey: state.phase.retiredAttemptKey },
      fieldErrors: state.fieldErrors.filter((error) => error.field !== action.field),
    } as CreationState;
  }
  if (action.type === 'dispatch') {
    if (
      !validUuid(action.attemptKey) ||
      !validCreationRequest(state.values) ||
      (state.phase.kind !== 'editing' && state.phase.kind !== 'conflicted')
    )
      return state;
    if (
      state.phase.retiredAttemptKey === action.attemptKey ||
      state.usedAttemptKeys.includes(action.attemptKey)
    )
      return state;
    return {
      ...state,
      phase: { kind: 'pending', attemptKey: action.attemptKey },
      usedAttemptKeys: [...state.usedAttemptKeys, action.attemptKey],
      feedback: null,
    };
  }
  if (action.type === 'ambiguous' && creationAttempt(state, action.attemptKey))
    return {
      ...state,
      phase: { kind: 'unknown', attemptKey: action.attemptKey },
      feedback: { kind: 'warning', code: 'outcome_unknown', message: 'Command outcome unknown' },
    };
  if (action.type === 'authorization') {
    const phase = creationAttempt(state, action.attemptKey);
    if (!phase) return state;
    if (phase === 'unknown')
      return {
        ...state,
        feedback: {
          kind: 'error',
          code: 'authorization_required',
          message: 'Authorization required',
        },
      };
    return {
      ...state,
      phase: { kind: 'editing' },
      feedback: {
        kind: 'error',
        code: 'authorization_required',
        message: 'Authorization required',
      },
    };
  }
  if (action.type === 'result') {
    if (!creationAttempt(state, action.attemptKey)) return state;
    const result = action.result;
    if ('idempotencyKey' in result && result.idempotencyKey !== action.attemptKey) return state;
    if ('error' in result && result.error === 'validation_error')
      return {
        ...state,
        phase: { kind: 'editing', retiredAttemptKey: action.attemptKey },
        fieldErrors: result.fieldErrors.map((error) => ({ ...error })),
        feedback: { kind: 'error', code: result.error, message: result.message },
      };
    if ('error' in result && result.error === 'ledger_epoch_changed')
      return {
        ...state,
        phase: { kind: 'reload-required', attemptKey: action.attemptKey },
        feedback: { kind: 'error', code: result.error, message: result.message },
        focus: 'borrower-search',
      };
    if ('error' in result && result.error === 'idempotency_key_reused')
      return {
        ...state,
        phase: { kind: 'editing', retiredAttemptKey: action.attemptKey },
        feedback: { kind: 'error', code: result.error, message: result.message },
      };
    if ('outcome' in result && result.outcome === 'committed') {
      const expected = state.values;
      if (
        !action.loadId ||
        !validUuid(action.loadId) ||
        state.usedLoadIds.includes(action.loadId) ||
        result.borrower.archived ||
        result.borrower.username !== expected.username.trim() ||
        result.borrower.name !== expected.name.trim() ||
        result.borrower.contact !== expected.contact.trim() ||
        result.borrower.type !== expected.type
      )
        return state;
      return {
        ...state,
        phase: {
          kind: 'committed',
          borrower: cloneBorrower(result.borrower),
          ledgerEpoch: state.values.ledgerEpoch,
          loadId: action.loadId,
        },
        usedLoadIds: [...state.usedLoadIds, action.loadId],
        fieldErrors: [],
        feedback: { kind: 'success', code: 'borrower_created', message: 'Borrower created' },
      };
    }
    if ('outcome' in result && result.outcome === 'rejected') {
      const validation = 'currentValidation' in result ? result.currentValidation : null;
      if (validation?.status === 'now_valid')
        return {
          ...state,
          phase: { kind: 'editing', retiredAttemptKey: action.attemptKey },
          fieldErrors: [],
          feedback: { kind: 'warning', code: result.error, message: result.message },
        };
      const fieldErrors =
        'currentValidation' in result ? result.currentValidation.fieldErrors : result.fieldErrors;
      return {
        ...state,
        phase: {
          kind: 'conflicted',
          validation: structuredClone(result),
          retiredAttemptKey: action.attemptKey,
        },
        fieldErrors: fieldErrors.map((error) => ({ ...error })),
        feedback: { kind: 'warning', code: result.error, message: result.message },
      };
    }
  }
  if (action.type === 'card-load-retry') {
    if (
      state.phase.kind !== 'card-load-failed' ||
      !validUuid(action.loadId) ||
      state.usedLoadIds.includes(action.loadId)
    )
      return state;
    return {
      ...state,
      phase: {
        kind: 'committed',
        borrower: cloneBorrower(state.phase.borrower),
        ledgerEpoch: state.phase.ledgerEpoch,
        loadId: action.loadId,
      },
      usedLoadIds: [...state.usedLoadIds, action.loadId],
      feedback: null,
    };
  }
  if (action.type === 'card-loaded') {
    if (state.phase.kind !== 'committed' || state.phase.loadId !== action.loadId) return state;
    if (
      !isBorrowerDeskSnapshot(action.snapshot, state.phase.borrower.id) ||
      action.snapshot.ledgerEpoch !== state.phase.ledgerEpoch ||
      !sameBorrowerIdentity(action.snapshot.borrower, state.phase.borrower)
    )
      return {
        ...state,
        phase: {
          kind: 'card-load-failed',
          borrower: cloneBorrower(state.phase.borrower),
          ledgerEpoch: state.phase.ledgerEpoch,
          loadId: action.loadId,
        },
        feedback: {
          kind: 'warning',
          code: 'card_load_failed',
          message: 'Borrower card load failed',
        },
        focus: 'retry-card',
      };
    return {
      ...state,
      phase: {
        kind: 'opened',
        borrower: cloneBorrower(state.phase.borrower),
        snapshot: cloneSnapshot(action.snapshot),
      },
      openCardBorrower: cloneBorrower(state.phase.borrower),
      openCardSnapshot: cloneSnapshot(action.snapshot),
      focus: 'item-search',
    };
  }
  if (action.type === 'card-load-failed') {
    if (state.phase.kind !== 'committed' || state.phase.loadId !== action.loadId) return state;
    return {
      ...state,
      phase: {
        kind: 'card-load-failed',
        borrower: cloneBorrower(state.phase.borrower),
        ledgerEpoch: state.phase.ledgerEpoch,
        loadId: action.loadId,
      },
      feedback: { kind: 'warning', code: 'card_load_failed', message: 'Borrower card load failed' },
      focus: 'retry-card',
    };
  }
  if (action.type === 'reload-started') {
    if (
      state.phase.kind !== 'reload-required' ||
      state.phase.reloadId ||
      !validUuid(action.reloadId) ||
      state.usedReloadIds.includes(action.reloadId)
    )
      return state;
    return {
      ...state,
      phase: { ...state.phase, reloadId: action.reloadId },
      usedReloadIds: [...state.usedReloadIds, action.reloadId],
      feedback: null,
    };
  }
  if (action.type === 'reload-succeeded') {
    if (
      state.phase.kind !== 'reload-required' ||
      state.phase.reloadId !== action.reloadId ||
      !isSafePositive(action.ledgerEpoch) ||
      action.ledgerEpoch <= state.values.ledgerEpoch
    )
      return state;
    return {
      ...state,
      values: { ...state.values, ledgerEpoch: action.ledgerEpoch },
      phase: { kind: 'editing', retiredAttemptKey: state.phase.attemptKey },
      feedback: null,
      focus: null,
    };
  }
  if (action.type === 'reload-failed') {
    if (state.phase.kind !== 'reload-required' || state.phase.reloadId !== action.reloadId)
      return state;
    return {
      ...state,
      phase: { kind: 'reload-required', attemptKey: state.phase.attemptKey },
      feedback: { kind: 'error', code: 'reload_required', message: 'Reload required' },
      focus: 'borrower-search',
    };
  }
  if (action.type === 'storage-failure') {
    const phase = creationAttempt(state, action.attemptKey);
    if (!phase) return state;
    return {
      ...state,
      phase: {
        kind: 'storage-recovery',
        attemptKey: action.attemptKey,
        operation: action.operation,
      },
      feedback: {
        kind: 'error',
        code: `storage_${action.operation}_failed`,
        message: 'Storage failure',
      },
    };
  }
  if (
    action.type === 'storage-reconciled' &&
    state.phase.kind === 'storage-recovery' &&
    state.phase.attemptKey === action.attemptKey
  )
    return {
      ...state,
      phase:
        action.record === 'recoverable'
          ? { kind: 'unknown', attemptKey: action.attemptKey }
          : { kind: 'editing' },
      feedback: null,
    };
  return state;
}

export function creationLocks(state: CreationState): { dismissal: boolean; dispatch: boolean } {
  return {
    dismissal:
      state.phase.kind === 'pending' ||
      state.phase.kind === 'unknown' ||
      state.phase.kind === 'storage-recovery',
    dispatch: !['editing', 'conflicted'].includes(state.phase.kind),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validUuid(value: string): boolean {
  return UUID.test(value);
}

function validCreationRequest(value: BorrowerCreateRequest): boolean {
  return (
    hasExactKeys(value as unknown as Record<string, unknown>, [
      'contractVersion',
      'ledgerEpoch',
      'username',
      'name',
      'contact',
      'type',
    ]) &&
    value.contractVersion === BORROWER_WORKFLOW_CONTRACT_VERSION &&
    isSafePositive(value.ledgerEpoch) &&
    value.username === value.username.trim() &&
    value.username.length >= 2 &&
    value.username.length <= 40 &&
    value.name === value.name.trim() &&
    value.name.length >= 1 &&
    value.name.length <= 100 &&
    value.contact === value.contact.trim() &&
    value.contact.length <= 500 &&
    ['individual', 'camp_organization', 'other'].includes(value.type)
  );
}
