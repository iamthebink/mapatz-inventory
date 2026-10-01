import type { InventoryTransferSnapshot, RecoveryPayload } from '../../src/domain/import-export.js';

/** Compare business data while resolving every workbook relationship through its item. */
export function transferBusinessState(snapshot: InventoryTransferSnapshot | RecoveryPayload) {
  const { identityHighWater: _identityHighWater, items, events, loans, ...state } = snapshot;
  void _identityHighWater;
  const names = new Map(items.map((item) => [item.id, item.name]));
  const itemName = (id: number) => {
    const name = names.get(id);
    if (name === undefined) throw new Error(`Dangling item reference ${id}`);
    return name;
  };
  return {
    ...state,
    items: items
      .map(({ id: _id, ...item }) => {
        void _id;
        return item;
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    events: events.map(({ itemId, ...event }) => ({ ...event, itemName: itemName(itemId) })),
    loans: loans.map(({ itemId, ...loan }) => ({ ...loan, itemName: itemName(itemId) })),
  };
}
