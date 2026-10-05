import { randomUUID } from 'node:crypto';
import type { InventoryService } from '../../src/domain/inventory.js';
// The checkout identifies the borrower/item; recovery allocates FIFO across their lost checkouts.
export function foundReturned(
  service: InventoryService,
  referenceCheckoutId: number,
  quantity: number,
  note = 'found',
) {
  const loan = service.listLoans().find((entry) => entry.checkoutId === referenceCheckoutId)!;
  const result = service.commitBorrowerOperations(loan.borrowerId, randomUUID(), {
    contractVersion: 1,
    ledgerEpoch: service.getBorrowerDeskSnapshot(loan.borrowerId).ledgerEpoch,
    items: [
      {
        itemId: loan.itemId,
        lostCredit: [
          {
            quantity,
            condition: 'usable',
            note,
            locationId: service.listItems('', true).find((item) => item.id === loan.itemId)!
              .balances[0]!.locationId,
          },
        ],
      },
    ],
  });
  if (!('outcome' in result) || result.outcome !== 'committed')
    throw new Error(JSON.stringify(result));
}
