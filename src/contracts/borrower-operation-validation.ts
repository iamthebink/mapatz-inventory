import type {
  BorrowerDeskSnapshot,
  BorrowerOperationRequest,
  BorrowerOperationConflict,
} from './borrower-workflow.js';

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** Eligibility is computed from authoritative local balances, with borrower holdings kept item-wide. */
export function borrowerOperationConflicts(
  snapshot: BorrowerDeskSnapshot,
  request: BorrowerOperationRequest,
): BorrowerOperationConflict[] {
  if (snapshot.borrower.archived)
    return [{ scope: 'borrower', code: 'borrower_inactive', borrowerId: snapshot.borrower.id }];
  const conflicts: BorrowerOperationConflict[] = [];
  const active = new Set(snapshot.locations.filter((l) => !l.archived).map((l) => l.id));
  for (const group of [...request.items].sort((a, b) => a.itemId - b.itemId)) {
    const item = snapshot.inventory.find((i) => i.id === group.itemId);
    if (!item || item.archived) {
      conflicts.push({
        scope: 'item',
        code: item ? 'item_archived' : 'item_not_found',
        itemId: group.itemId,
      });
      continue;
    }
    const parts = [
      ...(group.borrow ?? []),
      ...(group.issue ?? []),
      ...(group.return ?? []),
      ...(group.lostCredit ?? []),
    ];
    const invalid = [...new Set(parts.map((p) => p.locationId))].filter((id) => !active.has(id));
    if (invalid.length) {
      for (const locationId of invalid)
        conflicts.push({
          scope: 'location',
          code: 'invalid_location',
          itemId: item.id,
          locationId,
        });
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
      for (const locationId of new Set(group.issue.map((p) => p.locationId))) {
        const requested = sum(
          group.issue.filter((p) => p.locationId === locationId).map((p) => p.quantity),
        );
        const available = item.balances.find((p) => p.locationId === locationId)?.available ?? 0;
        if (requested > available)
          conflicts.push({
            scope: 'issue',
            code: 'insufficient_stock',
            itemId: item.id,
            locationId,
            requested,
            available,
          });
      }
      continue;
    }
    if (item.kind !== 'non_consumable' || group.issue) {
      conflicts.push({ scope: 'item', code: 'wrong_item_kind', itemId: item.id });
      continue;
    }
    const returned = sum((group.return ?? []).map((p) => p.usable + p.damaged));
    const lost = sum((group.lost ?? []).map((p) => p.quantity));
    const holding = snapshot.holdings.find((h) => h.itemId === item.id);
    const returnable = holding?.returnable ?? 0;
    if (returned + lost > returnable) {
      conflicts.push(
        lost > 0
          ? {
              scope: 'held',
              code: 'held_balance_changed',
              itemId: item.id,
              requested: returned + lost,
              returnable,
            }
          : {
              scope: 'return',
              code: 'returnable_balance_changed',
              itemId: item.id,
              requested: returned,
              returnable,
            },
      );
      continue;
    }
    const credit = sum((group.lostCredit ?? []).map((p) => p.quantity));
    const eligibleLost = (holding?.lost ?? 0) + lost;
    if (credit > eligibleLost) {
      conflicts.push({
        scope: 'lost-credit',
        code: 'lost_balance_changed',
        itemId: item.id,
        requested: credit,
        lost: eligibleLost,
      });
      continue;
    }
    for (const locationId of new Set((group.borrow ?? []).map((p) => p.locationId))) {
      const requested = sum(
        (group.borrow ?? []).filter((p) => p.locationId === locationId).map((p) => p.quantity),
      );
      const returnedUsable = sum(
        (group.return ?? []).filter((p) => p.locationId === locationId).map((p) => p.usable),
      );
      const recovered = sum(
        (group.lostCredit ?? [])
          .filter((p) => p.locationId === locationId && p.condition === 'usable')
          .map((p) => p.quantity),
      );
      const availableAfterUsableReturns =
        (item.balances.find((p) => p.locationId === locationId)?.available ?? 0) +
        returnedUsable +
        recovered;
      if (requested > availableAfterUsableReturns)
        conflicts.push({
          scope: 'borrow',
          code: 'insufficient_stock',
          itemId: item.id,
          locationId,
          requested,
          availableAfterUsableReturns,
        });
    }
  }
  return conflicts;
}

export function sameConflictEvidence(
  actual: unknown,
  expected: BorrowerOperationConflict[],
): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((value, index) => {
    if (!value || typeof value !== 'object') return false;
    const reference = expected[index]!;
    const entries = Object.entries(reference);
    return (
      Object.keys(value).length === entries.length &&
      entries.every(([key, entry]) => value[key] === entry)
    );
  });
}
