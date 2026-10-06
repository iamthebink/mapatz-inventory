import { borrowerIdentity } from '../../src/domain/borrower-profile.js';
import type { InventoryTransferSnapshot, RecoveryPayload } from '../../src/domain/import-export.js';

/** Compare business data while resolving every workbook relationship through its item. */
export function transferBusinessState(snapshot: InventoryTransferSnapshot | RecoveryPayload) {
  const {
    identityHighWater: _identityHighWater,
    items,
    borrowers,
    events,
    loans,
    ...state
  } = snapshot;
  void _identityHighWater;
  const names = new Map(items.map((item) => [item.id, item.name]));
  const itemName = (id: number) => {
    const name = names.get(id);
    if (name === undefined) throw new Error(`Dangling item reference ${id}`);
    return name;
  };
  const profiles = new Map(borrowers.map((borrower) => [borrower.id, borrowerIdentity(borrower)]));
  const borrowerProfile = (id: number | null) => {
    if (id == null) return null;
    const profile = profiles.get(id);
    if (profile === undefined) throw new Error(`Dangling borrower reference ${id}`);
    return profile;
  };
  return {
    ...state,
    borrowers: borrowers.map(({ id: _id, ...borrower }) => {
      void _id;
      return borrower;
    }),
    items: items
      .map(({ id: _id, ...item }) => {
        void _id;
        return item;
      })
      .sort((a, b) => {
        if (a.name !== b.name) return a.name < b.name ? -1 : 1;
        const left = a.location ?? '';
        const right = b.location ?? '';
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    events: events.map(({ itemId, borrowerId, ...event }) => ({
      ...event,
      itemName: itemName(itemId),
      borrowerProfile: borrowerProfile(borrowerId),
    })),
    loans: loans.map(({ itemId, borrowerId, ...loan }) => ({
      ...loan,
      itemName: itemName(itemId),
      borrowerProfile: borrowerProfile(borrowerId),
    })),
  };
}
