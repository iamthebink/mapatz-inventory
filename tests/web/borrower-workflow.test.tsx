// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveDescendantCombobox } from '../../src/web/ActiveDescendantCombobox';
import { BorrowerWorkflow } from '../../src/web/BorrowerWorkflow';
import { DialogStackProvider } from '../../src/web/Dialog';

const borrower = {
  id: 7,
  username: 'or',
  name: 'אור',
  contact: '050',
  type: 'individual' as const,
  archived: false,
};
const archived = { ...borrower, id: 8, username: 'old', name: 'אור הישן', archived: true };
const item = {
  id: 11,
  code: 101,
  name: 'אוהל',
  kind: 'non_consumable' as const,
  lotSize: null,
  locationId: null,
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

function desk(asOfEventId = 1) {
  return {
    borrower,
    inventory: [item],
    holdings: [{ itemId: 11, returnable: 2, lost: 1 }],
    asOfEventId,
    ledgerEpoch: 3,
  };
}

async function activateBorrowerAction(key: 'Enter' | ' ' = 'Enter') {
  const action = await screen.findByRole('button', {
    name: `פתיחת כרטיס שואל — ${borrower.name}`,
  });
  action.focus();
  await userEvent.keyboard(key === 'Enter' ? '{Enter}' : ' ');
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

    expect(
      ((await screen.findByRole('button', { name: 'תקין' })) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'פגום' }) as HTMLButtonElement).disabled).toBe(true);
    const lost = screen.getByRole('button', { name: 'אבוד' });
    expect((lost as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(lost);
    const dialog = screen.getByRole('dialog', { name: 'החזרת ציוד אבוד' });
    expectDialogItem(dialog, item.name);
    const quantityInput = screen.getByRole('spinbutton', { name: 'כמות' }) as HTMLInputElement;
    expect(quantityInput.value).toBe('2');
    await waitFor(() => expect(document.activeElement).toBe(quantityInput));
    await userEvent.clear(quantityInput);
    await userEvent.type(quantityInput, '0');
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('alert').textContent).toContain('בין 1 ל־2');
    expectDialogItem(dialog, item.name);
    await userEvent.clear(quantityInput);
    await userEvent.type(quantityInput, '2');
    await userEvent.keyboard('{Enter}');

    const pending = screen.getByRole('region', { name: 'פעולות ממתינות' });
    expect(within(pending).getByText('החזרת אבוד')).toBeTruthy();
    expect(within(pending).getByText('2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'אבוד' })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'ציוד באחריות השואל' }),
      ),
    );
  });

  it('defaults usable returns to the full returnable balance and damaged returns to one', async () => {
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

    await userEvent.click(await screen.findByRole('button', { name: 'תקין' }));
    expectDialogItem(screen.getByRole('dialog', { name: 'החזרה תקינה' }), item.name);
    expect((screen.getByRole('spinbutton', { name: 'כמות' }) as HTMLInputElement).value).toBe('2');
    await userEvent.click(screen.getByRole('button', { name: 'ביטול' }));

    await userEvent.click(screen.getByRole('button', { name: 'פגום' }));
    expectDialogItem(screen.getByRole('dialog', { name: 'החזרה פגומה' }), item.name);
    expect((screen.getByRole('spinbutton', { name: 'כמות' }) as HTMLInputElement).value).toBe('1');
    await userEvent.click(screen.getByRole('button', { name: 'אישור' }));
    const pending = screen.getByRole('region', { name: 'פעולות ממתינות' });
    expect(within(pending).getByText('החזרה פגומה')).toBeTruthy();
    expect(within(pending).getByText('1')).toBeTruthy();
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
      username: 'new-account',
      name: 'שואל נוסף',
      contact: '052',
      type: 'other' as const,
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
      .getByRole('button', { name: `פתיחת כרטיס שואל — ${borrower.name}` })
      .closest('tr')!;
    expect(within(activeRow).getByText('050').closest('bdi')?.getAttribute('dir')).toBe('ltr');
    expect(within(activeRow).getByText('יחיד')).toBeTruthy();
    const secondRow = screen
      .getByRole('button', { name: `פתיחת כרטיס שואל — ${second.name}` })
      .closest('tr')!;
    expect(within(secondRow).getByText('052').closest('bdi')?.getAttribute('dir')).toBe('ltr');
    expect(within(secondRow).getByText('אחר')).toBeTruthy();

    await userEvent.type(search, 'new');
    expect(screen.getAllByText('טוען תוצאות…')).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: `פתיחת כרטיס שואל — ${borrower.name}` }),
    ).toBeNull();
    await waitFor(() => expect(resolveFiltered).toBeDefined());
    resolveFiltered?.();
    expect(await screen.findByText('שואל פעיל אחד')).toBeTruthy();
    expect(screen.getByRole('button', { name: `פתיחת כרטיס שואל — ${second.name}` })).toBeTruthy();
  });

  it('opens the non-archived borrow catalog on item-search focus and filters it', async () => {
    const secondItem = {
      ...item,
      id: 12,
      code: 102,
      name: 'צילייה',
      aliases: ['Canopy'],
    };
    const archivedItem = {
      ...item,
      id: 13,
      code: 103,
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
      await screen.findByRole('button', { name: `פתיחת כרטיס שואל — ${borrower.name}` }),
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
    expect(screen.getByRole('columnheader', { name: 'פעולות החזרה' })).toBeTruthy();
    for (const [label, iconClass] of [
      ['תקין', 'lucide-circle-check'],
      ['אבוד', 'lucide-search-check'],
      ['פגום', 'lucide-triangle-alert'],
    ] as const) {
      const action = screen.getByRole('button', { name: label });
      expect(action.querySelector(`svg[aria-hidden="true"].${iconClass}`)).toBeTruthy();
    }

    await userEvent.type(itemSearch, 'canopy');
    expect(within(catalog).queryByRole('option', { name: /אוהל/ })).toBeNull();
    expect(within(catalog).getByRole('option', { name: /צילייה/ })).toBeTruthy();
    await userEvent.clear(itemSearch);
    expect(within(catalog).getByRole('option', { name: /אוהל/ })).toBeTruthy();
    expect(within(catalog).getByRole('option', { name: /צילייה/ })).toBeTruthy();
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
            borrow: [{ quantity: 1, note: '' }],
            return: [{ usable: 2, damaged: 0, note: '' }],
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
      name: `פתיחת כרטיס שואל — ${borrower.name}`,
    });
    await userEvent.click(within(borrowerAction.closest('tr')!).getByText('050'));

    const itemSearch = await screen.findByRole('combobox', { name: 'חיפוש פריט' });
    await userEvent.type(itemSearch, 'אוהל');
    fireEvent.keyDown(itemSearch, { key: 'ArrowDown' });
    fireEvent.keyDown(itemSearch, { key: 'Enter' });
    await userEvent.click(screen.getByRole('button', { name: 'אישור' }));
    const pendingTransactions = screen.getByRole('region', { name: 'פעולות ממתינות' });
    expect(await within(pendingTransactions).findByText('1')).toBeTruthy();
    expect(
      screen.getAllByRole('status').some((node) => /השאלה, כמות 1/.test(node.textContent ?? '')),
    ).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'תקין' }));
    expect((screen.getByRole('spinbutton', { name: 'כמות' }) as HTMLInputElement).value).toBe('2');
    await userEvent.click(screen.getByRole('button', { name: 'אישור' }));
    expect(within(pendingTransactions).getByText('2')).toBeTruthy();
    expect(within(pendingTransactions).queryByText(/[+−-]\d/)).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'אבוד' })),
    );
    expect(screen.getAllByRole('button', { name: 'ביטול פעולה' })).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(operationPosted).toBe(true));
    await waitFor(() =>
      expect(within(pendingTransactions).queryByRole('button', { name: 'ביטול פעולה' })).toBeNull(),
    );
    expect(toast).toHaveBeenCalledWith('הפעולה הושלמה', 'השמירה הושלמה.', 'success');
  });

  it('closes after one confirmed Save-and-Close toast and restores Borrower Search focus', async () => {
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
    await userEvent.click(screen.getByRole('button', { name: 'שמירה וסגירה' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /כרטיס שואל/ })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(borrowerSearch));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('הפעולה הושלמה', 'השמירה הושלמה.', 'success');
  });

  it('keeps the committed projection explicitly unverified and focuses refresh retry', async () => {
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
    await userEvent.click(screen.getByRole('button', { name: 'שמירה' }));
    const retry = await screen.findByRole('button', { name: 'אימות נתוני האמת מחדש' });
    await waitFor(() => expect(document.activeElement).toBe(retry));
    const holdings = document.getElementById('holdings-heading')!.parentElement!;
    expect(within(holdings).getByText(/טרם אומת/)).toBeTruthy();
    expect(within(holdings).getByText('3')).toBeTruthy();
    expect(toast).toHaveBeenCalledTimes(1);
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
                  code: 'insufficient_stock',
                  itemId: 11,
                  requested: 1,
                  availableAfterUsableReturns: 0,
                },
              ],
              snapshot: {
                ...desk(2),
                inventory: [{ ...item, available: 0 }],
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
    await userEvent.click(screen.getByRole('button', { name: 'שמירה' }));
    const conflict = await screen.findByText('אין די מלאי זמין');
    const row = conflict.closest('tr')!;
    expect(within(row).getByText('1')).toBeTruthy();
    expect(within(row).queryByText(/[+−-]1/)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('נדרשת תשומת לב', 'Inventory changed', 'warning');
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
    await userEvent.click(await screen.findByRole('button', { name: 'תקין' }));
    const usable = screen.getByRole('spinbutton', { name: 'כמות' });
    await userEvent.clear(usable);
    await userEvent.type(usable, '9');
    await userEvent.click(screen.getByRole('button', { name: 'אישור' }));
    expect(screen.getByRole('alert').textContent).toContain('1 ל־2');
    expect(document.activeElement).toBe(usable);
    await userEvent.clear(usable);
    await userEvent.type(usable, '1');
    await userEvent.click(screen.getByRole('button', { name: 'אישור' }));
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
    const posts: Array<{ key: string | null; body: string }> = [];
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
    await userEvent.click(screen.getByRole('button', { name: 'שמירה' }));
    const retry = await screen.findByRole('button', { name: 'בדיקת תוצאת השמירה' });
    expect(screen.getByRole('button', { name: 'שמירה' }).hasAttribute('disabled')).toBe(true);
    expect(
      screen
        .getAllByRole('button', { name: 'סגירה' })
        .every((button) => button.hasAttribute('disabled')),
    ).toBe(true);
    await userEvent.click(retry);
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual(posts[0]);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'ביטול פעולה' })).toBeNull());
  });

  it('creates through one durable command and preserves the selected new borrower when card loading fails', async () => {
    const created = {
      ...borrower,
      id: 12,
      username: 'new-user',
      name: 'שואל חדש',
      contact: '',
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
            username: 'new-user',
            name: 'שואל חדש',
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
    await userEvent.type(screen.getByRole('textbox', { name: 'שם משתמש' }), 'new-user');
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
      await screen.findByRole('button', { name: `פתיחת כרטיס שואל — ${created.name}` })
    ).closest('tr')!;
    expect(within(createdRow).getByText('—')).toBeTruthy();
    expect(within(createdRow).getByText('יחיד')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'חיפוש שואל' })).toHaveProperty('value', '');
  });

  it('opens the created card without waiting for a failed directory refresh', async () => {
    const created = { ...borrower, id: 12, username: 'new-user', name: 'שואל חדש', contact: '' };
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
    await userEvent.type(screen.getByRole('textbox', { name: 'שם משתמש' }), 'new-user');
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
      await screen.findByRole('button', { name: `פתיחת כרטיס שואל — ${created.name}` }),
    ).toBeTruthy();
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    expect(emptySearches).toBe(2);
  });

  it('reconciles creation persistence before exact retry and submits normalized values once', async () => {
    vi.stubGlobal('localStorage', failFirstWriteStorage());
    const created = { ...borrower, id: 12, username: 'new-user', name: 'שואל חדש', contact: '' };
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
    await userEvent.type(screen.getByRole('textbox', { name: 'שם משתמש' }), '  new-user  ');
    await userEvent.type(screen.getByRole('textbox', { name: 'שם מלא' }), '  שואל חדש  ');
    await userEvent.click(screen.getByRole('button', { name: 'יצירה' }));
    expect(bodies).toHaveLength(0);
    await userEvent.click(await screen.findByRole('button', { name: 'בדיקת הפעולה' }));
    await screen.findByRole('combobox', { name: 'חיפוש פריט' });
    expect(bodies).toEqual([
      expect.objectContaining({ username: 'new-user', name: 'שואל חדש', contact: '' }),
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
    await userEvent.click(screen.getByRole('button', { name: 'שמירה' }));
    expect(posts).toBe(0);
    await userEvent.click(
      await screen.findByRole('button', { name: 'בדיקה חוזרת של הפעולה השמורה' }),
    );
    await waitFor(() => expect(posts).toBe(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'ביטול פעולה' })).toBeNull());
  });

  it('clears a confirmed operation recovery record without replaying the command', async () => {
    vi.stubGlobal('localStorage', failFirstRemoveStorage());
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
    await userEvent.click(screen.getByRole('button', { name: 'שמירה' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'בדיקה חוזרת של הפעולה השמורה' }),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'ביטול פעולה' })).toBeNull());
    expect(posts).toBe(1);
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
    await userEvent.type(screen.getByRole('textbox', { name: 'שם משתמש' }), 'new-user');
    await userEvent.type(screen.getByRole('textbox', { name: 'שם מלא' }), 'שואל חדש');
    await userEvent.click(screen.getByRole('button', { name: 'יצירה' }));
    await userEvent.click(await screen.findByRole('button', { name: 'טעינת אמת עדכנית' }));
    expect((screen.getByRole('textbox', { name: 'שם משתמש' }) as HTMLInputElement).value).toBe(
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
      name: 'אור המעודכן',
      contact: '052',
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
    const created = { ...borrower, id: 12, username: 'new-user', name: 'שואל חדש', contact: '' };
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
    await userEvent.type(screen.getByRole('textbox', { name: 'שם משתמש' }), 'new-user');
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
