// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/App';
import { DialogStackProvider } from '../../src/web/Dialog';

const item = {
  id: 11,
  code: 100,
  name: 'פטיש',
  kind: 'non_consumable' as const,
  lotSize: 6,
  locationId: 31,
  aliases: ['מקבת'],
  available: 3,
  damaged: 0,
  archived: false,
};
const campEquipment = {
  ...item,
  id: 12,
  code: 101,
  name: 'שולחן קבוע',
  kind: 'camp_equipment' as const,
  lotSize: null,
  aliases: ['שולחן מחנה'],
};
const consumable = {
  ...item,
  id: 13,
  code: 102,
  name: 'כפפות',
  kind: 'consumable' as const,
  lotSize: 10,
  aliases: ['כפפת עבודה'],
};
const unavailableConsumable = {
  ...consumable,
  id: 14,
  code: 103,
  name: 'סרט סימון',
  available: 0,
};
const archivedConsumable = {
  ...consumable,
  id: 15,
  code: 104,
  name: 'שק ישן',
  archived: true,
};
const otherConsumable = {
  ...consumable,
  id: 16,
  code: 105,
  name: 'בקבוק מים',
  aliases: ['שתייה'],
};
const borrower = {
  id: 21,
  username: 'orba',
  name: 'אור',
  contact: '050',
  type: 'individual' as const,
  archived: false,
};
const location = { id: 31, code: 'A-1', name: 'מחסן ראשי', archived: false };
const loan = {
  checkoutId: 41,
  code: 100,
  itemName: 'פטיש',
  borrowerName: 'אור',
  outstanding: 2,
  lost: 1,
};

type RecordedRequest = { path: string; init: RequestInit };

function response(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installApiMock({
  failPath,
  failRefreshAfterPath,
  holdPath,
  removeLoanAfterReturn = false,
  inventoryItems = [item],
  catalogBorrowers = [borrower],
  catalogLocations = [location],
}: {
  failPath?: string;
  failRefreshAfterPath?: string;
  holdPath?: string;
  removeLoanAfterReturn?: boolean;
  inventoryItems?: Array<
    | typeof item
    | typeof campEquipment
    | typeof consumable
    | typeof unavailableConsumable
    | typeof archivedConsumable
    | typeof otherConsumable
  >;
  catalogBorrowers?: Array<typeof borrower>;
  catalogLocations?: Array<typeof location>;
} = {}) {
  const requests: RecordedRequest[] = [];
  const reads: RecordedRequest[] = [];
  let role: 'operator' | 'admin' = 'admin';
  let loans = [loan];
  let releaseHeld: (() => void) | undefined;
  let holdNextSession = false;
  let releaseSession: (() => void) | undefined;
  let failNextRefresh = false;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const path = String(input);
      const method = init.method ?? 'GET';
      if (method !== 'GET') {
        requests.push({ path, init });
        if (path === holdPath) await new Promise<void>((resolve) => (releaseHeld = resolve));
        if (path === failPath)
          return response({ error: 'rejected', message: 'השרת דחה את הפעולה' }, 400);
        if (path === '/api/return' && removeLoanAfterReturn) loans = [];
        if (path === failRefreshAfterPath) failNextRefresh = true;
        return response(undefined, 204);
      }
      reads.push({ path, init });
      if (failNextRefresh) {
        failNextRefresh = false;
        return response({ error: 'refresh_failed', message: 'הרענון נכשל' }, 500);
      }
      if (path === '/api/session') {
        if (holdNextSession) {
          holdNextSession = false;
          await new Promise<void>((resolve) => (releaseSession = resolve));
        }
        return response({ role, deadline: role === 'admin' ? Date.now() + 600_000 : null });
      }
      if (path === '/api/items' || path === '/api/items?all=1') return response(inventoryItems);
      if (path === '/api/borrowers' || path === '/api/borrowers?all=1')
        return response(catalogBorrowers);
      if (path === '/api/borrowers/search?q=') return response({ ledgerEpoch: 37 });
      if (path === '/api/locations?all=1') return response(catalogLocations);
      if (path === '/api/loans') return response(loans);
      if (path === '/api/ledger') return response([]);
      throw new Error(`Unexpected request: ${method} ${path}`);
    }),
  );

  return {
    requests,
    reads,
    releaseHeld: () => releaseHeld?.(),
    startSessionReconciliation: () => {
      holdNextSession = true;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    releaseSessionReconciliation: () => releaseSession?.(),
    restoreAdmin: () => {
      role = 'admin';
      window.dispatchEvent(new Event('mapatz-auth-stale'));
    },
    expireAdmin: () => {
      role = 'operator';
      window.dispatchEvent(new Event('mapatz-auth-stale'));
    },
  };
}

async function renderReadyApp() {
  window.history.replaceState({}, '', '/inventory');
  const user = userEvent.setup();
  render(
    <DialogStackProvider>
      <App />
    </DialogStackProvider>,
  );
  await screen.findByText('פטיש');
  return user;
}

function bodyOf(request: RecordedRequest): unknown {
  return JSON.parse(String(request.init.body));
}

async function openManagement(user: ReturnType<typeof userEvent.setup>, tabName: string) {
  await user.click(screen.getByRole('link', { name: 'ניהול' }));
  await user.click(screen.getByRole('tab', { name: new RegExp(tabName) }));
}

it('does not offer desktop password recovery in a browser admin dialog', async () => {
  const api = installApiMock({});
  const user = await renderReadyApp();
  api.expireAdmin();
  await waitFor(() => expect(screen.getByRole('button', { name: 'הפעל מצב מנהל' })).toBeTruthy());
  await user.click(screen.getByRole('button', { name: 'הפעל מצב מנהל' }));
  expect(screen.getByRole('dialog').textContent).not.toContain('שכחתי את סיסמת המנהל');
});

it('keeps consumable issue and the borrower desk while retiring legacy borrowing routes', async () => {
  const api = installApiMock({
    inventoryItems: [
      item,
      consumable,
      otherConsumable,
      unavailableConsumable,
      archivedConsumable,
      campEquipment,
    ],
  });
  const user = await renderReadyApp();
  expect(screen.getByText('ציוד מחנה')).toBeTruthy();
  const primaryNavigation = screen.getByRole('navigation', { name: 'ניווט ראשי' });
  expect(within(primaryNavigation).queryByRole('link', { name: /^השאלה$/ })).toBeNull();
  expect(within(primaryNavigation).queryByRole('link', { name: 'החזרות' })).toBeNull();
  expect(within(primaryNavigation).getByRole('link', { name: 'דלפק השאלות' })).toBeTruthy();
  expect(within(primaryNavigation).getAllByRole('link')[0]?.textContent).toContain('דלפק השאלות');

  const issueTab = screen.getByRole('link', { name: 'ציוד מתכלה' });
  await user.click(issueTab);
  expect(issueTab.getAttribute('aria-current')).toBe('page');
  const issue = screen.getByText('ניפוק מתכלה').closest('form')!;
  expect(screen.queryByText('השאלת ציוד')).toBeNull();
  const issueItem = within(issue).getByRole('combobox', { name: 'פריט' });
  expect(document.activeElement).not.toBe(issueItem);
  expect(issueItem.getAttribute('aria-expanded')).toBe('false');
  expect(within(issue).queryByRole('listbox')).toBeNull();

  await user.click(issueItem);
  const itemList = within(issue).getByRole('listbox');
  expect(itemList.classList.contains('combobox-list')).toBe(true);
  expect(within(itemList).getByRole('option', { name: /כפפות/ })).toBeTruthy();
  expect(within(itemList).getByRole('option', { name: /בקבוק מים/ })).toBeTruthy();
  expect(within(itemList).queryByRole('option', { name: /פטיש/ })).toBeNull();
  expect(within(itemList).queryByRole('option', { name: /שולחן קבוע/ })).toBeNull();
  expect(within(itemList).queryByRole('option', { name: /סרט סימון/ })).toBeNull();
  expect(within(itemList).queryByRole('option', { name: /שק ישן/ })).toBeNull();

  await user.type(issueItem, 'עבודה');
  const filteredList = within(issue).getByRole('listbox');
  expect(within(filteredList).getByRole('option', { name: /כפפות/ })).toBeTruthy();
  expect(within(filteredList).queryByRole('option', { name: /בקבוק מים/ })).toBeNull();
  await user.clear(issueItem);
  await user.type(issueItem, '102');
  expect(within(issue).queryByRole('option', { name: /בקבוק מים/ })).toBeNull();
  await user.click(within(issue).getByRole('option', { name: /כפפות/ }));
  expect(issueItem).toHaveProperty('value', 'כפפות');

  await user.type(within(issue).getByLabelText('כמות'), '2');
  await user.click(within(issue).getByRole('button', { name: 'בצע פעולה' }));
  await waitFor(() => expect(issue.querySelector('fieldset')?.disabled).toBe(false));
  const issueRequest = api.requests.find((request) => request.path === '/api/issue')!;
  expect(bodyOf(issueRequest)).toEqual({ itemId: 13, quantity: 2, note: '' });
  await waitFor(() => expect(issueItem).toHaveProperty('value', ''));

  await user.click(within(issue).getByRole('button', { name: 'בצע פעולה' }));
  expect(await screen.findByText('יש לבחור פריט מהרשימה')).toBeTruthy();
  expect(document.activeElement).toBe(issueItem);
  expect(issueItem.getAttribute('aria-invalid')).toBe('true');
  expect(api.requests.filter((request) => request.path === '/api/issue')).toHaveLength(1);

  await openManagement(user, 'פריטים ומיקומים');
  expect(screen.getByRole('option', { name: 'ציוד מחנה' })).toBeTruthy();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('route-backed navigation', () => {
  it.each([
    ['/', 'דלפק השאלות'],
    ['/frontdesk', 'דלפק השאלות'],
    ['/consumables', 'ציוד מתכלה'],
    ['/inventory', 'מצב מלאי'],
    ['/ledger', 'יומן אירועים'],
    ['/management', 'ניהול'],
  ])('opens %s directly on its primary destination', async (path, heading) => {
    installApiMock();
    window.history.replaceState({}, '', path);
    render(
      <DialogStackProvider>
        <App />
      </DialogStackProvider>,
    );

    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
  });

  it('keeps the frontdesk alias address while marking the home link active', async () => {
    installApiMock();
    window.history.replaceState({}, '', '/frontdesk');
    render(
      <DialogStackProvider>
        <App />
      </DialogStackProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'דלפק השאלות' })).toBeTruthy();
    const deskLink = screen.getByRole('link', { name: 'דלפק השאלות' });
    expect(deskLink.getAttribute('href')).toBe('/');
    expect(deskLink.getAttribute('aria-current')).toBe('page');
    expect(window.location.pathname).toBe('/frontdesk');
  });

  it('synchronizes browser history navigation to the frontdesk alias', async () => {
    installApiMock();
    window.history.replaceState({}, '', '/inventory');
    render(
      <DialogStackProvider>
        <App />
      </DialogStackProvider>,
    );
    await screen.findByRole('heading', { name: 'מצב מלאי' });

    window.history.pushState({}, '', '/frontdesk');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(await screen.findByRole('heading', { name: 'דלפק השאלות' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'דלפק השאלות' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(window.location.pathname).toBe('/frontdesk');
  });

  it('uses the borrower desk as home and keeps primary tabs synchronized with the URL', async () => {
    installApiMock();
    window.history.replaceState({}, '', '/');
    const user = userEvent.setup();
    render(
      <DialogStackProvider>
        <App />
      </DialogStackProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'דלפק השאלות' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'דלפק השאלות' }).getAttribute('aria-current')).toBe(
      'page',
    );

    await user.click(screen.getByRole('link', { name: 'מלאי' }));
    expect(window.location.pathname).toBe('/inventory');
    expect(await screen.findByRole('heading', { name: 'מצב מלאי' })).toBeTruthy();

    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(await screen.findByRole('heading', { name: 'דלפק השאלות' })).toBeTruthy();

    window.history.forward();
    await waitFor(() => expect(window.location.pathname).toBe('/inventory'));
    expect(await screen.findByRole('heading', { name: 'מצב מלאי' })).toBeTruthy();

    window.history.replaceState({}, '', '/ledger');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(await screen.findByRole('heading', { name: 'יומן אירועים' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'יומן' }).getAttribute('aria-current')).toBe('page');
  });
});

describe('App dialog workflows', () => {
  it('names a successful new-item toast after the completed action', async () => {
    const api = installApiMock();
    const user = await renderReadyApp();
    await openManagement(user, 'פריטים ומיקומים');

    const form = screen.getByText('פריט חדש').closest('form')!;
    await user.type(within(form).getByLabelText('שם'), 'אוהל חדש');
    await user.click(within(form).getByRole('button', { name: 'בצע פעולה' }));

    const successToast = await screen.findByText('הוספת פריט חדש');
    expect(successToast.closest('.toast')?.textContent).toContain('הפעולה הושלמה בהצלחה');
    expect(api.requests.some((request) => request.path === '/api/items')).toBe(true);
  });

  it('reports duplicate item creation through the error Toast without success feedback', async () => {
    const api = installApiMock({ failPath: '/api/items' });
    const user = await renderReadyApp();
    await openManagement(user, 'פריטים ומיקומים');

    const form = screen.getByText('פריט חדש').closest('form')!;
    await user.type(within(form).getByLabelText('שם'), 'פטיש');
    await user.click(within(form).getByRole('button', { name: 'בצע פעולה' }));

    const toast = await screen.findByRole('alert', { name: /הוספת פריט חדש/ });
    expect(toast.textContent).toContain('השרת דחה את הפעולה');
    expect(toast.className).toContain('toast-error');
    expect(toast.textContent).not.toContain('הפעולה הושלמה בהצלחה');
    expect(api.requests.filter((request) => request.path === '/api/items')).toHaveLength(1);
  });

  it('keeps item editing open when a duplicate-name conflict is Toasted', async () => {
    installApiMock({ failPath: '/api/items/11' });
    const user = await renderReadyApp();
    await openManagement(user, 'פריטים ומיקומים');

    const itemSection = screen.getByRole('heading', { name: 'קטלוג פריטים' }).closest('section')!;
    await user.click(within(itemSection).getByRole('button', { name: 'עריכה' }));
    const dialog = screen.getByRole('dialog', { name: 'עריכת פריט' });
    await user.clear(within(dialog).getByLabelText('שם פריט'));
    await user.type(within(dialog).getByLabelText('שם פריט'), 'שם כפול');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));

    const toast = await screen.findByRole('alert', { name: /עריכת פריט/ });
    expect(toast.textContent).toContain('השרת דחה את הפעולה');
    expect(screen.getByRole('dialog', { name: 'עריכת פריט' })).toBe(dialog);
    expect((within(dialog).getByLabelText('שם פריט') as HTMLInputElement).value).toBe('שם כפול');
  });

  it('keeps only admin-gated lost controls with outstanding equipment in Management stock', async () => {
    const api = installApiMock();
    const user = await renderReadyApp();
    await openManagement(user, 'מלאי ופגומים');

    expect(screen.getByRole('heading', { name: 'ציוד בחוץ ואבוד' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'החזרה' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'סמן אבוד' }));
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('סימון ציוד כאבוד')).toBeTruthy();

    expect(screen.queryByRole('button', { name: 'בטל אובדן' })).toBeNull();

    const lostRequests = api.requests.filter((request) => request.path === '/api/lost');
    expect(lostRequests.map(bodyOf)).toEqual([
      { checkoutId: 41, quantity: 2, lost: true, note: '' },
    ]);

    api.expireAdmin();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'סמן אבוד' }).hasAttribute('disabled')).toBe(true),
    );
  });

  it.each([
    {
      entity: 'item',
      archived: false,
      tab: 'פריטים ומיקומים',
      section: 'קטלוג פריטים',
      path: '/api/items/11/archive',
      title: 'העברת פריט לארכיון',
    },
    {
      entity: 'item',
      archived: true,
      tab: 'פריטים ומיקומים',
      section: 'קטלוג פריטים',
      path: '/api/items/11/archive',
      title: 'הוצאת פריט מהארכיון',
    },
    {
      entity: 'borrower',
      archived: false,
      tab: 'שואלים',
      section: 'קטלוג שואלים',
      path: '/api/borrowers/21/archive',
      title: 'העברת שואל לארכיון',
    },
    {
      entity: 'borrower',
      archived: true,
      tab: 'שואלים',
      section: 'קטלוג שואלים',
      path: '/api/borrowers/21/archive',
      title: 'הוצאת שואל מהארכיון',
    },
    {
      entity: 'location',
      archived: false,
      tab: 'פריטים ומיקומים',
      section: 'מיקומים',
      path: '/api/locations/31',
      title: 'העברת מיקום לארכיון',
    },
    {
      entity: 'location',
      archived: true,
      tab: 'פריטים ומיקומים',
      section: 'מיקומים',
      path: '/api/locations/31',
      title: 'הוצאת מיקום מהארכיון',
    },
  ] as const)('uses "$title" for the matching archive direction', async (testCase) => {
    const api = installApiMock({
      inventoryItems:
        testCase.entity === 'item' ? [{ ...item, archived: testCase.archived }] : [item],
      catalogBorrowers:
        testCase.entity === 'borrower'
          ? [{ ...borrower, archived: testCase.archived }]
          : [borrower],
      catalogLocations:
        testCase.entity === 'location'
          ? [{ ...location, archived: testCase.archived }]
          : [location],
    });
    const user = await renderReadyApp();
    await openManagement(user, testCase.tab);

    const section = screen.getByRole('heading', { name: testCase.section }).closest('section')!;
    await user.click(
      within(section).getByRole('button', { name: testCase.archived ? 'שחזור' : 'ארכוב' }),
    );

    expect(await screen.findByText(testCase.title)).toBeTruthy();
    expect(api.requests.some((request) => request.path === testCase.path)).toBe(true);
  });

  it.each([
    ['repair', 'תיקון פריט פגום'],
    ['write_off', 'גריעת פריט פגום'],
  ] as const)(
    'uses the selected damage resolution in the toast title',
    async (resolution, title) => {
      const api = installApiMock({ inventoryItems: [{ ...item, damaged: 2 }] });
      const user = await renderReadyApp();
      await openManagement(user, 'מלאי ופגומים');

      const form = screen.getByText('טיפול בפגום').closest('form')!;
      await user.selectOptions(within(form).getByLabelText('פריט'), String(item.id));
      await user.type(within(form).getByLabelText('כמות'), '1');
      await user.selectOptions(within(form).getByLabelText('פתרון'), resolution);
      await user.click(within(form).getByRole('button', { name: 'בצע פעולה' }));

      expect(await screen.findByText(title)).toBeTruthy();
      expect(bodyOf(api.requests.find((request) => request.path === '/api/damage')!)).toMatchObject(
        { resolution },
      );
    },
  );

  it('offers operator restoration while keeping unrelated stock actions protected', async () => {
    const api = installApiMock({ inventoryItems: [{ ...item, damaged: 2 }] });
    const user = await renderReadyApp();
    api.expireAdmin();
    await openManagement(user, 'מלאי ופגומים');
    await screen.findByText('החזרת ציוד פגום לשימוש');
    const repair = screen.getByText('טיפול בפגום').closest('form')!;
    const addStock = screen.getByText('הוספת מלאי').closest('form')!;
    expect((repair.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
    expect((addStock.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    expect(within(repair).queryByLabelText('פתרון')).toBeNull();
    expect(screen.queryByText('המסך גלוי לעיון. יש לעבור למצב מנהל כדי לבצע שינויים.')).toBeNull();
    await user.selectOptions(within(repair).getByLabelText('פריט'), String(item.id));
    await user.type(within(repair).getByLabelText('כמות'), '1');
    await user.click(within(repair).getByRole('button', { name: 'בצע פעולה' }));
    expect(await screen.findByText('תיקון פריט פגום')).toBeTruthy();
    expect(bodyOf(api.requests.find((request) => request.path === '/api/damage')!)).toMatchObject({
      resolution: 'repair',
      quantity: 1,
    });
  });

  it('preserves selected write-off through role loss and requires fresh restoration intent', async () => {
    const api = installApiMock({ inventoryItems: [{ ...item, damaged: 2 }] });
    const user = await renderReadyApp();
    await openManagement(user, 'מלאי ופגומים');
    const form = screen.getByText('טיפול בפגום').closest('form')!;
    await user.selectOptions(within(form).getByLabelText('פתרון'), 'write_off');
    api.expireAdmin();
    await waitFor(() =>
      expect((form.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true),
    );
    expect(within(form).queryByLabelText('פתרון')).toBeNull();
    fireEvent.submit(form);
    expect(api.requests.filter((request) => request.path === '/api/damage')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'בחירת החזרה לשימוש' }));
    expect((form.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
    await user.selectOptions(within(form).getByLabelText('פריט'), String(item.id));
    await user.type(within(form).getByLabelText('כמות'), '1');
    await user.click(within(form).getByRole('button', { name: 'בצע פעולה' }));
    expect(bodyOf(api.requests.find((request) => request.path === '/api/damage')!)).toMatchObject({
      resolution: 'repair',
    });
  });

  it('locks operator restoration during session reconciliation', async () => {
    const api = installApiMock({ inventoryItems: [{ ...item, damaged: 2 }] });
    const user = await renderReadyApp();
    api.expireAdmin();
    await openManagement(user, 'מלאי ופגומים');
    await screen.findByText('החזרת ציוד פגום לשימוש');
    const form = screen.getByText('טיפול בפגום').closest('form')!;
    api.startSessionReconciliation();
    await waitFor(() =>
      expect((form.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true),
    );
    fireEvent.submit(form);
    expect(api.requests.filter((request) => request.path === '/api/damage')).toHaveLength(0);
    api.releaseSessionReconciliation();
    await waitFor(() =>
      expect((form.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false),
    );
  });

  it('does not expose an inventory correction action', async () => {
    installApiMock();
    const user = await renderReadyApp();
    await openManagement(user, 'מלאי ופגומים');

    expect(screen.queryByText('תיקון כמות')).toBeNull();
    expect(screen.getByText('הוספת מלאי')).toBeTruthy();
    expect(screen.getByText('טיפול בפגום')).toBeTruthy();
  });

  it('submits borrower creation with a fresh epoch, contract version, and idempotency key', async () => {
    const idempotencyKey = '00000000-0000-4000-8000-000000000201';
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(idempotencyKey);
    const api = installApiMock();
    const user = await renderReadyApp();
    await openManagement(user, 'שואלים');
    const form = screen.getByText('שואל חדש').closest('form')!;
    await user.type(within(form).getByLabelText('שם'), 'שואל חדש');
    await user.type(within(form).getByLabelText('שם משתמש'), 'new-user');
    await user.type(within(form).getByLabelText('פרטי קשר'), '050-123');
    await user.selectOptions(within(form).getByLabelText('סוג'), 'camp_organization');
    await user.click(within(form).getByRole('button', { name: 'בצע פעולה' }));

    await waitFor(() =>
      expect(api.requests.some((entry) => entry.path === '/api/borrowers')).toBe(true),
    );
    const creation = api.requests.find((entry) => entry.path === '/api/borrowers')!;
    expect(api.reads.some((entry) => entry.path === '/api/borrowers/search?q=')).toBe(true);
    expect(creation.init.method).toBe('POST');
    expect(new Headers(creation.init.headers).get('Idempotency-Key')).toBe(idempotencyKey);
    expect(bodyOf(creation)).toEqual({
      contractVersion: 1,
      ledgerEpoch: 37,
      username: 'new-user',
      name: 'שואל חדש',
      contact: '050-123',
      type: 'camp_organization',
    });
  });

  it('submits exact item, borrower, and location update payloads from prefilled forms', async () => {
    const api = installApiMock();
    const user = await renderReadyApp();
    await openManagement(user, 'פריטים ומיקומים');

    const itemSection = screen.getByRole('heading', { name: 'קטלוג פריטים' }).closest('section')!;
    await user.click(within(itemSection).getByRole('button', { name: 'עריכה' }));
    let dialog = screen.getByRole('dialog', { name: 'עריכת פריט' });
    expect((within(dialog).getByLabelText('שם פריט') as HTMLInputElement).value).toBe('פטיש');
    await user.clear(within(dialog).getByLabelText('שם פריט'));
    await user.type(within(dialog).getByLabelText('שם פריט'), '  פטישון  ');
    await user.clear(within(dialog).getByLabelText('כינויים, מופרדים בפסיק'));
    await user.type(within(dialog).getByLabelText('כינויים, מופרדים בפסיק'), ' א, ב ');
    await user.clear(within(dialog).getByLabelText('גודל מארז (רשות)'));
    await user.selectOptions(within(dialog).getByLabelText('מיקום'), '');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('tab', { name: /שואלים/ }));
    const borrowerSection = screen
      .getByRole('heading', { name: 'קטלוג שואלים' })
      .closest('section')!;
    await user.click(within(borrowerSection).getByRole('button', { name: 'עריכה' }));
    dialog = screen.getByRole('dialog', { name: 'עריכת שואל' });
    await user.selectOptions(within(dialog).getByLabelText('סוג'), 'camp_organization');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('tab', { name: /פריטים ומיקומים/ }));
    const locationSection = screen.getByRole('heading', { name: 'מיקומים' }).closest('section')!;
    await user.click(within(locationSection).getByRole('button', { name: 'עריכה' }));
    dialog = screen.getByRole('dialog', { name: 'עריכת מיקום' });
    await user.clear(within(dialog).getByLabelText('שם'));
    await user.type(within(dialog).getByLabelText('שם'), '  מחסן ב  ');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(bodyOf(api.requests.find((request) => request.path === '/api/items/11')!)).toEqual({
      name: 'פטישון',
      aliases: ['א', 'ב'],
      lotSize: null,
      locationId: null,
    });
    expect(bodyOf(api.requests.find((request) => request.path === '/api/borrowers/21')!)).toEqual({
      name: 'אור',
      username: 'orba',
      contact: '050',
      type: 'camp_organization',
    });
    expect(bodyOf(api.requests.find((request) => request.path === '/api/locations/31')!)).toEqual({
      name: 'מחסן ב',
      code: 'A-1',
      archived: false,
    });
  });

  it('cancels safely, clears file inputs, and routes reset and recovery imports exactly', async () => {
    const api = installApiMock();
    const user = await renderReadyApp();
    await openManagement(user, 'ייבוא וייצוא');
    const resetInput = screen.getByLabelText('בחירת קובץ לייבוא איפוס') as HTMLInputElement;
    const recoveryInput = screen.getByLabelText('בחירת קובץ לשחזור מלא') as HTMLInputElement;
    const resetFile = new File(['reset'], 'reset.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const recoveryFile = new File(['recovery'], 'recovery.xlsx', { type: resetFile.type });

    await user.upload(resetInput, resetFile);
    const cancel = screen.getByRole('button', { name: 'ביטול' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await user.click(cancel);
    expect(resetInput.value).toBe('');
    expect(document.activeElement).toBe(resetInput);
    expect(api.requests.some((request) => request.path === '/api/workbook/reset')).toBe(false);

    await user.upload(resetInput, resetFile);
    await user.click(screen.getByRole('button', { name: 'מחק וייבא' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(resetInput.value).toBe('');

    await user.upload(recoveryInput, recoveryFile);
    await user.click(screen.getByRole('button', { name: 'החלף ושחזר' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(recoveryInput.value).toBe('');

    const resetRequest = api.requests.find((request) => request.path === '/api/workbook/reset')!;
    const recoveryRequest = api.requests.find(
      (request) => request.path === '/api/workbook/recovery',
    )!;
    expect(resetRequest.init.body).toBe(resetFile);
    expect(recoveryRequest.init.body).toBe(recoveryFile);
    expect(new Headers(resetRequest.init.headers).get('x-mapatz-confirmed')).toBe('true');
    expect(new Headers(recoveryRequest.init.headers).get('x-mapatz-confirmed')).toBe('true');
  });

  it('allows one request only and locks dismissal while a mutation is pending', async () => {
    const api = installApiMock({ holdPath: '/api/lost' });
    const user = await renderReadyApp();
    await openManagement(user, 'מלאי ופגומים');
    await user.click(screen.getByRole('button', { name: 'סמן אבוד' }));
    const save = screen.getByRole('button', { name: 'שמירה' });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.requests.filter((request) => request.path === '/api/lost')).toHaveLength(1),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(screen.getByRole('dialog')).toBeTruthy();

    api.releaseHeld();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not reopen borrower import after admin expiry and reauthorization', async () => {
    const controls = installApiMock();
    const user = await renderReadyApp();
    await openManagement(user, 'ייבוא וייצוא');
    await user.click(screen.getByRole('button', { name: 'ייבוא שואלים מקובץ' }));
    expect(screen.getByRole('dialog', { name: 'ייבוא שואלים מקובץ' })).toBeTruthy();
    controls.expireAdmin();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'ייבוא שואלים מקובץ' })).toBeNull(),
    );
    controls.restoreAdmin();
    await screen.findByRole('button', { name: 'ייבוא שואלים מקובץ' });
    expect(screen.queryByRole('dialog', { name: 'ייבוא שואלים מקובץ' })).toBeNull();
  });

  it('places borrower import in Import and Export and keeps it visible when admin mode is off', async () => {
    const controls = installApiMock();
    const user = await renderReadyApp();
    await openManagement(user, 'שואלים');
    expect(screen.queryByRole('button', { name: 'ייבוא שואלים מקובץ' })).toBeNull();

    await user.click(screen.getByRole('tab', { name: /ייבוא וייצוא/ }));
    const trigger = screen.getByRole('button', {
      name: 'ייבוא שואלים מקובץ',
    }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);

    controls.expireAdmin();
    await waitFor(() => expect(trigger.disabled).toBe(true));
    expect(trigger.isConnected).toBe(true);
  });

  it('closes an admin-only dialog as soon as authorization is reconciled away', async () => {
    const api = installApiMock();
    const user = await renderReadyApp();
    await openManagement(user, 'פריטים ומיקומים');
    const itemSection = screen.getByRole('heading', { name: 'קטלוג פריטים' }).closest('section')!;
    await user.click(within(itemSection).getByRole('button', { name: 'עריכה' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    api.expireAdmin();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('locks but preserves an admin dialog during reconciliation until the refreshed role is known', async () => {
    const api = installApiMock();
    const user = await renderReadyApp();
    await openManagement(user, 'פריטים ומיקומים');
    const itemSection = screen.getByRole('heading', { name: 'קטלוג פריטים' }).closest('section')!;
    await user.click(within(itemSection).getByRole('button', { name: 'עריכה' }));
    const dialog = screen.getByRole('dialog');

    api.startSessionReconciliation();
    await waitFor(() => expect(dialog.getAttribute('aria-busy')).toBe('true'));
    const save = within(dialog).getByRole('button', { name: 'שמירה' });
    expect((dialog.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    fireEvent.click(save);
    expect(api.requests.filter((request) => request.path === '/api/items/11')).toHaveLength(0);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBe(dialog);

    api.releaseSessionReconciliation();
    await waitFor(() => expect(dialog.hasAttribute('aria-busy')).toBe(false));
    expect((dialog.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
  });

  it('uses the management tab when authorization loss disables an import trigger', async () => {
    const api = installApiMock();
    const user = await renderReadyApp();
    await openManagement(user, 'ייבוא וייצוא');
    const managementTab = screen.getByRole('link', { name: 'ניהול' });
    const input = screen.getByLabelText('בחירת קובץ לייבוא איפוס');
    await user.upload(
      input,
      new File(['reset'], 'reset.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );

    api.expireAdmin();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(managementTab));
  });

  it('blocks representative invalid lost, item, borrower, and location edits inline', async () => {
    const api = installApiMock();
    const user = await renderReadyApp();
    await openManagement(user, 'מלאי ופגומים');

    const lostTrigger = screen.getByRole('button', { name: 'סמן אבוד' });
    await user.click(lostTrigger);
    let dialog = screen.getByRole('dialog');
    await user.clear(within(dialog).getByLabelText('כמות'));
    await user.type(within(dialog).getByLabelText('כמות'), '0');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('מספר שלם');
    expect(api.requests.filter((request) => request.path === '/api/lost')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'ביטול' }));
    expect(document.activeElement).toBe(lostTrigger);

    await openManagement(user, 'פריטים ומיקומים');
    const itemSection = screen.getByRole('heading', { name: 'קטלוג פריטים' }).closest('section')!;
    const itemTrigger = within(itemSection).getByRole('button', { name: 'עריכה' });
    await user.click(itemTrigger);
    dialog = screen.getByRole('dialog');
    await user.clear(within(dialog).getByLabelText('שם פריט'));
    await user.type(within(dialog).getByLabelText('שם פריט'), '   ');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('שם הפריט');
    expect(api.requests.filter((request) => request.path === '/api/items/11')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'ביטול' }));
    expect(document.activeElement).toBe(itemTrigger);

    await user.click(screen.getByRole('tab', { name: /שואלים/ }));
    const borrowerSection = screen
      .getByRole('heading', { name: 'קטלוג שואלים' })
      .closest('section')!;
    const borrowerTrigger = within(borrowerSection).getByRole('button', { name: 'עריכה' });
    await user.click(borrowerTrigger);
    dialog = screen.getByRole('dialog');
    await user.clear(within(dialog).getByLabelText('שם משתמש'));
    await user.type(within(dialog).getByLabelText('שם משתמש'), ' ');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('שם המשתמש');
    expect(api.requests.filter((request) => request.path === '/api/borrowers/21')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'ביטול' }));
    expect(document.activeElement).toBe(borrowerTrigger);

    await user.click(screen.getByRole('tab', { name: /פריטים ומיקומים/ }));
    const locationSection = screen.getByRole('heading', { name: 'מיקומים' }).closest('section')!;
    const locationTrigger = within(locationSection).getByRole('button', { name: 'עריכה' });
    await user.click(locationTrigger);
    dialog = screen.getByRole('dialog');
    await user.clear(within(dialog).getByLabelText('קוד'));
    await user.type(within(dialog).getByLabelText('קוד'), ' ');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('השם והקוד');
    expect(api.requests.filter((request) => request.path === '/api/locations/31')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'ביטול' }));
    expect(document.activeElement).toBe(locationTrigger);
  });
});
