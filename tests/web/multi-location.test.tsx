// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BorrowerOperationalTables } from '../../src/web/BorrowerOperationalTables';
import {
  createOperationState,
  isBorrowerDeskSnapshot,
  operationReducer,
  operationRequest,
  projectedLocationAvailability,
} from '../../src/web/borrower-workflow-state';
import type { BorrowerDeskSnapshot } from '../../src/contracts/borrower-workflow';
const snapshot: BorrowerDeskSnapshot = {
  borrower: {
    id: 1,
    playaName: 'holder',
    fullName: 'Holder',
    phoneNumber: '',
    campDepartment: '',
    archived: false,
  },
  inventory: [
    {
      id: 1,
      name: 'Shared',
      kind: 'non_consumable',
      aliases: [],
      lotSize: null,
      archived: false,
      selectable: true,
      available: 50,
      damaged: 0,
      balances: [
        { locationId: 1, available: 20, damaged: 0 },
        { locationId: 2, available: 30, damaged: 0 },
      ],
    },
  ],
  holdings: [{ itemId: 1, returnable: 5, lost: 0 }],
  stateRevision: 1,
  ledgerEpoch: 1,
  locations: [
    { id: 1, code: 'a', name: 'Container A', archived: false, isDefault: false },
    { id: 2, code: 'b', name: 'Container B', archived: false, isDefault: true },
  ],
  defaultLocationId: 2,
};
afterEach(cleanup);
it('staged rows identify both selected containers while actual holdings stay grouped', () => {
  let state = createOperationState(1, snapshot);
  state = operationReducer(state, {
    type: 'stage-borrow',
    itemId: 1,
    part: { quantity: 2, note: '', locationId: 1 },
  });
  state = operationReducer(state, {
    type: 'stage-borrow',
    itemId: 1,
    part: { quantity: 3, note: '', locationId: 2 },
  });
  render(
    <BorrowerOperationalTables
      state={state}
      disabled={false}
      onReturn={vi.fn()}
      onRollback={vi.fn()}
    />,
  );
  expect(screen.getByText('Container A · 2')).toBeTruthy();
  expect(screen.getByText('Container B · 3')).toBeTruthy();
  // One aggregated holding row, one pending borrow row; containers only split selected parts.
  expect(
    screen.getAllByRole('row').filter((row) => within(row).queryByText('Shared')),
  ).toHaveLength(1);
  expect(operationRequest(state).items[0]!.borrow).toEqual([
    { quantity: 2, note: '', locationId: 1 },
    { quantity: 3, note: '', locationId: 2 },
  ]);
});
it('local projection credits only the selected return destination and frozen requests retain it', () => {
  let state = createOperationState(1, snapshot);
  state = operationReducer(state, {
    type: 'stage-return',
    itemId: 1,
    part: { usable: 5, damaged: 0, note: '', locationId: 2 },
  });
  expect(projectedLocationAvailability(state, 1, 1)).toBe(20);
  expect(projectedLocationAvailability(state, 1, 2)).toBe(35);
  const frozen = operationRequest(state);
  state = operationReducer(state, {
    type: 'dispatch',
    attemptKey: '00000000-0000-4000-8000-000000000001',
    intent: 'save',
  });
  state = operationReducer(state, {
    type: 'dispatch-unknown',
    attemptKey: '00000000-0000-4000-8000-000000000001',
  });
  expect(operationRequest(state)).toEqual(frozen);
});

it('rejects duplicate placement identities, unknown locations and mismatched local totals at recovery boundaries', () => {
  expect(isBorrowerDeskSnapshot(snapshot)).toBe(true);
  for (const balances of [
    [...snapshot.inventory[0]!.balances, snapshot.inventory[0]!.balances[0]!],
    [{ locationId: 999, available: 50, damaged: 0 }],
    [{ locationId: 1, available: 49, damaged: 0 }],
  ])
    expect(
      isBorrowerDeskSnapshot({ ...snapshot, inventory: [{ ...snapshot.inventory[0]!, balances }] }),
    ).toBe(false);
});
