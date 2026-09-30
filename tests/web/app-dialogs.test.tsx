// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/App';
import { DialogStackProvider } from '../../src/web/Dialog';
import type { Item } from '../../src/web/InventoryDialogs';
import type { Borrower } from '../../src/domain/types.js';
import { installWindowStorage } from '../helpers/window-storage.js';

const hammer: Item = {
  id: 11,
  code: 100,
  name: 'פטיש',
  kind: 'non_consumable',
  lotSize: null,
  locationId: 31,
  aliases: ['מקבת'],
  available: 3,
  borrowed: 2,
  lost: 1,
  damaged: 1,
  stockRevision: 6,
  archived: false,
};
const location = { id: 31, code: 'A-1', name: 'מחסן ראשי', archived: false };
const response = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
function setup(
  role: 'admin' | 'operator' = 'admin',
  startPath = '/management',
  initialItems: Item[] = [hammer],
  initialBorrowers: Borrower[] = [],
  storageUnavailable = false,
  createBorrower?: (body: Record<string, unknown>) => Promise<Response>,
  failBorrowerRefresh = false,
) {
  let currentRole = role;
  let items: Item[] = initialItems;
  let borrowers = initialBorrowers;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET')
      requests.push({
        path,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
    if (path === '/api/session')
      return response({
        role: currentRole,
        deadline: currentRole === 'admin' ? Date.now() + 600_000 : null,
      });
    if (path === '/api/session/activity')
      return response({
        role: currentRole,
        deadline: currentRole === 'admin' ? Date.now() + 600_000 : null,
      });
    if (path === '/api/items' || path === '/api/items?all=1') return response(items);
    if (path === '/api/borrowers?all=1') {
      if (failBorrowerRefresh && borrowers.length > initialBorrowers.length)
        return response({ error: 'server_error', message: 'Refresh unavailable' }, 500);
      return response(borrowers);
    }
    const deletionStatus = path.match(/^\/api\/borrowers\/(\d+)\/deletion-status$/);
    if (deletionStatus) {
      const borrower = borrowers.find((entry) => entry.id === Number(deletionStatus[1]));
      if (!borrower) return response({ error: 'not_found', message: 'Not found' }, 404);
      return response({ borrower, outstanding: 0, lost: 0, stateRevision: 7 });
    }
    const deletion = path.match(/^\/api\/borrowers\/(\d+)\/delete$/);
    if (deletion && method === 'POST') {
      const borrowerId = Number(deletion[1]);
      borrowers = borrowers.filter((entry) => entry.id !== borrowerId);
      return response({ outcome: 'committed', action: 'delete_borrower', borrowerId });
    }
    if (path === '/api/borrowers' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (createBorrower) {
        const result = await createBorrower(body);
        if (!result.ok) return result;
      }
      const borrower: Borrower = {
        id: 44,
        name: String(body.name),
        username: String(body.username),
        contact: String(body.contact),
        type: body.type as Borrower['type'],
        archived: false,
      };
      borrowers = [...borrowers, borrower];
      return response({ outcome: 'committed', borrower }, 201);
    }
    if (path === '/api/locations?all=1') return response([location]);
    if (path === '/api/inventory/epoch') return response({ ledgerEpoch: 1 });
    if (path === '/api/radios')
      return response({
        count: 1,
        generation: 1,
        radios: [{ number: 1, holder: 'צוללת', team: '', lost: false }],
      });
    if (path === '/api/borrowers/search?q=')
      return response({ ledgerEpoch: 1, active: [], archivedMatches: [] });
    if (path === '/api/ledger') return response([]);
    if (path === '/api/inventory/items' && method === 'POST') {
      if (currentRole !== 'admin')
        return response({ error: 'forbidden', message: 'אין הרשאה' }, 403);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const created: Item = {
        id: 12,
        code: 101,
        name: String(body.name),
        kind: body.kind as Item['kind'],
        aliases: body.aliases as string[],
        lotSize: body.lotSize as number | null,
        locationId: body.locationId as number | null,
        available: Number(body.targetAvailable ?? 0),
        borrowed: 0,
        lost: 0,
        damaged: 0,
        stockRevision: 7,
        archived: false,
      };
      items = [...items, created];
      return response(created, 201);
    }
    if (path === '/api/inventory/damage' && method === 'POST') return response({ eventId: 8 }, 201);
    if (path === '/api/session/role' && method === 'POST') {
      currentRole = 'operator';
      return response({ role: currentRole, deadline: null });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  window.history.replaceState({}, '', startPath);
  installWindowStorage();
  if (storageUnavailable)
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage access denied');
      },
    });
  const user = userEvent.setup();
  render(
    <DialogStackProvider>
      <App />
    </DialogStackProvider>,
  );
  return { user, requests };
}
afterEach(() => {
  cleanup();
  try {
    if (typeof window.localStorage?.clear === 'function') window.localStorage.clear();
  } catch {
    // A focused test may replace the browser storage getter with a throwing accessor.
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('inventory management in App', () => {
  it('creates a borrower from a dialog and refreshes the catalog', async () => {
    const { user, requests } = setup();
    await user.click(await screen.findByRole('tab', { name: /שואלים/ }));
    expect(screen.queryByRole('textbox', { name: 'שם משתמש' })).toBeNull();
    const trigger = screen.getByRole('button', { name: 'יצירת שואל חדש' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'יצירת שואל חדש' });
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'שם' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'שם' }), 'נועה');
    await user.type(within(dialog).getByRole('textbox', { name: 'שם משתמש' }), 'noa');
    await user.type(within(dialog).getByRole('textbox', { name: 'פרטי קשר' }), '0501234567');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'סוג' }), 'other');
    await user.click(within(dialog).getByRole('button', { name: 'יצירה' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requests.find((request) => request.path === '/api/borrowers')?.body).toEqual({
      contractVersion: 1,
      ledgerEpoch: 1,
      name: 'נועה',
      username: 'noa',
      contact: '0501234567',
      type: 'other',
    });
    expect(screen.getByRole('cell', { name: 'נועה' })).toBeTruthy();
    expect(screen.getByText('הפעולה הושלמה בהצלחה')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('preserves creation fields after rejection and blocks dismissal while pending', async () => {
    let rejectCreation!: (result: Response) => void;
    const { user, requests } = setup(
      'admin',
      '/management',
      [hammer],
      [],
      false,
      () =>
        new Promise<Response>((resolve) => {
          rejectCreation = resolve;
        }),
    );
    await user.click(await screen.findByRole('tab', { name: /שואלים/ }));
    const trigger = screen.getByRole('button', { name: 'יצירת שואל חדש' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'יצירת שואל חדש' });
    const name = within(dialog).getByRole('textbox', { name: 'שם' });
    await user.type(name, 'נועה');
    await user.type(within(dialog).getByRole('textbox', { name: 'שם משתמש' }), 'noa');
    await user.type(within(dialog).getByRole('textbox', { name: 'פרטי קשר' }), '0501234567');
    await user.click(within(dialog).getByRole('button', { name: 'יצירה' }));
    await waitFor(() => expect(rejectCreation).toBeTypeOf('function'));
    expect(name.closest('fieldset')?.disabled).toBe(true);
    expect(within(dialog).getByRole('button', { name: 'ביטול' })).toHaveProperty('disabled', true);
    fireEvent.submit(within(dialog).getByRole('textbox', { name: 'שם' }).closest('form')!);
    await user.keyboard('{Escape}');
    fireEvent.mouseDown(dialog.parentElement!);
    window.history.replaceState({}, '', '/summary');
    fireEvent.popState(window);
    expect(window.location.pathname).toBe('/management');
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(requests.filter((request) => request.path === '/api/borrowers')).toHaveLength(1);
    rejectCreation(response({ error: 'validation_error', message: 'שם המשתמש כבר קיים' }, 400));
    await screen.findByText('שם המשתמש כבר קיים');
    expect(name).toHaveProperty('value', 'נועה');
    expect(within(dialog).getByRole('textbox', { name: 'שם משתמש' })).toHaveProperty(
      'value',
      'noa',
    );
    expect(within(dialog).queryByRole('alert')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'ביטול' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.click(trigger);
    expect(screen.getByRole('textbox', { name: 'שם' })).toHaveProperty('value', '');
  });

  it('closes after committed creation even when catalog refresh fails', async () => {
    const { user, requests } = setup('admin', '/management', [hammer], [], false, undefined, true);
    await user.click(await screen.findByRole('tab', { name: /שואלים/ }));
    await user.click(screen.getByRole('button', { name: 'יצירת שואל חדש' }));
    await user.type(screen.getByRole('textbox', { name: 'שם' }), 'נועה');
    await user.type(screen.getByRole('textbox', { name: 'שם משתמש' }), 'noa');
    await user.type(screen.getByRole('textbox', { name: 'פרטי קשר' }), '0501234567');
    await user.click(screen.getByRole('button', { name: 'יצירה' }));
    await screen.findByText(/הפעולה הושלמה, אך התצוגה לא התרעננה/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requests.filter((request) => request.path === '/api/borrowers')).toHaveLength(1);
  });

  it('closes an idle creation dialog when browser navigation leaves management', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('tab', { name: /שואלים/ }));
    await user.click(screen.getByRole('button', { name: 'יצירת שואל חדש' }));
    window.history.replaceState({}, '', '/summary');
    fireEvent.popState(window);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.pathname).toBe('/summary');
  });

  it('keeps a borrower draft during navigation and follows the destination after discard', async () => {
    const { user } = setup('operator', '/');
    await user.click(await screen.findByRole('button', { name: 'יצירת שואל חדש' }));
    await user.type(screen.getByRole('textbox', { name: 'שם מלא' }), 'שואל חדש');
    fireEvent.click(screen.getByRole('link', { name: 'סיכום', hidden: true }));
    const discard = await screen.findByRole('alertdialog', { name: 'לבטל טיוטת שואל?' });
    expect(window.location.pathname).toBe('/');
    await user.click(within(discard).getByRole('button', { name: 'להמשיך לערוך' }));
    expect(screen.getByRole('textbox', { name: 'שם מלא' })).toHaveProperty('value', 'שואל חדש');
    fireEvent.click(screen.getByRole('link', { name: 'סיכום', hidden: true }));
    await user.click(
      within(await screen.findByRole('alertdialog', { name: 'לבטל טיוטת שואל?' })).getByRole(
        'button',
        { name: 'מחיקת טיוטה' },
      ),
    );
    await waitFor(() => expect(window.location.pathname).toBe('/summary'));
  });

  it('keeps borrower deletion unavailable when the browser storage getter throws', async () => {
    const borrower: Borrower = {
      id: 43,
      username: 'storage-user',
      name: 'Storage User',
      contact: '',
      type: 'individual',
      archived: false,
    };
    const { user, requests } = setup('admin', '/management', [hammer], [borrower], true);
    await user.click(await screen.findByRole('link', { name: 'ניהול' }));
    await user.click(await screen.findByRole('tab', { name: /שואלים/ }));
    await user.click(
      within(screen.getByRole('row', { name: /Storage User/ })).getByRole('button', {
        name: 'מחיקה',
      }),
    );
    await screen.findByRole('alertdialog', { name: 'למחוק לצמיתות את Storage User?' });
    await user.click(screen.getByRole('button', { name: 'מחק את השואל וההיסטוריה לצמיתות' }));

    expect(requests.some((request) => request.path === '/api/borrowers/43/delete')).toBe(false);
    expect(await screen.findByText(/אחסון השחזור בדפדפן אינו זמין/)).toBeTruthy();
  });

  it('guards a dirty desk batch across navigation and popstate until explicit discard', async () => {
    const tape: Item = {
      ...hammer,
      id: 20,
      code: 120,
      name: 'סרט',
      kind: 'consumable',
      available: 5,
      borrowed: 0,
      lost: 0,
      damaged: 0,
    };
    const { user } = setup('operator', '/', [hammer, tape]);
    expect(
      (await screen.findByRole('button', { name: 'השאלות והחזרות' })).getAttribute('aria-pressed'),
    ).toBe('true');
    await user.click(screen.getByRole('button', { name: 'ציוד מתכלה' }));
    await user.click(
      within(screen.getByRole('row', { name: /סרט/ })).getByRole('button', { name: 'ניפוק' }),
    );
    await user.click(screen.getByRole('button', { name: 'הוספה לעסקה' }));
    fireEvent.click(screen.getByRole('link', { name: 'סיכום', hidden: true }));
    expect(await screen.findByRole('alertdialog', { name: 'מחיקת טיוטת ניפוק?' })).toBeTruthy();
    expect(window.location.pathname).toBe('/');
    await user.click(screen.getByRole('button', { name: 'להמשיך לערוך' }));
    expect(screen.getByText('× 1')).toBeTruthy();
    window.history.replaceState({}, '', '/summary');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(await screen.findByRole('alertdialog', { name: 'מחיקת טיוטת ניפוק?' })).toBeTruthy();
    expect(window.location.pathname).toBe('/');
    await user.click(screen.getByRole('button', { name: 'מחיקת טיוטה' }));
    expect(window.location.pathname).toBe('/summary');
  });
  it('guards a dirty consumables draft when switching back to borrower work', async () => {
    const tape: Item = {
      ...hammer,
      id: 20,
      code: 120,
      name: 'סרט',
      kind: 'consumable',
      available: 5,
      borrowed: 0,
      lost: 0,
      damaged: 0,
    };
    const { user } = setup('operator', '/', [hammer, tape]);
    await user.click(await screen.findByRole('button', { name: 'ציוד מתכלה' }));
    await user.click(
      within(screen.getByRole('row', { name: /סרט/ })).getByRole('button', { name: 'ניפוק' }),
    );
    await user.click(screen.getByRole('button', { name: 'הוספה לעסקה' }));
    await user.click(screen.getByRole('button', { name: 'השאלות והחזרות' }));
    const discard = screen.getByRole('alertdialog', { name: 'מחיקת טיוטת ניפוק?' });
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
    expect(
      document
        .querySelector('[aria-controls="desk-consumables-panel"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    await user.click(screen.getByRole('button', { name: 'להמשיך לערוך' }));
    expect(screen.getByText('× 1')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'השאלות והחזרות' }));
    await user.click(screen.getByRole('button', { name: 'מחיקת טיוטה' }));
    expect(
      screen.getByRole('button', { name: 'השאלות והחזרות' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
  it('opens a restored uncertain batch in consumables and locks the view switch', async () => {
    const saved = JSON.stringify({
      key: '00000000-0000-4000-8000-000000000921',
      ledgerEpoch: 1,
      items: [{ itemId: 20, quantity: 1, note: '' }],
    });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'mapatz-consumable-batch-attempt' ? saved : null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    const tape: Item = {
      ...hammer,
      id: 20,
      code: 120,
      name: 'סרט',
      kind: 'consumable',
      available: 5,
      borrowed: 0,
      lost: 0,
      damaged: 0,
    };
    const { user } = setup('operator', '/', [hammer, tape]);
    const consumables = await screen.findByRole('button', { name: 'ציוד מתכלה' });
    expect(consumables.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'בדיקת הפעולה השמורה' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'השאלות והחזרות' }));
    expect(consumables.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('alertdialog', { name: 'מחיקת טיוטת ניפוק?' })).toBeNull();
  });
  it('keeps radio custody and count settings reachable after the merge', async () => {
    const { user } = setup('operator');
    await screen.findByRole('tab', { name: /מלאי ומיקומים/ });
    await user.click(screen.getByRole('link', { name: 'מכשירי קשר' }));
    expect(await screen.findByRole('heading', { name: 'רשימת מכשירים' })).toBeTruthy();
    await user.click(screen.getByRole('link', { name: 'ניהול' }));
    await user.click(screen.getByRole('tab', { name: /הרשאות והגדרות/ }));
    expect(await screen.findByRole('heading', { name: 'מספר מכשירי הקשר' })).toBeTruthy();
    expect(
      (screen.getByRole('spinbutton', { name: 'מספר מכשירי קשר' }) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it('shows one management section and the four item balances without a separate inventory tab', async () => {
    setup();
    const navigation = screen.getByRole('navigation', { name: 'ניווט ראשי' });
    expect(within(navigation).queryByRole('link', { name: 'מלאי' })).toBeNull();
    expect(await screen.findByRole('tab', { name: /מלאי ומיקומים/ })).toBeTruthy();
    expect(screen.queryByText('מלאי ופגומים')).toBeNull();
    expect(screen.queryByText('פריטים ומיקומים')).toBeNull();
    for (const name of ['זמין', 'מושאל', 'אבוד', 'פגום'])
      expect(screen.getByRole('columnheader', { name })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'פטיש' })).toBeTruthy();
  });

  it('preserves search after item inspection and opens locations for operators', async () => {
    const { user } = setup('operator');
    await screen.findByRole('button', { name: 'פטיש' });
    await user.type(screen.getByRole('textbox', { name: 'סינון הטבלה' }), 'מקבת');
    await user.click(screen.getByRole('button', { name: 'פטיש' }));
    expect((screen.getByRole('textbox', { name: 'שם פריט' }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'שמירה' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'העברה לארכיון' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'ביטול' }));
    expect((screen.getByRole('textbox', { name: 'סינון הטבלה' }) as HTMLInputElement).value).toBe(
      'מקבת',
    );
    await user.click(screen.getByRole('button', { name: 'מיקומים' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      within(document.getElementById('locations-view-panel')!).getByText('מחסן ראשי'),
    ).toBeTruthy();
    expect((screen.getByRole('button', { name: 'מיקום חדש' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'עריכה' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'ארכוב' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('creates an item with an initial available target through the unified dialog', async () => {
    const { user, requests } = setup();
    await screen.findByRole('button', { name: 'פטיש' });
    await user.click(screen.getByRole('button', { name: 'הוספת פריט חדש' }));
    await user.type(screen.getByRole('textbox', { name: 'שם פריט' }), 'שולחן');
    await user.clear(screen.getByRole('textbox', { name: 'זמין' }));
    await user.type(screen.getByRole('textbox', { name: 'זמין' }), '5');
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await waitFor(() =>
      expect(requests.some((request) => request.path === '/api/inventory/items')).toBe(true),
    );
    const save = requests.find((request) => request.path === '/api/inventory/items')!;
    expect(save.body).toMatchObject({ name: 'שולחן', targetAvailable: 5 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'שולחן' })).toBeTruthy());
  });

  it('confirms borrower deletion explicitly and lets an archived borrower deletion be cancelled', async () => {
    const activeBorrower: Borrower = {
      id: 41,
      username: 'active-user',
      name: 'Active User',
      contact: '050',
      type: 'individual',
      archived: false,
    };
    const archivedBorrower: Borrower = {
      ...activeBorrower,
      id: 42,
      username: 'archived-user',
      name: 'Archived User',
      archived: true,
    };
    const { user, requests } = setup(
      'admin',
      '/management',
      [hammer],
      [activeBorrower, archivedBorrower],
    );
    await user.click(await screen.findByRole('link', { name: 'ניהול' }));
    await user.click(await screen.findByRole('tab', { name: /שואלים/ }));

    const activeRow = screen.getByRole('row', { name: /Active User/ });
    const deleteTrigger = within(activeRow).getByRole('button', { name: 'מחיקה' });
    expect(deleteTrigger.classList.contains('small-button')).toBe(true);
    expect(deleteTrigger.getAttribute('data-tone')).toBe('destructive');
    expect(deleteTrigger.querySelector('svg')).not.toBeNull();
    await user.click(deleteTrigger);
    expect(
      await screen.findByRole('alertdialog', { name: 'למחוק לצמיתות את Active User?' }),
    ).toBeTruthy();
    expect(screen.getByText(/פרטי הקשר שלו/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'ביטול' }));
    expect(requests.some((request) => request.path.endsWith('/delete'))).toBe(false);

    await user.click(
      within(screen.getByRole('row', { name: /Active User/ })).getByRole('button', {
        name: 'מחיקה',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'מחק את השואל וההיסטוריה לצמיתות' }));
    await waitFor(() =>
      expect(requests.some((request) => request.path === '/api/borrowers/41/delete')).toBe(true),
    );
    const deletion = requests.find((request) => request.path === '/api/borrowers/41/delete')!;
    expect(deletion.body).toMatchObject({
      expectedStateRevision: 7,
      expectedOutstanding: 0,
      expectedLost: 0,
      expectedName: activeBorrower.name,
      expectedUsername: activeBorrower.username,
    });

    await user.click(
      within(screen.getByRole('row', { name: /Archived User/ })).getByRole('button', {
        name: 'מחיקה',
      }),
    );
    expect(
      await screen.findByRole('alertdialog', { name: 'למחוק לצמיתות את Archived User?' }),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'ביטול' }));
    expect(requests.some((request) => request.path === '/api/borrowers/42/delete')).toBe(false);
  });

  it('guards in-app navigation from a dirty item editor', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: 'פטיש' }));
    await user.type(screen.getByRole('textbox', { name: 'שם פריט' }), ' חדש');
    window.history.pushState({}, '', '/summary');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(window.location.pathname).toBe('/management');
    const discard = await screen.findByRole('alertdialog');
    expect(
      within(discard)
        .getByRole('button', { name: 'להמשיך לערוך' })
        .classList.contains('secondary-button'),
    ).toBe(true);
    expect(
      within(discard)
        .getByRole('button', { name: 'ביטול השינויים' })
        .classList.contains('danger-button'),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'להמשיך לערוך' }));
    expect((screen.getByRole('textbox', { name: 'שם פריט' }) as HTMLInputElement).value).toContain(
      'חדש',
    );
    window.history.pushState({}, '', '/summary');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await user.click(await screen.findByRole('button', { name: 'ביטול השינויים' }));
    await waitFor(() => expect(window.location.pathname).toBe('/summary'));
  });
});
