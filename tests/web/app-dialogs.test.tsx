// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  stockSnapshot: 6,
  archived: false,
};
const location = { id: 31, code: 'A-1', name: 'מחסן ראשי', archived: false };
const response = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
function setup(role: 'admin' | 'operator' = 'admin') {
  let currentRole = role;
  let items: Item[] = [hammer];
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
        stockSnapshot: 7,
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
  window.history.replaceState({}, '', '/management');
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
});

describe('inventory management in App', () => {
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
    await user.click(screen.getByRole('button', { name: 'ביטול' }));
    expect((screen.getByRole('textbox', { name: 'סינון הטבלה' }) as HTMLInputElement).value).toBe(
      'מקבת',
    );
    await user.click(screen.getByRole('button', { name: 'מיקומים' }));
    expect(within(screen.getByRole('dialog')).getByText('מחסן ראשי')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'מיקום חדש' })).toBeNull();
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
