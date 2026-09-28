// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/App';
import { DialogStackProvider } from '../../src/web/Dialog';
import type { Item } from '../../src/web/InventoryDialogs';

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
) {
  let currentRole = role;
  let items: Item[] = initialItems;
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
    if (path === '/api/borrowers?all=1') return response([]);
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('inventory management in App', () => {
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
    expect(screen.getByRole('alertdialog', { name: 'מחיקת טיוטת ניפוק?' })).toBeTruthy();
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

  it('guards in-app navigation from a dirty item editor', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: 'פטיש' }));
    await user.type(screen.getByRole('textbox', { name: 'שם פריט' }), ' חדש');
    window.history.pushState({}, '', '/summary');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(window.location.pathname).toBe('/management');
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
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
