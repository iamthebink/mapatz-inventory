// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { flushSync } from 'react-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveDescendantCombobox } from '../../src/web/ActiveDescendantCombobox';
import { BorrowerWorkflow, type BorrowerWorkflowHandle } from '../../src/web/BorrowerWorkflow';
import { DialogStackProvider } from '../../src/web/Dialog';
const borrower = {
  id: 7,
  playaName: 'or',
  fullName: 'אור',
  phoneNumber: '050',
  campDepartment: '' as const,
  archived: false,
};
const archived = { ...borrower, id: 8, playaName: 'old', fullName: 'אור הישן', archived: true };
const item = {
  id: 11,
  name: 'אוהל',
  kind: 'non_consumable' as const,
  lotSize: null,
  balances: [{ locationId: 1, available: 4, damaged: 0 }],
  archived: false,
  aliases: ['Tent'],
  available: 4,
  damaged: 0,
  selectable: true,
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function desk(stateRevision = 1) {
  return {
    borrower,
    inventory: [item],
    holdings: [{ itemId: 11, returnable: 2, lost: 1 }],
    stateRevision,
    ledgerEpoch: 3,
    locations: [
      {
        id: 1,
        name: '\u05DE\u05E4\u05DC\u05E6\u05EA',
        code: 'monster',
        archived: false,
        isDefault: true,
      },
    ],
    defaultLocationId: 1,
  };
}
function expectHeldQuantity(quantity: number) {
  const holdings = document.getElementById('holdings-heading')!.parentElement!;
  const table = within(holdings).getByRole('table');
  expect(within(table).getByRole('columnheader', { name: 'אצל השואל' })).toBeTruthy();
  const row = within(table).getByRole('rowheader', { name: item.name }).closest('tr')!;
  expect(within(row).getAllByRole('cell')[0]?.textContent).toBe(String(quantity));
}
async function activateBorrowerAction(key: 'Enter' | ' ' = 'Enter') {
  const action = await screen.findByRole('button', {
    name: `פתיחת כרטיס שואל — ${borrower.fullName}`,
  });
  action.focus();
  await userEvent.keyboard(key === 'Enter' ? '{Enter}' : ' ');
}
async function confirmSave() {
  await userEvent.click(screen.getByRole('button', { name: 'אישור פעולות' }));
  await userEvent.click(await screen.findByRole('button', { name: 'אישור ושמירה' }));
}
function expectDialogItem(dialog: HTMLElement, itemName: string) {
  const descriptionId = dialog.getAttribute('aria-describedby');
  expect(descriptionId).toBeTruthy();
  const description = document.getElementById(descriptionId!);
  expect(description).toBeTruthy();
  expect(dialog.contains(description)).toBe(true);
  expect(description?.textContent).toBe(`פריט: ${itemName}`);
  const callout = description?.querySelector('.quantity-dialog-item');
  expect(callout).toBeTruthy();
  expect(callout?.querySelector('.quantity-dialog-item-label')?.textContent).toBe('פריט: ');
  expect(callout?.querySelector('.quantity-dialog-item-name bdi')?.textContent).toBe(itemName);
}
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}
function failFirstWriteStorage(): Storage {
  const base = memoryStorage();
  let fail = true;
  return {
    ...base,
    get length() {
      return base.length;
    },
    setItem(key, value) {
      if (fail) {
        fail = false;
        throw new Error('storage unavailable');
      }
      base.setItem(key, value);
    },
  };
}
function failFirstRemoveStorage(): Storage {
  const base = memoryStorage();
  let fail = true;
  return {
    ...base,
    get length() {
      return base.length;
    },
    removeItem(key) {
      if (fail) {
        fail = false;
        throw new Error('storage unavailable');
      }
      base.removeItem(key);
    },
  };
}
it('protects a dirty borrower creation draft with a neutral keep and danger discard dialog', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith('/api/borrowers/search'))
        return json({ ledgerEpoch: 3, active: [], archivedMatches: [] });
      throw new Error(`Unexpected ${String(input)}`);
    }),
  );
  render(
    <DialogStackProvider>
      <BorrowerWorkflow showToast={vi.fn()} />
    </DialogStackProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'יצירת שואל חדש' }));
  await user.type(screen.getByRole('textbox', { name: 'שם פלאיה' }), 'new-user');
  await user.type(screen.getByRole('textbox', { name: 'שם מלא' }), 'שואל חדש');
  await user.click(screen.getByRole('button', { name: 'ביטול' }));
  const discard = await screen.findByRole('alertdialog', { name: 'לבטל טיוטת שואל?' });
  expect(
    within(discard)
      .getByRole('button', { name: 'להמשיך לערוך' })
      .classList.contains('secondary-button'),
  ).toBe(true);
  expect(
    within(discard)
      .getByRole('button', { name: 'מחיקת טיוטה' })
      .classList.contains('danger-button'),
  ).toBe(true);
  await user.click(within(discard).getByRole('button', { name: 'להמשיך לערוך' }));
  expect(screen.getByRole('textbox', { name: 'שם מלא' })).toHaveProperty('value', 'שואל חדש');
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'ביטול' })),
  );
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  window.dispatchEvent(new PopStateEvent('popstate'));
  await screen.findByRole('alertdialog', { name: 'לבטל טיוטת שואל?' });
  await user.click(screen.getByRole('button', { name: 'להמשיך לערוך' }));
  window.dispatchEvent(new PopStateEvent('popstate'));
  await screen.findByRole('alertdialog', { name: 'לבטל טיוטת שואל?' });
  await user.click(
    within(await screen.findByRole('alertdialog', { name: 'לבטל טיוטת שואל?' })).getByRole(
      'button',
      { name: 'מחיקת טיוטה' },
    ),
  );
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'יצירת שואל חדש' })).toBeNull());
});
it('protects a borrower creation draft when only its type changed', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith('/api/borrowers/search'))
        return json({ ledgerEpoch: 3, active: [], archivedMatches: [] });
      throw new Error(`Unexpected ${String(input)}`);
    }),
  );
  render(
    <DialogStackProvider>
      <BorrowerWorkflow showToast={vi.fn()} />
    </DialogStackProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'יצירת שואל חדש' }));
  await user.type(screen.getByRole('combobox', { name: 'מחנה / מחלקה' }), 'מחנה אחר');
  await user.click(screen.getByRole('button', { name: 'ביטול' }));
  const discard = await screen.findByRole('alertdialog', { name: 'לבטל טיוטת שואל?' });
  await user.click(within(discard).getByRole('button', { name: 'להמשיך לערוך' }));
  expect(screen.getByRole('combobox', { name: 'מחנה / מחלקה' })).toHaveProperty(
    'value',
    'מחנה אחר',
  );
});
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  localStorage.clear();
  vi.spyOn(history, 'pushState');
  vi.spyOn(history, 'back').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('returns to the originating summary once when an earlier history listener rerenders the workflow', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.startsWith('/api/borrowers/search'))
        return json({ ledgerEpoch: 3, active: [], archivedMatches: [] });
      if (path === '/api/borrowers/7/desk-snapshot') return json(desk());
      throw new Error(`Unexpected ${path}`);
    }),
  );
  const ref = createRef<BorrowerWorkflowHandle>();
  const returned = vi.fn();
  const startupChanged = vi.fn();
  const showToast = vi.fn();
  const workflow = (deskVisible: boolean) => (
    <DialogStackProvider>
      <BorrowerWorkflow
        ref={ref}
        showToast={showToast}
        deskVisible={deskVisible}
        onStartupChange={startupChanged}
      />
    </DialogStackProvider>
  );
  let rerenderWorkflow: (() => void) | undefined;
  const earlierHistoryListener = () => rerenderWorkflow?.();
  window.addEventListener('popstate', earlierHistoryListener);
  try {
    const view = render(workflow(false));
    // A parent history listener may synchronously render before the workflow's
    // own listener receives the same event. The pending completion must survive.
    rerenderWorkflow = () => flushSync(() => view.rerender(workflow(true)));
    await waitFor(() => expect(startupChanged).toHaveBeenLastCalledWith('ready'));
    act(() => ref.current?.openFromSummary(borrower, returned));
    const card = await screen.findByRole('dialog', { name: /כרטיס שואל/ });
    await userEvent.click(within(card).getAllByRole('button', { name: 'סגירה' }).at(-1)!);
    expect(history.back).toHaveBeenCalledOnce();
    expect(returned).not.toHaveBeenCalled();
    fireEvent.popState(window);
    expect(returned).toHaveBeenCalledOnce();
    fireEvent.popState(window);
    expect(returned).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener('popstate', earlierHistoryListener);
  }
});
describe('active descendant search', () => {
  it('keeps focus on the input, skips disabled options, bounds movement, and collapses before Escape can bubble', async () => {
    const selected: string[] = [];
    const escaped = vi.fn();
    render(
      <div onKeyDown={(event) => event.key === 'Escape' && escaped()}>
        <ActiveDescendantCombobox
          label="חיפוש"
          value="א"
          onChange={() => undefined}
          onSelect={(value) => selected.push(value)}
          options={[
            { id: 'active-a', value: 'a', label: 'ראשון' },
            { id: 'archived-b', value: 'b', label: 'ישן', disabled: true },
            { id: 'active-c', value: 'c', label: 'אחרון' },
          ]}
        />
      </div>,
    );
    const input = screen.getByRole('combobox');
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-activedescendant')).toBe('active-c');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(selected).toEqual(['c']);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(escaped).toHaveBeenCalledTimes(1);
  });
  it('collapses when focus leaves while preserving pointer option selection', async () => {
    const selected: string[] = [];
    render(
      <div>
        <ActiveDescendantCombobox
          label="חיפוש"
          value=""
          onChange={() => undefined}
          onSelect={(value) => selected.push(value)}
          options={[{ id: 'active-a', value: 'a', label: 'ראשון' }]}
          openOnFocus
        />
        <button type="button">מחוץ לחיפוש</button>
      </div>,
    );
    const input = screen.getByRole('combobox');
    await userEvent.click(input);
    expect(screen.getByRole('listbox')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'מחוץ לחיפוש' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.click(input);
    await userEvent.click(screen.getByRole('option', { name: 'ראשון' }));
    expect(selected).toEqual(['a']);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
describe('borrower desk workflow', () => {
  it('saves a consumable-only card operation without a borrower holding', async () => {
    const ties = {
      ...item,
      id: 13,
      name: 'אזיקונים',
      kind: 'consumable' as const,
      available: 5,
      balances: [{ locationId: 1, available: 5, damaged: 0 }],
    };
    let saved = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot')
          return json({
            ...desk(saved ? 2 : 1),
            inventory: [
              item,
              {
                ...ties,
                available: saved ? 4 : 5,
                balances: [{ locationId: 1, available: saved ? 4 : 5, damaged: 0 }],
              },
            ],
          });
        if (path === '/api/borrowers/7/operations') {
          const body = JSON.parse(String(init.body)) as {
            items: unknown[];
          };
          expect(body.items).toEqual([
            { itemId: ties.id, issue: [{ quantity: 1, note: 'supplies', locationId: 1 }] },
          ]);
          saved = true;
          const key = new Headers(init.headers).get('idempotency-key');
          return json({ outcome: 'committed', idempotencyKey: key, replayed: false }, 201);
        }
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    await userEvent.type(await screen.findByRole('searchbox', { name: 'חיפוש שואל' }), 'א');
    await activateBorrowerAction();
    await userEvent.type(screen.getByRole('combobox', { name: 'חיפוש פריט' }), 'אזיקונים');
    await userEvent.click(await screen.findByRole('option', { name: /אזיקונים/ }));
    const quantity = screen.getByRole('dialog', { name: 'ניפוק ציוד מתכלה' });
    await userEvent.type(
      within(quantity).getByRole('textbox', { name: 'הערה (רשות)' }),
      'supplies',
    );
    await userEvent.click(within(quantity).getByRole('button', { name: 'אישור' }));
    await confirmSave();
    await waitFor(() => expect(saved).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /כרטיס שואל/ })).toBeNull());
    await activateBorrowerAction();
    expect(screen.queryByRole('rowheader', { name: ties.name })).toBeNull();
  });
  it('stages consumables as issuance without projecting borrower holdings', async () => {
    const ties = {
      ...item,
      id: 13,
      name: 'אזיקונים',
      kind: 'consumable' as const,
      available: 5,
      balances: [{ locationId: 1, available: 5, damaged: 0 }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot')
          return json({ ...desk(), inventory: [item, ties] });
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    await userEvent.type(await screen.findByRole('searchbox', { name: 'חיפוש שואל' }), 'א');
    await activateBorrowerAction();
    const search = screen.getByRole('combobox', { name: 'חיפוש פריט' });
    await userEvent.type(search, 'אזיקונים');
    await userEvent.click(await screen.findByRole('option', { name: /אזיקונים/ }));
    const dialog = screen.getByRole('dialog', { name: 'ניפוק ציוד מתכלה' });
    expectDialogItem(dialog, ties.name);
    await userEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    expect(screen.getByText('ניפוק · מתכלה · 1')).toBeTruthy();
    expect(screen.queryByRole('rowheader', { name: ties.name })).toBeNull();
  });
  it('keeps quantities and return actions aligned with their own item across both tables', async () => {
    const secondItem = {
      ...item,
      id: 12,
      name: 'מזרן',
      available: 5,
      balances: [{ locationId: 1, available: 5, damaged: 0 }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot')
          return json({
            ...desk(),
            inventory: [item, secondItem],
            holdings: [
              { itemId: 11, returnable: 2, lost: 1 },
              { itemId: 12, returnable: 3, lost: 2 },
            ],
          });
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    const search = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await userEvent.type(search, 'א');
    await activateBorrowerAction();
    const holdings = screen.getByRole('table', { name: 'ציוד אצל השואל' });
    const tentRow = within(holdings).getByRole('rowheader', { name: item.name }).closest('tr')!;
    const matRow = within(holdings)
      .getByRole('rowheader', { name: secondItem.name })
      .closest('tr')!;
    expect(within(tentRow).getAllByRole('cell')[0]?.textContent).toBe('2');
    expect(within(matRow).getAllByRole('cell')[0]?.textContent).toBe('3');
    await userEvent.click(within(matRow).getByRole('button', { name: 'החזרת ציוד' }));
    const returnDialog = screen.getByRole('dialog', { name: 'החזרת ציוד' });
    expect(within(returnDialog).getByText(secondItem.name)).toBeTruthy();
    await userEvent.click(within(returnDialog).getByRole('button', { name: 'ביטול' }));
    await userEvent.click(screen.getByText('ציוד אבוד של השואל'));
    const lost = screen.getByRole('table', { name: /ציוד אבוד של השואל/ });
    const lostTentRow = within(lost).getByRole('rowheader', { name: item.name }).closest('tr')!;
    const lostMatRow = within(lost)
      .getByRole('rowheader', { name: secondItem.name })
      .closest('tr')!;
    expect(within(lostTentRow).getAllByRole('cell')[0]?.textContent).toBe('1');
    expect(within(lostMatRow).getAllByRole('cell')[0]?.textContent).toBe('2');
    await userEvent.click(within(lostTentRow).getByRole('button', { name: 'נמצא והוחזר' }));
    const foundDialog = screen.getByRole('dialog', { name: 'נמצא והוחזר' });
    expect(within(foundDialog).getByText(item.name)).toBeTruthy();
  });
  it('enables each return action from its own source balance and stages lost credit with Enter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot')
          return json({ ...desk(), holdings: [{ itemId: 11, returnable: 0, lost: 2 }] });
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    const search = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await userEvent.type(search, 'א');
    await activateBorrowerAction();
    expect(screen.queryByRole('button', { name: 'החזרת ציוד' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'אפשרויות נוספות' })).toBeNull();
    await userEvent.click(screen.getByText('ציוד אבוד של השואל'));
    const found = screen.getByRole('button', { name: 'נמצא והוחזר' });
    expect((found as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(found);
    const quantityInput = screen.getByRole('spinbutton', { name: /כמות/ }) as HTMLInputElement;
    expect(quantityInput.value).toBe('2');
    await waitFor(() => expect(document.activeElement).toBe(quantityInput));
    await userEvent.clear(quantityInput);
    await userEvent.type(quantityInput, '0');
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('alert').textContent).toContain('בין 1 ל־2');
    await userEvent.clear(quantityInput);
    await userEvent.type(quantityInput, '2');
    await userEvent.keyboard('{Enter}');
    const pending = screen.getByRole('region', { name: 'פעולות ממתינות' });
    expect(within(pending).getByText(/נמצא והוחזר · 2/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'נמצא והוחזר' })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'ציוד אצל השואל' })),
    );
  });
  it('uses the existing quantity modal and resets damaged condition on each return', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot') return json(desk());
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    await userEvent.type(await screen.findByRole('searchbox', { name: 'חיפוש שואל' }), 'א');
    await activateBorrowerAction();
    await userEvent.click(await screen.findByRole('button', { name: 'החזרת ציוד' }));
    let dialog = screen.getByRole('dialog', { name: 'החזרת ציוד' });
    expectDialogItem(dialog, item.name);
    let quantityInput = screen.getByRole('spinbutton', { name: /כמות/ }) as HTMLInputElement;
    expect(quantityInput.value).toBe('2');
    const damaged = within(dialog).getByRole('checkbox', { name: 'הציוד הוחזר פגום' });
    expect((damaged as HTMLInputElement).checked).toBe(false);
    await userEvent.click(damaged);
    await userEvent.click(within(dialog).getByRole('button', { name: 'ביטול' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'החזרת ציוד' })),
    );
    await userEvent.click(screen.getByRole('button', { name: 'החזרת ציוד' }));
    dialog = screen.getByRole('dialog', { name: 'החזרת ציוד' });
    quantityInput = screen.getByRole('spinbutton', { name: /כמות/ }) as HTMLInputElement;
    expect(quantityInput.value).toBe('2');
    expect(
      (within(dialog).getByRole('checkbox', { name: 'הציוד הוחזר פגום' }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    await userEvent.clear(quantityInput);
    await userEvent.type(quantityInput, '1');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'הציוד הוחזר פגום' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    const pending = screen.getByRole('region', { name: 'פעולות ממתינות' });
    expect(within(pending).getByText(/החזרת ציוד · פגום · 1/)).toBeTruthy();
  });
  it('stages damaged lost recovery separately from usable returns and shows both in review', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot') return json(desk());
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    await userEvent.type(await screen.findByRole('searchbox', { name: 'חיפוש שואל' }), 'א');
    await activateBorrowerAction();
    await userEvent.click(screen.getByRole('button', { name: 'החזרת ציוד' }));
    let dialog = screen.getByRole('dialog', { name: 'החזרת ציוד' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    await userEvent.click(screen.getByText('ציוד אבוד של השואל'));
    await userEvent.click(screen.getByRole('button', { name: 'נמצא והוחזר' }));
    dialog = screen.getByRole('dialog', { name: 'נמצא והוחזר' });
    expectDialogItem(dialog, item.name);
    const damaged = within(dialog).getByRole('checkbox', {
      name: 'הציוד הוחזר פגום',
    }) as HTMLInputElement;
    expect(damaged.checked).toBe(false);
    await userEvent.click(damaged);
    await userEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    const pending = screen.getByRole('region', { name: 'פעולות ממתינות' });
    expect(within(pending).getByText(/החזרת ציוד · 2/)).toBeTruthy();
    expect(within(pending).getByText(/נמצא והוחזר · פגום · 1/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'אישור פעולות' }));
    const review = screen.getByRole('dialog', { name: 'אישור פעולות' });
    expect(within(review).getByText(/החזרת ציוד · 2/)).toBeTruthy();
    expect(within(review).getByText(/נמצא והוחזר · פגום · 1/)).toBeTruthy();
  });
  it('rejects a borrow above remaining stock without adding it to the transaction', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot') return json(desk());
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    await userEvent.type(await screen.findByRole('searchbox', { name: 'חיפוש שואל' }), 'א');
    await activateBorrowerAction();
    const openBorrow = async () => {
      const search = screen.getByRole('combobox', { name: 'חיפוש פריט' });
      await userEvent.type(search, item.name);
      fireEvent.keyDown(search, { key: 'ArrowDown' });
      fireEvent.keyDown(search, { key: 'Enter' });
      return screen.findByRole('dialog', { name: 'הוספת השאלה' });
    };
    let dialog = await openBorrow();
    let quantity = within(dialog).getByRole('spinbutton', { name: /כמות/ }) as HTMLInputElement;
    expect(quantity.max).toBe('4');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('עד 4');
    expect(document.querySelector('.staged-section .operational-empty')?.textContent).toBe(
      'אין פעולות ממתינות',
    );
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '3');
    await userEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    expect(screen.queryByRole('dialog', { name: 'הוספת השאלה' })).toBeNull();
    dialog = await openBorrow();
    quantity = within(dialog).getByRole('spinbutton', { name: /כמות/ }) as HTMLInputElement;
    expect(quantity.max).toBe('1');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('עד 1');
    expect(document.querySelector('.staged-section')?.textContent).toContain('השאלה · 3');
    expect(document.querySelector('.staged-section')?.textContent).not.toContain('השאלה · 2');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    expect(
      within(screen.getByRole('region', { name: 'פעולות ממתינות' })).getByText(/השאלה · 4/),
    ).toBeTruthy();
    const search = screen.getByRole('combobox', { name: 'חיפוש פריט' });
    await userEvent.type(search, item.name);
    let option = screen.getByRole('option', { name: /אוהל/ });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option.textContent).toContain('זמין: 0');
    await userEvent.click(screen.getByRole('button', { name: 'החזרת ציוד' }));
    dialog = screen.getByRole('dialog', { name: 'החזרת ציוד' });
    const damagedQuantity = within(dialog).getByRole('spinbutton', { name: /כמות/ });
    await userEvent.clear(damagedQuantity);
    await userEvent.type(damagedQuantity, '1');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'הציוד הוחזר פגום' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    await userEvent.click(search);
    option = screen.getByRole('option', { name: /אוהל/ });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option.textContent).toContain('זמין: 0');
    await userEvent.click(screen.getByRole('button', { name: 'החזרת ציוד' }));
    dialog = screen.getByRole('dialog', { name: 'החזרת ציוד' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    await userEvent.click(search);
    option = screen.getByRole('option', { name: /אוהל/ });
    expect(option.hasAttribute('aria-disabled')).toBe(false);
    expect(option.textContent).toContain('זמין: 1');
    await userEvent.click(option);
    dialog = screen.getByRole('dialog', { name: 'הוספת השאלה' });
    expect((within(dialog).getByRole('spinbutton', { name: /כמות/ }) as HTMLInputElement).max).toBe(
      '1',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    expect(screen.getByRole('region', { name: 'פעולות ממתינות' }).textContent).toContain(
      'השאלה · 5',
    );
  });
  it('keeps each staged quantity next to its own note in review', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot')
          return json({ ...desk(), holdings: [{ itemId: 11, returnable: 4, lost: 1 }] });
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    await userEvent.type(await screen.findByRole('searchbox', { name: 'חיפוש שואל' }), 'א');
    await activateBorrowerAction();
    for (const [quantity, note] of [
      ['1', 'first returned unit'],
      ['2', 'next returned units'],
    ] as const) {
      await userEvent.click(screen.getByRole('button', { name: 'החזרת ציוד' }));
      const dialog = screen.getByRole('dialog', { name: 'החזרת ציוד' });
      await userEvent.clear(within(dialog).getByRole('spinbutton', { name: /כמות/ }));
      await userEvent.type(within(dialog).getByRole('spinbutton', { name: /כמות/ }), quantity);
      await userEvent.type(within(dialog).getByRole('textbox', { name: 'הערה (רשות)' }), note);
      await userEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    }
    await userEvent.click(screen.getByRole('button', { name: 'אישור פעולות' }));
    const review = screen.getByRole('dialog', { name: 'אישור פעולות' });
    const rows = within(review)
      .getAllByText(/החזרת ציוד · [12]/)
      .map((label) => label.closest('.borrower-review-row'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('החזרת ציוד · 1');
    expect(rows[0]?.textContent).toContain('first returned unit');
    expect(rows[0]?.textContent).not.toContain('next returned units');
    expect(rows[1]?.textContent).toContain('החזרת ציוד · 2');
    expect(rows[1]?.textContent).toContain('next returned units');
    expect(rows[1]?.textContent).not.toContain('first returned unit');
  });
  it('stages loss through the deliberate menu and protects a dependent recovery cancellation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot') return json(desk());
        throw new Error(`Unexpected ${path}`);
      }),
    );
    const toast = vi.fn();
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={toast} />
      </DialogStackProvider>,
    );
    await userEvent.type(await screen.findByRole('searchbox', { name: 'חיפוש שואל' }), 'א');
    await activateBorrowerAction();
    const more = await screen.findByRole('button', { name: 'אפשרויות נוספות' });
    fireEvent.keyDown(more, { key: 'ArrowDown' });
    const markLost = await screen.findByRole('menuitem', { name: 'סמן כאבוד' });
    expect(document.activeElement).toBe(markLost);
    await userEvent.click(markLost);
    expect(screen.queryByRole('menu')).toBeNull();
    let lossDialog = screen.getByRole('dialog', { name: 'סמן כאבוד' });
    expectDialogItem(lossDialog, item.name);
    expect(within(lossDialog).queryByRole('checkbox')).toBeNull();
    const lossQuantity = within(lossDialog).getByRole('spinbutton', { name: /כמות/ });
    await userEvent.clear(lossQuantity);
    await userEvent.type(lossQuantity, '9');
    await userEvent.click(within(lossDialog).getByRole('button', { name: 'אישור' }));
    expect(within(lossDialog).getByRole('alert').textContent).toContain('ניתן לסמן כאבוד');
    await userEvent.click(within(lossDialog).getByRole('button', { name: 'ביטול' }));
    await waitFor(() => expect(document.activeElement).toBe(more));
    await userEvent.click(more);
    await userEvent.click(screen.getByRole('menuitem', { name: 'סמן כאבוד' }));
    lossDialog = screen.getByRole('dialog', { name: 'סמן כאבוד' });
    let quantity = screen.getByRole('spinbutton', { name: /כמות/ });
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '2');
    await userEvent.click(within(lossDialog).getByRole('button', { name: 'אישור' }));
    expect(screen.getByText('(3)')).toBeTruthy();
    expect(screen.getByText('אין ציוד אצל השואל')).toBeTruthy();
    await userEvent.click(screen.getByText('ציוד אבוד של השואל'));
    await userEvent.click(screen.getByRole('button', { name: 'נמצא והוחזר' }));
    quantity = screen.getByRole('spinbutton', { name: /כמות/ });
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '2');
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'נמצא והוחזר' })).getByRole('button', {
        name: 'אישור',
      }),
    );
    const lossRow = screen.getByText(/סמן כאבוד · 2/).closest('.borrower-pending-row')!;
    await userEvent.click(
      within(lossRow as HTMLElement).getByRole('button', { name: 'ביטול פעולה' }),
    );
    expect(toast).toHaveBeenCalledWith(
      'נדרשת תשומת לב',
      'יש לבטל תחילה את הפעולה התלויה בסימון כאבוד.',
      'warning',
    );
    expect(screen.getByText(/סמן כאבוד · 2/)).toBeTruthy();
    const foundRow = screen.getByText(/נמצא והוחזר · 2/).closest('.borrower-pending-row')!;
    await userEvent.click(
      within(foundRow as HTMLElement).getByRole('button', { name: 'ביטול פעולה' }),
    );
    await userEvent.click(
      within(
        screen.getByText(/סמן כאבוד · 2/).closest('.borrower-pending-row') as HTMLElement,
      ).getByRole('button', { name: 'ביטול פעולה' }),
    );
    expectHeldQuantity(2);
    expect(screen.getByText('(1)')).toBeTruthy();
  });
  it('fails closed on malformed startup truth and exposes one focused explicit retry', async () => {
    let valid = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        valid
          ? json({ ledgerEpoch: 3, active: [], archivedMatches: [] })
          : json({ ledgerEpoch: 3 }),
      ),
    );
    const toast = vi.fn();
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={toast} />
      </DialogStackProvider>,
    );
    const retry = await screen.findByRole('button', { name: 'ניסיון טעינה מחדש' });
    await waitFor(() => expect(document.activeElement).toBe(retry));
    expect(toast).toHaveBeenCalledTimes(1);
    valid = true;
    await userEvent.click(retry);
    expect(await screen.findByRole('searchbox', { name: 'חיפוש שואל' })).toBeTruthy();
  });
  it('renders a filterable directory with the create action in the page header', async () => {
    const second = {
      ...borrower,
      id: 9,
      playaName: 'new-account',
      fullName: 'שואל נוסף',
      phoneNumber: '052',
      campDepartment: 'מחנה אחר' as const,
    };
    let resolveFiltered: (() => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const query = new URL(String(input), 'http://localhost').searchParams.get('q') ?? '';
        if (query === 'new')
          return await new Promise<Response>((resolve) => {
            resolveFiltered = () =>
              resolve(json({ ledgerEpoch: 3, active: [second], archivedMatches: [] }));
          });
        return json({
          ledgerEpoch: 3,
          active: [borrower, second],
          archivedMatches: [],
        });
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    const search = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    expect(await screen.findByText('2 שואלים פעילים')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'ספריית שואלים פעילים' })).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(
      document
        .querySelector('.borrower-workflow-header')
        ?.contains(screen.getByRole('button', { name: 'יצירת שואל חדש' })),
    ).toBe(true);
    expect(document.querySelector('.borrower-search-row button')).toBeNull();
    const activeRow = screen
      .getByRole('button', { name: `פתיחת כרטיס שואל — ${borrower.fullName}` })
      .closest('tr')!;
    expect(within(activeRow).getByText('050').closest('bdi')?.getAttribute('dir')).toBe('ltr');
    expect(within(activeRow).getByText('אור')).toBeTruthy();
    const secondRow = screen
      .getByRole('button', { name: `פתיחת כרטיס שואל — ${second.fullName}` })
      .closest('tr')!;
    expect(within(secondRow).getByText('052').closest('bdi')?.getAttribute('dir')).toBe('ltr');
    expect(within(secondRow).getByText('מחנה אחר')).toBeTruthy();
    await userEvent.type(search, 'new');
    expect(screen.getAllByText('טוען תוצאות…')).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: `פתיחת כרטיס שואל — ${borrower.fullName}` }),
    ).toBeNull();
    await waitFor(() => expect(resolveFiltered).toBeDefined());
    resolveFiltered?.();
    expect(await screen.findByText('שואל פעיל אחד')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: `פתיחת כרטיס שואל — ${second.fullName}` }),
    ).toBeTruthy();
  });
  it('opens the non-archived borrow catalog on item-search focus and filters it', async () => {
    const secondItem = {
      ...item,
      id: 87941,
      name: 'צילייה',
      aliases: ['Canopy'],
    };
    const archivedItem = {
      ...item,
      id: 13,
      name: 'פריט ישן',
      archived: true,
      selectable: false,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot')
          return json({ ...desk(), inventory: [item, secondItem, archivedItem] });
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: `פתיחת כרטיס שואל — ${borrower.fullName}` }),
    );
    const itemSearch = await screen.findByRole('combobox', { name: 'חיפוש פריט' });
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('.borrower-identity-meta')),
    );
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.click(itemSearch);
    const catalog = await screen.findByRole('listbox');
    expect(within(catalog).getByRole('option', { name: /אוהל/ })).toBeTruthy();
    expect(within(catalog).getByRole('option', { name: /צילייה/ })).toBeTruthy();
    expect(within(catalog).queryByRole('option', { name: /פריט ישן/ })).toBeNull();
    const usableAction = screen.getByRole('button', { name: 'החזרת ציוד' });
    expect(usableAction.querySelector('svg[aria-hidden="true"].lucide-circle-check')).toBeTruthy();
    const moreAction = screen.getByRole('button', { name: 'אפשרויות נוספות' });
    expect(moreAction.textContent).not.toMatch(/…|\.\.\./);
    await userEvent.click(moreAction);
    expect(
      screen.getByRole('menuitem', { name: 'סמן כאבוד' }).querySelector('svg[aria-hidden="true"]'),
    ).toBeTruthy();
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem')).toHaveLength(1);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(itemSearch);
    await userEvent.type(itemSearch, 'canopy');
    const filteredCatalog = await screen.findByRole('listbox');
    expect(within(filteredCatalog).queryByRole('option', { name: /אוהל/ })).toBeNull();
    expect(within(filteredCatalog).getByRole('option', { name: /צילייה/ })).toBeTruthy();
    await userEvent.clear(itemSearch);
    await userEvent.type(itemSearch, String(secondItem.id));
    expect(screen.queryByRole('option', { name: /צילייה/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /אוהל/ })).toBeNull();
    await userEvent.clear(itemSearch);
    await userEvent.type(itemSearch, secondItem.name);
    expect(screen.getByRole('option', { name: /צילייה/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /אוהל/ })).toBeNull();
    await userEvent.clear(itemSearch);
    expect(within(filteredCatalog).getByRole('option', { name: /אוהל/ })).toBeTruthy();
    expect(within(filteredCatalog).getByRole('option', { name: /צילייה/ })).toBeTruthy();
    fireEvent.keyDown(itemSearch, { key: 'Enter' });
    let dialog = await screen.findByRole('dialog', { name: 'הוספת השאלה' });
    expectDialogItem(dialog, item.name);
    await userEvent.click(within(dialog).getByRole('button', { name: 'ביטול' }));
    await userEvent.click(itemSearch);
    await userEvent.type(itemSearch, 'canopy');
    await userEvent.click(screen.getByRole('option', { name: /צילייה/ }));
    dialog = await screen.findByRole('dialog', { name: 'הוספת השאלה' });
    expectDialogItem(dialog, secondItem.name);
    expect(within(dialog).queryByText(`פריט: ${item.name}`)).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'אישור' }));
    expect(
      within(screen.getByRole('region', { name: 'פעולות ממתינות' })).getByText('צילייה'),
    ).toBeTruthy();
  });
  it('loads authoritative search, separates archived matches, stages opposing directions, and persists before save transport', async () => {
    let operationPosted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({
            ledgerEpoch: 3,
            active: [borrower],
            archivedMatches: [{ borrower: archived, matchedBy: 'full_name' }],
          });
        if (path === '/api/borrowers/7/desk-snapshot') return json(desk(operationPosted ? 2 : 1));
        if (path === '/api/borrowers/7/operations') {
          operationPosted = true;
          const key = new Headers(init.headers).get('idempotency-key');
          expect(key).toMatch(/^[0-9a-f-]{36}$/i);
          expect(localStorage.getItem(`mapatz:frozen-attempt:v1:${key}`)).not.toBeNull();
          const body = JSON.parse(String(init.body));
          expect(body.items[0]).toMatchObject({
            itemId: 11,
            borrow: [{ quantity: 1, note: '', locationId: 1 }],
            return: [{ usable: 2, damaged: 0, note: '', locationId: 1 }],
          });
          return json({ outcome: 'committed', idempotencyKey: key, replayed: false }, 201);
        }
        throw new Error(`Unexpected ${init.method ?? 'GET'} ${path}`);
      }),
    );
    const toast = vi.fn();
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={toast} />
      </DialogStackProvider>,
    );
    const borrowerSearch = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await waitFor(() => expect(document.activeElement).toBe(borrowerSearch));
    await userEvent.type(borrowerSearch, 'אור');
    const archivedNotice = await screen.findByRole('complementary', {
      name: 'התאמות בארכיון',
    });
    expect(within(archivedNotice).getByText(/אור הישן/)).toBeTruthy();
    expect(within(archivedNotice).queryByRole('button')).toBeNull();
    const borrowerAction = await screen.findByRole('button', {
      name: `פתיחת כרטיס שואל — ${borrower.fullName}`,
    });
    await userEvent.click(within(borrowerAction.closest('tr')!).getByText('050'));
    const itemSearch = await screen.findByRole('combobox', { name: 'חיפוש פריט' });
    await userEvent.type(itemSearch, 'אוהל');
    fireEvent.keyDown(itemSearch, { key: 'ArrowDown' });
    fireEvent.keyDown(itemSearch, { key: 'Enter' });
    await userEvent.click(screen.getByRole('button', { name: 'אישור' }));
    const pendingTransactions = screen.getByRole('region', { name: 'פעולות ממתינות' });
    expect(await within(pendingTransactions).findByText(/השאלה · 1/)).toBeTruthy();
    expect(
      screen.getAllByRole('status').some((node) => /השאלה, כמות 1/.test(node.textContent ?? '')),
    ).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'החזרת ציוד' }));
    const returnDialog = screen.getByRole('dialog', { name: 'החזרת ציוד' });
    const returnQuantity = within(returnDialog).getByRole('spinbutton', {
      name: /כמות/,
    }) as HTMLInputElement;
    expect(returnQuantity.value).toBe('2');
    await userEvent.click(within(returnDialog).getByRole('button', { name: 'אישור' }));
    expect(within(pendingTransactions).getByText(/החזרת ציוד · 2/)).toBeTruthy();
    expect(within(pendingTransactions).queryByText(/[+−-]\d/)).toBeNull();
    await waitFor(() => expect(document.activeElement?.tagName).toBe('BUTTON'));
    expect(screen.getAllByRole('button', { name: 'ביטול פעולה' })).toHaveLength(2);
    await confirmSave();
    await waitFor(() => expect(operationPosted).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /כרטיס שואל/ })).toBeNull());
    expect(toast).toHaveBeenCalledWith('הפעולה הושלמה', 'השמירה הושלמה.', 'success');
  });
  it('requires explicit review confirmation and returns to borrower search after saving', async () => {
    let posted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot') return json(desk(posted ? 2 : 1));
        if (path === '/api/borrowers/7/operations') {
          posted = true;
          const key = new Headers(init.headers).get('idempotency-key');
          return json({ outcome: 'committed', idempotencyKey: key, replayed: false }, 201);
        }
        throw new Error(`Unexpected ${path}`);
      }),
    );
    const toast = vi.fn();
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={toast} />
      </DialogStackProvider>,
    );
    const borrowerSearch = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await userEvent.type(borrowerSearch, 'א');
    await activateBorrowerAction(' ');
    const itemSearch = await screen.findByRole('combobox', { name: 'חיפוש פריט' });
    await userEvent.type(itemSearch, 'אוהל');
    fireEvent.keyDown(itemSearch, { key: 'ArrowDown' });
    fireEvent.keyDown(itemSearch, { key: 'Enter' });
    await userEvent.click(screen.getByRole('button', { name: 'אישור' }));
    await userEvent.click(screen.getByRole('button', { name: 'אישור פעולות' }));
    expect(screen.getByRole('dialog', { name: 'אישור פעולות' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'חזרה לעריכה' }));
    expect(posted).toBe(false);
    expect(screen.getByRole('region', { name: 'פעולות ממתינות' }).textContent).toContain(
      'השאלה · 1',
    );
    expectHeldQuantity(3);
    await userEvent.click(screen.getByRole('button', { name: 'אישור פעולות' }));
    await userEvent.click(screen.getByRole('button', { name: 'אישור ושמירה' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /כרטיס שואל/ })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(borrowerSearch));
    expect((borrowerSearch as HTMLInputElement).value).toBe('');
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('הפעולה הושלמה', 'השמירה הושלמה.', 'success');
  });
  it('closes the card but blocks borrower search until committed truth can be refreshed', async () => {
    let posted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot') {
          if (posted) throw new Error('refresh offline');
          return json(desk());
        }
        if (path === '/api/borrowers/7/operations') {
          posted = true;
          const key = new Headers(init.headers).get('idempotency-key');
          return json({ outcome: 'committed', idempotencyKey: key, replayed: false }, 201);
        }
        throw new Error(`Unexpected ${path}`);
      }),
    );
    const toast = vi.fn();
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={toast} />
      </DialogStackProvider>,
    );
    const borrowerSearch = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await userEvent.type(borrowerSearch, 'א');
    await activateBorrowerAction();
    const itemSearch = await screen.findByRole('combobox', { name: 'חיפוש פריט' });
    await userEvent.type(itemSearch, 'אוהל');
    fireEvent.keyDown(itemSearch, { key: 'ArrowDown' });
    fireEvent.keyDown(itemSearch, { key: 'Enter' });
    await userEvent.click(screen.getByRole('button', { name: 'אישור' }));
    await confirmSave();
    const retry = await screen.findByRole('button', { name: 'אימות נתוני האמת לפני המשך' });
    await waitFor(() => expect(document.activeElement).toBe(retry));
    expect(screen.queryByRole('dialog', { name: /כרטיס שואל/ })).toBeNull();
    expect((borrowerSearch as HTMLInputElement).disabled).toBe(true);
    expect((borrowerSearch as HTMLInputElement).value).toBe('');
    expect(toast).toHaveBeenCalledWith(
      'נדרשת תשומת לב',
      'הפעולה אושרה, אך התצוגה טרם אומתה.',
      'warning',
    );
  });
  it('replaces truth after a conflict, retains staging, annotates it, and focuses the first conflict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot') return json(desk());
        if (path === '/api/borrowers/7/operations') {
          const key = new Headers(init.headers).get('idempotency-key');
          return json(
            {
              error: 'borrower_operation_conflict',
              message: 'Inventory changed',
              outcome: 'rejected',
              idempotencyKey: key,
              replayed: false,
              conflicts: [
                {
                  scope: 'borrow',
                  locationId: 1,
                  code: 'insufficient_stock',
                  itemId: 11,
                  requested: 1,
                  availableAfterUsableReturns: 0,
                },
              ],
              snapshot: {
                ...desk(2),
                inventory: [
                  {
                    ...item,
                    available: 0,
                    balances: [{ locationId: 1, available: 0, damaged: 0 }],
                  },
                ],
              },
            },
            409,
          );
        }
        throw new Error(`Unexpected ${path}`);
      }),
    );
    const toast = vi.fn();
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={toast} />
      </DialogStackProvider>,
    );
    const borrowerSearch = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await userEvent.type(borrowerSearch, 'א');
    await activateBorrowerAction();
    const itemSearch = await screen.findByRole('combobox', { name: 'חיפוש פריט' });
    await userEvent.type(itemSearch, 'אוהל');
    fireEvent.keyDown(itemSearch, { key: 'ArrowDown' });
    fireEvent.keyDown(itemSearch, { key: 'Enter' });
    await userEvent.click(screen.getByRole('button', { name: 'אישור' }));
    await confirmSave();
    const conflict = await screen.findByText('אין די מלאי זמין');
    const row = conflict.closest('[data-compatible="false"]')! as HTMLElement;
    expect(within(row).getByText(/השאלה · 1/)).toBeTruthy();
    expect(within(row).queryByText(/[+−-]1/)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('נדרשת תשומת לב', 'Inventory changed', 'warning');
  });
  it('retains staged return and loss after a held conflict until an explicit reconciled retry', async () => {
    const postedBodies: Array<{
      items: Array<Record<string, unknown>>;
    }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot')
          return json(
            postedBodies.length < 2
              ? desk()
              : {
                  ...desk(3),
                  holdings: [{ itemId: 11, returnable: 0, lost: 1 }],
                  inventory: [{ ...item, available: 5 }],
                },
          );
        if (path === '/api/borrowers/7/operations') {
          postedBodies.push(JSON.parse(String(init.body)));
          const key = new Headers(init.headers).get('idempotency-key');
          if (postedBodies.length === 1)
            return json(
              {
                error: 'borrower_operation_conflict',
                message: 'Held balance changed',
                outcome: 'rejected',
                idempotencyKey: key,
                replayed: false,
                conflicts: [
                  {
                    scope: 'held',
                    code: 'held_balance_changed',
                    itemId: 11,
                    requested: 2,
                    returnable: 1,
                  },
                ],
                snapshot: {
                  ...desk(2),
                  holdings: [{ itemId: 11, returnable: 1, lost: 1 }],
                },
              },
              409,
            );
          return json({ outcome: 'committed', idempotencyKey: key, replayed: false }, 201);
        }
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    await userEvent.type(await screen.findByRole('searchbox', { name: 'חיפוש שואל' }), 'א');
    await activateBorrowerAction();
    await userEvent.click(screen.getByRole('button', { name: 'החזרת ציוד' }));
    const returnDialog = screen.getByRole('dialog', { name: 'החזרת ציוד' });
    await userEvent.clear(within(returnDialog).getByRole('spinbutton', { name: /כמות/ }));
    await userEvent.type(within(returnDialog).getByRole('spinbutton', { name: /כמות/ }), '1');
    await userEvent.click(within(returnDialog).getByRole('button', { name: 'אישור' }));
    await userEvent.click(screen.getByRole('button', { name: 'אפשרויות נוספות' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'סמן כאבוד' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'סמן כאבוד' })).getByRole('button', {
        name: 'אישור',
      }),
    );
    await confirmSave();
    expect(await screen.findAllByText('יתרת הציוד אצל השואל השתנתה')).not.toHaveLength(0);
    const pending = screen.getByRole('region', { name: 'פעולות ממתינות' });
    expect(within(pending).getByText(/החזרת ציוד · 1/)).toBeTruthy();
    const lossRow = within(pending)
      .getByText(/סמן כאבוד · 1/)
      .closest('.borrower-pending-row')!;
    expect(postedBodies).toHaveLength(1);
    await userEvent.click(
      within(lossRow as HTMLElement).getByRole('button', { name: 'ביטול פעולה' }),
    );
    expect(within(pending).queryByText(/סמן כאבוד · 1/)).toBeNull();
    expect(within(pending).getByText(/החזרת ציוד · 1/)).toBeTruthy();
    await confirmSave();
    await waitFor(() => expect(postedBodies).toHaveLength(2));
    expect(postedBodies[0]?.items[0]).toMatchObject({
      return: [{ usable: 1, damaged: 0, note: '', locationId: 1 }],
      lost: [{ quantity: 1, note: '' }],
    });
    expect(postedBodies[1]?.items[0]).toMatchObject({
      return: [{ usable: 1, damaged: 0, note: '', locationId: 1 }],
    });
    expect(postedBodies[1]?.items[0]).not.toHaveProperty('lost');
  });
  it('keeps an invalid return dialog open, focuses its first error control, and protects dirty exit with one alertdialog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot') return json(desk());
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    const search = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await userEvent.type(search, 'א');
    await activateBorrowerAction();
    await userEvent.click(await screen.findByRole('button', { name: 'החזרת ציוד' }));
    const usable = screen.getByRole('spinbutton', { name: /כמות/ });
    await userEvent.clear(usable);
    await userEvent.type(usable, '9');
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'החזרת ציוד' })).getByRole('button', {
        name: 'אישור',
      }),
    );
    expect(screen.getByRole('alert').textContent).toContain('1 ל־2');
    expect(document.activeElement).toBe(usable);
    await userEvent.clear(usable);
    await userEvent.type(usable, '1');
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'החזרת ציוד' })).getByRole('button', {
        name: 'אישור',
      }),
    );
    await userEvent.click(
      screen
        .getAllByRole('button', { name: 'סגירה' })
        .find((button) => button.classList.contains('secondary-button'))!,
    );
    expect(screen.getByRole('alertdialog', { name: 'ביטול פעולות ממתינות?' })).toBeTruthy();
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'המשך עבודה' }));
    expect(screen.getByRole('dialog', { name: /כרטיס שואל/ })).toBeTruthy();
  });
  it('freezes an ambiguous save and retries the exact durable envelope without synthesizing a key', async () => {
    const posts: Array<{
      key: string | null;
      body: string;
    }> = [];
    let first = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot') return json(desk(first ? 1 : 2));
        if (path === '/api/borrowers/7/operations') {
          const key = new Headers(init.headers).get('idempotency-key');
          posts.push({ key, body: String(init.body) });
          if (first) {
            first = false;
            throw new Error('connection lost');
          }
          return json({ outcome: 'committed', idempotencyKey: key, replayed: false }, 201);
        }
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    const search = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await userEvent.type(search, 'א');
    await activateBorrowerAction();
    const itemSearch = await screen.findByRole('combobox', { name: 'חיפוש פריט' });
    await userEvent.type(itemSearch, 'אוהל');
    fireEvent.keyDown(itemSearch, { key: 'ArrowDown' });
    fireEvent.keyDown(itemSearch, { key: 'Enter' });
    await userEvent.click(screen.getByRole('button', { name: 'אישור' }));
    await confirmSave();
    const retry = await screen.findByRole('button', { name: 'בדיקת תוצאת השמירה' });
    expect(screen.getByRole('button', { name: 'אישור פעולות' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(
      screen
        .getAllByRole('button', { name: 'סגירה' })
        .every((button) => button.hasAttribute('disabled')),
    ).toBe(true);
    await userEvent.click(retry);
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual(posts[0]);
    await waitFor(() =>
      expect(screen.queryAllByRole('button', { name: 'ביטול פעולה' })).toHaveLength(0),
    );
  });
  it('creates through one durable command and preserves the selected new borrower when card loading fails', async () => {
    const created = {
      ...borrower,
      id: 12,
      playaName: 'new-user',
      fullName: 'שואל חדש',
      phoneNumber: '',
    };
    let cardLoads = 0;
    let createPosts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({
            ledgerEpoch: 3,
            active: createPosts > 0 ? [created] : [],
            archivedMatches: [],
          });
        if (path === '/api/borrowers') {
          createPosts += 1;
          const key = new Headers(init.headers).get('idempotency-key');
          expect(localStorage.getItem(`mapatz:frozen-attempt:v1:${key}`)).not.toBeNull();
          expect(JSON.parse(String(init.body))).toMatchObject({
            contractVersion: 1,
            ledgerEpoch: 3,
            playaName: 'new-user',
            fullName: 'שואל חדש',
          });
          return json(
            { outcome: 'committed', idempotencyKey: key, replayed: false, borrower: created },
            201,
          );
        }
        if (path === '/api/borrowers/12/desk-snapshot') {
          cardLoads += 1;
          if (cardLoads === 1) throw new Error('offline');
          return json({ ...desk(), borrower: created });
        }
        throw new Error(`Unexpected ${path}`);
      }),
    );
    const toast = vi.fn();
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={toast} />
      </DialogStackProvider>,
    );
    await userEvent.type(await screen.findByRole('searchbox', { name: 'חיפוש שואל' }), 'unrelated');
    await userEvent.click(await screen.findByRole('button', { name: 'יצירת שואל חדש' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'שם פלאיה' }), 'new-user');
    await userEvent.type(screen.getByRole('textbox', { name: 'שם מלא' }), 'שואל חדש');
    await userEvent.click(screen.getByRole('button', { name: 'יצירה' }));
    const retry = await screen.findByRole('button', { name: 'ניסיון פתיחת הכרטיס מחדש' });
    expect(document.activeElement).toBe(retry);
    expect(screen.getByRole('dialog', { name: /שואל חדש/ })).toBeTruthy();
    expect(createPosts).toBe(1);
    await userEvent.click(retry);
    await screen.findByRole('combobox', { name: 'חיפוש פריט' });
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('.borrower-identity-meta')),
    );
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(createPosts).toBe(1);
    expect(toast).toHaveBeenCalledWith('הפעולה הושלמה', 'השואל נוצר בהצלחה.', 'success');
    await userEvent.click(
      screen
        .getAllByRole('button', { name: 'סגירה' })
        .find((button) => button.classList.contains('secondary-button'))!,
    );
    window.dispatchEvent(new PopStateEvent('popstate'));
    const createdRow = (
      await screen.findByRole('button', { name: `פתיחת כרטיס שואל — ${created.fullName}` })
    ).closest('tr')!;
    expect(within(createdRow).getAllByText('—')).toHaveLength(2);
    expect(within(createdRow).getByText('שואל חדש')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'חיפוש שואל' })).toHaveProperty('value', '');
  });
  it('opens the created card without waiting for a failed directory refresh', async () => {
    const created = {
      ...borrower,
      id: 12,
      playaName: 'new-user',
      fullName: 'שואל חדש',
      phoneNumber: '',
    };
    let emptySearches = 0;
    let rejectRefresh: ((error: Error) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        if (path === '/api/borrowers/search?q=') {
          emptySearches += 1;
          if (emptySearches === 1) return json({ ledgerEpoch: 3, active: [], archivedMatches: [] });
          return await new Promise<Response>((_resolve, reject) => {
            rejectRefresh = reject;
          });
        }
        if (path === '/api/borrowers/search?q=unrelated')
          return json({ ledgerEpoch: 3, active: [], archivedMatches: [] });
        if (path === '/api/borrowers') {
          const key = new Headers(init.headers).get('idempotency-key');
          return json(
            { outcome: 'committed', idempotencyKey: key, replayed: false, borrower: created },
            201,
          );
        }
        if (path === '/api/borrowers/12/desk-snapshot')
          return json({ ...desk(), borrower: created });
        throw new Error(`Unexpected ${path}`);
      }),
    );
    const toast = vi.fn();
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={toast} />
      </DialogStackProvider>,
    );
    const search = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await userEvent.type(search, 'unrelated');
    await screen.findByText('לא נמצאו שואלים פעילים מתאימים');
    await userEvent.click(screen.getByRole('button', { name: 'יצירת שואל חדש' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'שם פלאיה' }), 'new-user');
    await userEvent.type(screen.getByRole('textbox', { name: 'שם מלא' }), 'שואל חדש');
    await userEvent.click(screen.getByRole('button', { name: 'יצירה' }));
    expect(await screen.findByRole('combobox', { name: 'חיפוש פריט' })).toBeTruthy();
    expect(rejectRefresh).toBeDefined();
    rejectRefresh?.(new Error('offline'));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'רענון רשימת השואלים',
        'השואל נוצר, אך רשימת השואלים לא התרעננה. ניתן לנסות לחפש שוב.',
        'warning',
      ),
    );
    await userEvent.click(
      screen
        .getAllByRole('button', { name: 'סגירה' })
        .find((button) => button.classList.contains('secondary-button'))!,
    );
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(
      await screen.findByRole('button', { name: `פתיחת כרטיס שואל — ${created.fullName}` }),
    ).toBeTruthy();
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    expect(emptySearches).toBe(2);
  });
  it('reconciles creation persistence before exact retry and submits normalized values once', async () => {
    vi.stubGlobal('localStorage', failFirstWriteStorage());
    const created = {
      ...borrower,
      id: 12,
      playaName: 'new-user',
      fullName: 'שואל חדש',
      phoneNumber: '',
    };
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [], archivedMatches: [] });
        if (path === '/api/borrowers') {
          bodies.push(JSON.parse(String(init.body)));
          const key = new Headers(init.headers).get('idempotency-key');
          return json(
            { outcome: 'committed', idempotencyKey: key, replayed: false, borrower: created },
            201,
          );
        }
        if (path === '/api/borrowers/12/desk-snapshot')
          return json({ ...desk(), borrower: created });
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'יצירת שואל חדש' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'שם פלאיה' }), '  new-user  ');
    await userEvent.type(screen.getByRole('textbox', { name: 'שם מלא' }), '  שואל חדש  ');
    await userEvent.click(screen.getByRole('button', { name: 'יצירה' }));
    expect(bodies).toHaveLength(0);
    await userEvent.click(await screen.findByRole('button', { name: 'בדיקת הפעולה' }));
    await screen.findByRole('combobox', { name: 'חיפוש פריט' });
    expect(bodies).toEqual([
      expect.objectContaining({ playaName: 'new-user', fullName: 'שואל חדש', phoneNumber: '' }),
    ]);
  });
  it('reconciles operation persistence before resolving the exact attempt', async () => {
    vi.stubGlobal('localStorage', failFirstWriteStorage());
    let posts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot') return json(desk(posts ? 2 : 1));
        if (path === '/api/borrowers/7/operations') {
          posts += 1;
          const key = new Headers(init.headers).get('idempotency-key');
          return json({ outcome: 'committed', idempotencyKey: key, replayed: false }, 201);
        }
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    const borrowerSearch = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await userEvent.type(borrowerSearch, 'א');
    await activateBorrowerAction();
    const itemSearch = await screen.findByRole('combobox', { name: 'חיפוש פריט' });
    await userEvent.type(itemSearch, 'אוהל');
    fireEvent.keyDown(itemSearch, { key: 'ArrowDown' });
    fireEvent.keyDown(itemSearch, { key: 'Enter' });
    await userEvent.click(screen.getByRole('button', { name: 'אישור' }));
    await confirmSave();
    expect(posts).toBe(0);
    await userEvent.click(
      await screen.findByRole('button', { name: 'בדיקה חוזרת של הפעולה השמורה' }),
    );
    await waitFor(() => expect(posts).toBe(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'ביטול פעולה' })).toBeNull());
  });
  it('resolves the exact frozen operation after a failed clear before closing the card', async () => {
    vi.stubGlobal('localStorage', failFirstRemoveStorage());
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot') return json(desk(posts.length ? 2 : 1));
        if (path === '/api/borrowers/7/operations') {
          const key = new Headers(init.headers).get('idempotency-key');
          posts.push(key!);
          return json(
            { outcome: 'committed', idempotencyKey: key, replayed: posts.length > 1 },
            201,
          );
        }
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    const borrowerSearch = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await userEvent.type(borrowerSearch, 'א');
    await activateBorrowerAction();
    const itemSearch = await screen.findByRole('combobox', { name: 'חיפוש פריט' });
    await userEvent.type(itemSearch, 'אוהל');
    fireEvent.keyDown(itemSearch, { key: 'ArrowDown' });
    fireEvent.keyDown(itemSearch, { key: 'Enter' });
    await userEvent.click(screen.getByRole('button', { name: 'אישור' }));
    await confirmSave();
    await userEvent.click(
      await screen.findByRole('button', { name: 'בדיקה חוזרת של הפעולה השמורה' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /כרטיס שואל/ })).toBeNull());
    expect(posts).toHaveLength(2);
    expect(posts[1]).toBe(posts[0]);
  });
  it('reloads the creation epoch without losing entered values', async () => {
    let epochChanged = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: epochChanged ? 4 : 3, active: [], archivedMatches: [] });
        if (path === '/api/borrowers') {
          epochChanged = true;
          const key = new Headers(init.headers).get('idempotency-key');
          return json(
            {
              error: 'ledger_epoch_changed',
              message: 'Epoch changed',
              outcome: 'protocol_error',
              idempotencyKey: key,
            },
            409,
          );
        }
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'יצירת שואל חדש' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'שם פלאיה' }), 'new-user');
    await userEvent.type(screen.getByRole('textbox', { name: 'שם מלא' }), 'שואל חדש');
    await userEvent.click(screen.getByRole('button', { name: 'יצירה' }));
    await userEvent.click(await screen.findByRole('button', { name: 'טעינת אמת עדכנית' }));
    expect((screen.getByRole('textbox', { name: 'שם פלאיה' }) as HTMLInputElement).value).toBe(
      'new-user',
    );
    expect((screen.getByRole('textbox', { name: 'שם מלא' }) as HTMLInputElement).value).toBe(
      'שואל חדש',
    );
    expect(screen.getByRole('button', { name: 'יצירה' }).hasAttribute('disabled')).toBe(false);
  });
  it('renders authoritative borrower identity from the loaded desk snapshot', async () => {
    const authoritativeBorrower = {
      ...borrower,
      fullName: 'אור המעודכן',
      phoneNumber: '052',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot')
          return json({ ...desk(), borrower: authoritativeBorrower });
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    const borrowerSearch = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await userEvent.type(borrowerSearch, 'א');
    await activateBorrowerAction();
    expect(await screen.findByRole('dialog', { name: /אור המעודכן/ })).toBeTruthy();
    expect(screen.getByText(/052/)).toBeTruthy();
  });
  it('ignores a desk snapshot that resolves after its loading card was closed', async () => {
    let resolveSnapshot: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot')
          return await new Promise<Response>((resolve) => {
            resolveSnapshot = resolve;
          });
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    const borrowerSearch = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await userEvent.type(borrowerSearch, 'א');
    await activateBorrowerAction();
    await screen.findByText('טוען כרטיס…');
    await userEvent.click(screen.getByRole('button', { name: 'סגירה' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    resolveSnapshot?.(json(desk()));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(history.pushState).not.toHaveBeenCalled();
  });
  it('rejects Browser Back while a clean card owns a quantity dialog', async () => {
    const toast = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot') return json(desk());
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={toast} />
      </DialogStackProvider>,
    );
    const borrowerSearch = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await userEvent.type(borrowerSearch, 'א');
    await activateBorrowerAction();
    const itemSearch = await screen.findByRole('combobox', { name: 'חיפוש פריט' });
    await userEvent.type(itemSearch, 'אוהל');
    fireEvent.keyDown(itemSearch, { key: 'ArrowDown' });
    fireEvent.keyDown(itemSearch, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'הוספת השאלה' })).toBeTruthy();
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(screen.getByRole('dialog', { name: 'הוספת השאלה' })).toBeTruthy();
    expect(toast).toHaveBeenCalledWith(
      'סיום חלון פעיל',
      'יש להשלים או לבטל את החלון הפנימי תחילה.',
      'warning',
    );
    expect(history.pushState).toHaveBeenCalledTimes(2);
  });
  it('retries the currently selected borrower after a created-card failure was closed', async () => {
    const created = {
      ...borrower,
      id: 12,
      playaName: 'new-user',
      fullName: 'שואל חדש',
      phoneNumber: '',
    };
    const cardLoads: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers') {
          const key = new Headers(init.headers).get('idempotency-key');
          return json(
            { outcome: 'committed', idempotencyKey: key, replayed: false, borrower: created },
            201,
          );
        }
        if (path === '/api/borrowers/12/desk-snapshot') {
          cardLoads.push(12);
          throw new Error('offline');
        }
        if (path === '/api/borrowers/7/desk-snapshot') {
          cardLoads.push(7);
          throw new Error('offline');
        }
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'יצירת שואל חדש' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'שם פלאיה' }), 'new-user');
    await userEvent.type(screen.getByRole('textbox', { name: 'שם מלא' }), 'שואל חדש');
    await userEvent.click(screen.getByRole('button', { name: 'יצירה' }));
    await userEvent.click(await screen.findByRole('button', { name: 'סגירה בטוחה' }));
    const borrowerSearch = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await userEvent.type(borrowerSearch, 'א');
    await activateBorrowerAction();
    await userEvent.click(await screen.findByRole('button', { name: 'ניסיון פתיחת הכרטיס מחדש' }));
    await waitFor(() => expect(cardLoads).toEqual([12, 7, 7]));
  });
  it('uses the shared reset for clean Back without duplicating App navigation in dialogs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot') return json(desk());
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    const borrowerSearch = await screen.findByRole('searchbox', { name: 'חיפוש שואל' });
    await userEvent.type(borrowerSearch, 'א');
    await activateBorrowerAction();
    const itemSearch = await screen.findByRole('combobox', { name: 'חיפוש פריט' });
    await userEvent.type(itemSearch, 'tent');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /כרטיס שואל/ })).toBeNull());
    await activateBorrowerAction();
    expect(
      ((await screen.findByRole('combobox', { name: 'חיפוש פריט' })) as HTMLInputElement).value,
    ).toBe('');
    expect(screen.queryByRole('combobox', { name: 'מעבר למסך אחר' })).toBeNull();
  });
});
it.each(['match', 'failure', 'stalled'])(
  'checks guidance before immediate creation and keeps failure nonblocking (%s)',
  async (scenario) => {
    const fails = scenario !== 'match';
    const abort = new AbortController();
    if (scenario === 'stalled') vi.spyOn(AbortSignal, 'timeout').mockReturnValue(abort.signal);
    const toast = vi.fn();
    let posts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [], archivedMatches: [] });
        if (path === '/api/borrowers/camp-suggestions') return json([]);
        if (path === '/api/borrowers/validate') {
          if (scenario === 'stalled')
            return new Promise<Response>((_, reject) =>
              init.signal!.addEventListener('abort', () => reject(new Error('timeout'))),
            );
          if (fails) throw new Error('offline');
          return json({
            fieldErrors: [],
            matches: [
              {
                borrower: {
                  ...borrower,
                  fullName: 'Ada',
                  phoneNumber: '050',
                  campDepartment: 'North',
                },
                matchedBy: 'full_name',
                status: 'active',
              },
            ],
          });
        }
        if (path === '/api/borrowers') {
          expect(toast).toHaveBeenCalledWith(
            fails ? 'בדיקת שואלים דומים נכשלה' : 'נמצאו שואלים עם פרטים דומים',
            expect.any(String),
            fails ? 'error' : 'warning',
          );
          posts++;
          return new Promise<Response>(() => {});
        }
        throw new Error(`Unexpected ${path}`);
      }),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={toast} />
      </DialogStackProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'יצירת שואל חדש' }));
    const name = screen.getByRole('textbox', { name: 'שם מלא' });
    fireEvent.change(name, { target: { value: 'Ada' } });
    if (scenario === 'failure')
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith('בדיקת שואלים דומים נכשלה', expect.any(String), 'error'),
      );
    fireEvent.submit(name.closest('form')!);
    if (scenario === 'stalled') {
      await waitFor(() => expect(AbortSignal.timeout).toHaveBeenCalledWith(3000));
      abort.abort();
    }
    await waitFor(() => expect(posts).toBe(1));
    expect(
      toast.mock.calls.filter(([, , tone]) => tone === (fails ? 'error' : 'warning')),
    ).toHaveLength(1);
  },
);

it.each([
  ['eligible', 1, '1'],
  ['ineligible', 2, ''],
  ['absent', null, ''],
] as const)(
  'preselects only an eligible configured source (%s) without fallback',
  async (_scenario, defaultLocationId, expected) => {
    const truth = {
      ...desk(),
      defaultLocationId,
      inventory: [
        {
          ...item,
          balances: [
            { locationId: 1, available: 4, damaged: 0 },
            { locationId: 2, available: 0, damaged: 0 },
          ],
        },
      ],
      locations: [
        { id: 1, name: 'Source A', code: 'a', archived: false, isDefault: defaultLocationId === 1 },
        { id: 2, name: 'Source B', code: 'b', archived: false, isDefault: defaultLocationId === 2 },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) =>
        String(input).includes('desk-snapshot')
          ? json(truth)
          : json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] }),
      ),
    );
    render(
      <DialogStackProvider>
        <BorrowerWorkflow showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    await userEvent.type(await screen.findByRole('searchbox', { name: 'חיפוש שואל' }), 'א');
    await activateBorrowerAction();
    const search = screen.getByRole('combobox', { name: 'חיפוש פריט' });
    await userEvent.type(search, item.name);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    const dialog = await screen.findByRole('dialog', { name: 'הוספת השאלה' });
    expect(within(dialog).getByLabelText('מיקום מקור')).toHaveProperty('value', expected);
  },
);
it('preselects an active default for returns even when it has no balance', async () => {
  const truth = {
    ...desk(),
    defaultLocationId: 2,
    locations: [
      { id: 1, name: 'Source A', code: 'a', archived: false, isDefault: false },
      { id: 2, name: 'Destination B', code: 'b', archived: false, isDefault: true },
    ],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) =>
      String(input).includes('desk-snapshot')
        ? json(truth)
        : json({ ledgerEpoch: 3, active: [borrower], archivedMatches: [] }),
    ),
  );
  render(
    <DialogStackProvider>
      <BorrowerWorkflow showToast={vi.fn()} />
    </DialogStackProvider>,
  );
  await userEvent.type(await screen.findByRole('searchbox', { name: 'חיפוש שואל' }), 'א');
  await activateBorrowerAction();
  await userEvent.click(screen.getByRole('button', { name: 'החזרת ציוד' }));
  const dialog = await screen.findByRole('dialog', { name: 'החזרת ציוד' });
  expect(within(dialog).getByLabelText('מיקום קבלה')).toHaveProperty('value', '2');
});
