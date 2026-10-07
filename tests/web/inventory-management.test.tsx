// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogStackProvider } from '../../src/web/Dialog';
import { InventoryManagement } from '../../src/web/InventoryManagement';
import type { Item, Location } from '../../src/web/InventoryDialogs';
import { installWindowStorage } from '../helpers/window-storage.js';
const item: Item = {
  id: 1,
  name: 'Hammer',
  kind: 'non_consumable',
  lotSize: null,
  balances: [{ locationId: 1, available: 20, damaged: 4 }],
  aliases: ['Mallet'],
  available: 20,
  borrowed: 0,
  lost: 0,
  damaged: 4,
  stockRevision: 7,
  archived: false,
};
const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const showToast = vi.fn();
const onRefresh = vi.fn(async () => undefined);
const registerLeaveGuard = vi.fn();
const view = (
  admin = true,
  items: Item[] = [item],
  locations: Location[] = [
    { id: 1, code: 'monster', name: 'מפלצת', archived: false, isDefault: false },
  ],
  storageUnavailable = false,
) => {
  installWindowStorage(true);
  if (storageUnavailable)
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage access denied');
      },
    });
  return render(
    <DialogStackProvider>
      <InventoryManagement
        items={items}
        locations={locations}
        ledgerEpoch={1}
        admin={admin}
        onRefresh={onRefresh}
        showToast={showToast}
        registerLeaveGuard={registerLeaveGuard}
      />
    </DialogStackProvider>,
  );
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  showToast.mockClear();
  onRefresh.mockClear();
  registerLeaveGuard.mockClear();
});
describe('inventory management UI', () => {
  it('identifies and searches items by name and alias, excluding internal IDs', async () => {
    const user = userEvent.setup();
    view(true, [{ ...item, id: 87941 }]);
    expect(screen.queryByRole('columnheader', { name: 'קוד' })).toBeNull();
    expect(screen.queryByText('87941')).toBeNull();
    const search = screen.getByPlaceholderText('חיפוש שם או כינוי…');
    await user.type(search, '87941');
    expect(screen.queryByRole('row', { name: /Hammer/ })).toBeNull();
    await user.clear(search);
    await user.type(search, 'Mallet');
    expect(screen.getByRole('row', { name: /Hammer/ })).toBeTruthy();
  });
  it('does not dispatch a management command when the browser storage getter throws', async () => {
    const eligible = { ...item, available: 0, damaged: 0 };
    const fetch = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    view(true, [eligible], [], true);
    await user.click(
      within(screen.getByRole('row', { name: /Hammer/ })).getByRole('button', {
        name: 'מחיקה',
      }),
    );
    await screen.findByRole('alertdialog', { name: 'למחוק את Hammer לצמיתות?' });
    await user.click(screen.getByRole('button', { name: 'מחק את הפריט וההיסטוריה לצמיתות' }));
    expect(fetch).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      'לא ניתן לשמור את הפעולה',
      'אחסון הדפדפן אינו זמין כרגע',
      'error',
    );
  });
  it('uses the previous blue, mauve and green badges for item types', () => {
    view(true, [
      { ...item, id: 1, kind: 'consumable', name: 'Consumable' },
      { ...item, id: 2, kind: 'non_consumable', name: 'Loanable' },
      { ...item, id: 3, kind: 'camp_equipment', name: 'Camp' },
    ]);
    expect(
      within(screen.getByRole('row', { name: /Consumable/ })).getByText('מתכלה').className,
    ).toBe('status-badge blue');
    expect(within(screen.getByRole('row', { name: /Loanable/ })).getByText('מושאל').className).toBe(
      'status-badge mauve',
    );
    expect(within(screen.getByRole('row', { name: /Camp/ })).getByText('ציוד מחנה').className).toBe(
      'status-badge green',
    );
  });
  it('keeps search and filters in the toolbar without changing table behavior', async () => {
    const user = userEvent.setup();
    const store: Location = {
      id: 31,
      code: 'A-1',
      name: 'Long storage location name',
      archived: false,
      isDefault: false,
    };
    view(
      true,
      [
        item,
        {
          ...item,
          id: 2,
          name: 'Rope',
          kind: 'consumable',
          balances: [{ locationId: 31, available: item.available, damaged: item.damaged }],
        },
        {
          ...item,
          id: 3,
          name: 'Archived',
          balances: [{ locationId: 31, available: item.available, damaged: item.damaged }],
          archived: true,
        },
      ],
      [store],
    );
    expect(screen.getByRole('textbox', { name: 'סינון הטבלה' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'כולל ארכיון' })).toBeTruthy();
    await user.selectOptions(screen.getByRole('combobox', { name: 'סוג' }), 'consumable');
    expect(screen.queryByRole('button', { name: 'Hammer' })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'סוג' }), 'non_consumable');
    expect(screen.getByRole('button', { name: 'Hammer' })).toBeTruthy();
    await user.selectOptions(screen.getByRole('combobox', { name: 'סוג' }), '');
    await user.selectOptions(screen.getByRole('combobox', { name: 'מיקום' }), '31');
    expect(screen.queryByRole('button', { name: 'Hammer' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Rope' })).toBeTruthy();
    expect(screen.getByText('1 מתוך 1')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'מיקום' }).getAttribute('title')).toBe(store.name);
    await user.click(screen.getByRole('checkbox', { name: 'כולל ארכיון' }));
    expect(screen.getByRole('button', { name: 'Archived (בארכיון)' })).toBeTruthy();
    expect(screen.getByText('2 מתוך 2')).toBeTruthy();
  });
  it('opens on stock and switches inline to locations while preserving stock filters', async () => {
    const user = userEvent.setup();
    view(
      true,
      [item],
      [{ id: 31, code: 'A-1', name: 'Main store', archived: false, isDefault: false }],
    );
    expect(screen.getByRole('button', { name: 'מלאי' }).getAttribute('aria-pressed')).toBe('true');
    await user.type(screen.getByRole('textbox', { name: 'סינון הטבלה' }), 'Mallet');
    await user.click(screen.getByRole('button', { name: 'מיקומים' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      within(document.getElementById('locations-view-panel')!).getByText('Main store'),
    ).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'חיפוש מיקומים' }), 'A-1');
    await user.click(screen.getByRole('button', { name: 'מלאי' }));
    expect((screen.getByRole('textbox', { name: 'סינון הטבלה' }) as HTMLInputElement).value).toBe(
      'Mallet',
    );
    await user.click(screen.getByRole('button', { name: 'מיקומים' }));
    expect((screen.getByRole('textbox', { name: 'חיפוש מיקומים' }) as HTMLInputElement).value).toBe(
      'A-1',
    );
  });
  it('retries uncertain location creation with the same command and returns to the locations table', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) throw new Error('connection lost');
      return respond(
        { id: 2, code: 'A-2', name: 'Second storage', archived: false, isDefault: false },
        201,
      );
    });
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('button', { name: 'מיקומים' }));
    await user.click(screen.getByRole('button', { name: 'מיקום חדש' }));
    await user.type(screen.getByRole('textbox', { name: 'שם' }), 'Second storage');
    await user.type(screen.getByRole('textbox', { name: 'קוד' }), 'A-2');
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await user.click(await screen.findByRole('button', { name: 'בדוק שוב את אותה פעולה' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual(bodies[0]);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(screen.getByRole('textbox', { name: 'חיפוש מיקומים' })).toBeTruthy();
  });
  it('recovers a committed location save by refreshing the locations table only', async () => {
    const save = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        respond(
          { id: 2, code: 'A-2', name: 'Second storage', archived: false, isDefault: false },
          201,
        ),
      );
    onRefresh.mockRejectedValueOnce(new Error('refresh failed'));
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('button', { name: 'מיקומים' }));
    await user.click(screen.getByRole('button', { name: 'מיקום חדש' }));
    await user.type(screen.getByRole('textbox', { name: 'שם' }), 'Second storage');
    await user.type(screen.getByRole('textbox', { name: 'קוד' }), 'A-2');
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await user.click(await screen.findByRole('button', { name: 'רענון נתונים' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'חיפוש מיקומים' })).toBeTruthy();
  });
  it('keeps inline archive recovery available and retries the same location command', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) throw new Error('connection lost');
      return respond({ id: 31, code: 'A-1', name: 'Main store', archived: true, isDefault: false });
    });
    const user = userEvent.setup();
    view(
      true,
      [item],
      [{ id: 31, code: 'A-1', name: 'Main store', archived: false, isDefault: false }],
    );
    await user.click(screen.getByRole('button', { name: 'מיקומים' }));
    await user.click(screen.getByRole('button', { name: 'ארכוב' }));
    await user.click(screen.getByRole('button', { name: 'ארכוב והעברה' }));
    expect(screen.getByRole('button', { name: 'מלאי' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'מלאי' }));
    expect(screen.getByText(/ארכוב מיקום: Main store: תוצאת הפעולה אינה ידועה/)).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'בדוק שוב את אותה פעולה' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual(bodies[0]);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'מלאי' }).hasAttribute('disabled')).toBe(false);
  });
  it('offers refresh alone after an uncertain archive succeeds but refreshing fails', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockRejectedValueOnce(new Error('connection lost'));
    fetch.mockResolvedValueOnce(
      respond({ id: 31, code: 'A-1', name: 'Main store', archived: true, isDefault: false }),
    );
    onRefresh.mockRejectedValueOnce(new Error('refresh failed'));
    const user = userEvent.setup();
    view(
      true,
      [item],
      [{ id: 31, code: 'A-1', name: 'Main store', archived: false, isDefault: false }],
    );
    await user.click(screen.getByRole('button', { name: 'מיקומים' }));
    await user.click(screen.getByRole('button', { name: 'ארכוב' }));
    await user.click(screen.getByRole('button', { name: 'ארכוב והעברה' }));
    expect(await screen.findByText(/ארכוב מיקום: Main store/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'בדוק שוב את אותה פעולה' }));
    expect(await screen.findByRole('button', { name: 'רענון נתונים' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'בדוק שוב את אותה פעולה' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'רענון נתונים' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('shows the four balances and requires a discard decision for edited item details', async () => {
    const user = userEvent.setup();
    view();
    expect(screen.getByRole('columnheader', { name: 'מושאל' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'אבוד' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    await user.selectOptions(within(screen.getByRole('dialog')).getByLabelText('מיקום'), '1');
    expect(screen.getByText(/מושאל: 0/)).toBeTruthy();
    await user.clear(screen.getByLabelText('שם פריט'));
    await user.type(screen.getByLabelText('שם פריט'), 'Hammer updated');
    await user.click(screen.getByRole('button', { name: 'ביטול' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'להמשיך לערוך' }));
    expect((screen.getByLabelText('שם פריט') as HTMLInputElement).value).toBe('Hammer updated');
    fireEvent.keyDown(document, { key: 'Escape' });
    await user.click(screen.getByRole('button', { name: 'ביטול השינויים' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('submits an absolute target and snapshot with the edited metadata', async () => {
    const calls: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ path: String(url), body: JSON.parse(String(init?.body)) });
      return respond(item);
    });
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    await user.selectOptions(within(screen.getByRole('dialog')).getByLabelText('מיקום'), '1');
    await user.clear(screen.getByLabelText('זמין'));
    await user.type(screen.getByLabelText('זמין'), '17');
    expect(screen.getByText('התאמה: -3')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.path).toBe('/api/inventory/items/1');
    expect(calls[0]?.body).toMatchObject({ targetAvailable: 17, stockRevision: 7, name: 'Hammer' });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
  });
  it('warns and confirms before archiving an item with available stock', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(respond({ itemId: 1, archived: true }));
    const user = userEvent.setup();
    view(true, [{ ...item, damaged: 0, balances: [{ locationId: 1, available: 20, damaged: 0 }] }]);
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    await user.click(screen.getByText('פעולות נוספות'));
    await user.click(screen.getByRole('button', { name: 'העברה לארכיון' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('יאפס את כל המלאי הזמין');
    expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'ביטול' }));
    expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'העברה לארכיון' }));
    await user.click(screen.getByRole('button', { name: 'ארכוב ואיפוס מלאי זמין' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ archived: true });
  });
  it('requires explicit confirmation to delete active items and allows cancellation for archived items', async () => {
    const active: Item = {
      ...item,
      name: 'Active deletion candidate',
      available: 3,
      damaged: 0,
    };
    const archived: Item = {
      ...item,
      id: 2,
      name: 'Archived deletion candidate',
      available: 0,
      archived: true,
      damaged: 0,
    };
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(respond({ outcome: 'committed', action: 'delete_item', itemId: 1 }));
    const user = userEvent.setup();
    view(true, [active, archived]);
    const activeRow = screen.getByRole('row', { name: /Active deletion candidate/ });
    await user.click(
      within(screen.getByRole('row', { name: /Active deletion candidate/ })).getByRole('button', {
        name: 'מחיקה',
      }),
    );
    expect(
      await screen.findByRole('alertdialog', {
        name: 'למחוק את Active deletion candidate לצמיתות?',
      }),
    ).toBeTruthy();
    expect(screen.getByText(/היסטוריית שואלים ובדוחות/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'ביטול' }));
    expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox', { name: 'כולל ארכיון' }));
    const archivedRow = screen.getByRole('row', { name: /Archived deletion candidate/ });
    await user.click(within(archivedRow).getByRole('button', { name: 'מחיקה' }));
    expect(
      await screen.findByRole('alertdialog', {
        name: 'למחוק את Archived deletion candidate לצמיתות?',
      }),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'ביטול' }));
    expect(fetch).not.toHaveBeenCalled();
    await user.click(within(activeRow).getByRole('button', { name: 'מחיקה' }));
    await user.click(screen.getByRole('button', { name: 'מחק את הפריט וההיסטוריה לצמיתות' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/inventory/items/1/delete');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      ledgerEpoch: 1,
      expectedStockRevision: active.stockRevision,
      expectedName: active.name,
    });
  });
  it('names the destination and includes archived contents before retiring a location', async () => {
    const source: Location = {
      id: 31,
      code: 'A-1',
      name: 'Main store',
      archived: false,
      isDefault: false,
    };
    const destination: Location = {
      id: 32,
      code: 'A-2',
      name: 'Reserve store',
      archived: false,
      isDefault: false,
    };
    const active: Item = {
      ...item,
      id: 1,
      name: 'Active stock',
      balances: [{ locationId: source.id, available: item.available, damaged: item.damaged }],
    };
    const archived: Item = {
      ...item,
      id: 2,
      name: 'Archived stock',
      balances: [{ locationId: source.id, available: 0, damaged: 0 }],
      archived: true,
      available: 0,
      damaged: 0,
    };
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        respond({ action: 'archive', locationId: source.id, movedItemIds: [1, 2] }),
      );
    const user = userEvent.setup();
    view(true, [active, archived], [source, destination]);
    await user.click(screen.getByRole('button', { name: 'מיקומים' }));
    const openRetirement = async () => {
      await user.click(
        within(screen.getByRole('row', { name: /Main store/ })).getByRole('button', {
          name: 'ארכוב',
        }),
      );
    };
    await openRetirement();
    expect(await screen.findByRole('alertdialog', { name: 'לארכב את Main store?' })).toBeTruthy();
    expect(screen.getByText(/כל 2 הפריטים, כולל פריטים שבארכיון/)).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Reserve store' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'ביטול' }));
    expect(fetch).not.toHaveBeenCalled();
    await openRetirement();
    await user.selectOptions(screen.getByLabelText('להעביר את כל הפריטים אל'), '32');
    await user.click(screen.getByRole('button', { name: 'ארכוב והעברה' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/inventory/locations/31/retire');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      action: 'archive',
      replacementLocationId: 32,
      expectedItemIds: [1, 2],
      expectedCode: source.code,
      expectedName: source.name,
    });
  });
  it('lets operators inspect and restore damage while disabling catalog mutations and write-off', async () => {
    const calls: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ path: String(url), body: JSON.parse(String(init?.body)) });
      return respond({ eventId: 1 }, 201);
    });
    const user = userEvent.setup();
    view(false);
    expect(
      (screen.getByRole('button', { name: 'הוספת פריט חדש' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    await user.selectOptions(within(screen.getByRole('dialog')).getByLabelText('מיקום'), '1');
    expect((screen.getByLabelText('שם פריט') as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'ביטול' }));
    await user.click(screen.getByRole('button', { name: 'טיפול בפגומים' }));
    await user.selectOptions(screen.getByLabelText('מיקום הפגומים'), '1');
    expect(
      (screen.getByRole('option', { name: 'גריעה קבועה' }) as HTMLOptionElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ itemId: 1, quantity: 1, resolution: 'repair' });
  });
  it('retries an uncertain save with the same command key', async () => {
    const bodies: Record<string, unknown>[] = [];
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      calls += 1;
      if (calls === 1) throw new Error('connection lost');
      return respond(item);
    });
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    await user.selectOptions(within(screen.getByRole('dialog')).getByLabelText('מיקום'), '1');
    await user.clear(screen.getByLabelText('זמין'));
    await user.type(screen.getByLabelText('זמין'), '17');
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await screen.findByRole('button', { name: 'בדוק שוב את אותה פעולה' });
    expect(screen.getByRole('button', { name: 'שמירה' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'בדוק שוב את אותה פעולה' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual(bodies[0]);
  });
  it('recovers a confirmed save by refreshing without another mutation', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      return respond(item);
    });
    onRefresh.mockRejectedValueOnce(new Error('refresh failed'));
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    await user.selectOptions(within(screen.getByRole('dialog')).getByLabelText('מיקום'), '1');
    await user.clear(screen.getByLabelText('זמין'));
    await user.type(screen.getByLabelText('זמין'), '17');
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await screen.findByRole('button', { name: 'רענון נתונים' });
    await user.click(screen.getByRole('button', { name: 'רענון נתונים' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
    expect(calls).toBe(1);
  });
  it('keeps a stale count draft until the current balances are reviewed', async () => {
    const saves: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url) === '/api/items?all=1')
        return respond([
          {
            ...item,
            available: 18,
            stockRevision: 8,
            balances: [{ locationId: 1, available: 18, damaged: 4 }],
          },
        ]);
      saves.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (saves.length === 1) return respond({ error: 'stale_stock', message: 'stale' }, 409);
      return respond({ ...item, available: 17, stockRevision: 9 });
    });
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    await user.selectOptions(within(screen.getByRole('dialog')).getByLabelText('מיקום'), '1');
    await user.clear(screen.getByLabelText('זמין'));
    await user.type(screen.getByLabelText('זמין'), '17');
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await screen.findByText(/יתרות עדכניות: זמין 18/);
    expect((screen.getByLabelText('זמין') as HTMLInputElement).value).toBe('17');
    await user.click(screen.getByRole('button', { name: /בדקתי את היתרות/ }));
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]).toMatchObject({ targetAvailable: 17, stockRevision: 8 });
  });
  it('keeps count saving blocked if the conflict balance fetch fails', async () => {
    let saves = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url) === '/api/items?all=1') throw new Error('offline');
      saves += 1;
      return respond({ error: 'stale_stock', message: 'stale' }, 409);
    });
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    await user.selectOptions(within(screen.getByRole('dialog')).getByLabelText('מיקום'), '1');
    await user.clear(screen.getByLabelText('זמין'));
    await user.type(screen.getByLabelText('זמין'), '17');
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await screen.findByRole('button', { name: 'רענון יתרות לבדיקה' });
    expect((screen.getByLabelText('זמין') as HTMLInputElement).value).toBe('17');
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    expect(saves).toBe(1);
  });
  it('asks before leaving a dirty editor and keeps the draft on refusal', async () => {
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    await user.selectOptions(within(screen.getByRole('dialog')).getByLabelText('מיקום'), '1');
    await user.type(screen.getByLabelText('שם פריט'), ' changed');
    const continueNavigation = vi.fn();
    const guard = registerLeaveGuard.mock.lastCall?.[0] as (
      continueNavigation: () => void,
    ) => boolean;
    expect(guard(continueNavigation)).toBe(false);
    await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: 'להמשיך לערוך' }));
    expect((screen.getByLabelText('שם פריט') as HTMLInputElement).value).toBe('Hammer changed');
    expect(continueNavigation).not.toHaveBeenCalled();
  });
});

const splitLocations: Location[] = [
  { id: 1, name: 'A', code: 'a', archived: false, isDefault: true },
  { id: 2, name: 'B', code: 'b', archived: false, isDefault: false },
];
const splitItem: Item = {
  ...item,
  available: 50,
  damaged: 10,
  balances: [
    { locationId: 1, available: 20, damaged: 4 },
    { locationId: 2, available: 30, damaged: 6 },
  ],
};
it.each([true, false])(
  'opens an existing balance and saves metadata without a stock adjustment (default has stock: %s)',
  async (defaultHasStock) => {
    const save = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(splitItem));
    const user = userEvent.setup();
    const locations = splitLocations.map((location) => ({ ...location, isDefault: false }));
    locations.push({
      id: 3,
      name: 'Front desk',
      code: 'desk',
      archived: false,
      isDefault: !defaultHasStock,
    });
    locations[1]!.isDefault = defaultHasStock;
    view(true, [splitItem], locations);
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('מיקום')).toHaveProperty(
      'value',
      defaultHasStock ? '2' : '1',
    );
    expect(within(dialog).getByLabelText('זמין')).toHaveProperty(
      'value',
      defaultHasStock ? '30' : '20',
    );
    await user.type(within(dialog).getByLabelText('שם פריט'), ' renamed');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const command = JSON.parse(String(save.mock.calls[0]?.[1]?.body));
    expect(command.name).toBe('Hammer renamed');
    expect(command).not.toHaveProperty('targetAvailable');
    expect(command).not.toHaveProperty('stockRevision');
  },
);
it('readonly details show a real balance and permit inspection of other balances without edits', async () => {
  const user = userEvent.setup();
  view(false, [splitItem], splitLocations);
  await user.click(screen.getByRole('button', { name: 'Hammer' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByLabelText('מיקום')).toHaveProperty('value', '1');
  expect(within(dialog).getByLabelText('זמין')).toHaveProperty('value', '20');
  await user.selectOptions(within(dialog).getByLabelText('מיקום'), '2');
  expect(within(dialog).getByLabelText('זמין')).toHaveProperty('value', '30');
  expect(within(dialog).getByRole('button', { name: 'שמירה' })).toHaveProperty('disabled', true);
});
it('confirms before replacing an unsaved local count and retains other item metadata', async () => {
  const user = userEvent.setup();
  view(true, [splitItem], splitLocations);
  await user.click(screen.getByRole('button', { name: 'Hammer' }));
  const dialog = screen.getByRole('dialog');
  await user.selectOptions(within(dialog).getByLabelText('מיקום'), '1');
  await user.type(within(dialog).getByLabelText('שם פריט'), ' renamed');
  await user.clear(within(dialog).getByLabelText('זמין'));
  await user.type(within(dialog).getByLabelText('זמין'), '17');
  await user.selectOptions(within(dialog).getByLabelText('מיקום'), '2');
  await user.click(screen.getByRole('button', { name: 'להמשיך לערוך' }));
  expect(within(dialog).getByLabelText('מיקום')).toHaveProperty('value', '1');
  expect(within(dialog).getByLabelText('זמין')).toHaveProperty('value', '17');
  await user.selectOptions(within(dialog).getByLabelText('מיקום'), '2');
  await user.click(screen.getByRole('button', { name: 'ביטול השינויים' }));
  expect(within(dialog).getByLabelText('מיקום')).toHaveProperty('value', '2');
  expect(within(dialog).getByLabelText('זמין')).toHaveProperty('value', '30');
  expect(within(dialog).getByLabelText('שם פריט')).toHaveProperty('value', 'Hammer renamed');
});
it('requires discard before opening transfer from a dirty item editor', async () => {
  const user = userEvent.setup();
  view(true, [splitItem], splitLocations);
  await user.click(screen.getByRole('button', { name: 'Hammer' }));
  await user.type(screen.getByLabelText('שם פריט'), ' changed');
  await user.click(screen.getByRole('button', { name: 'העברת מלאי בין מיקומים' }));
  await user.click(screen.getByRole('button', { name: 'להמשיך לערוך' }));
  expect(screen.getByLabelText('שם פריט')).toHaveProperty('value', 'Hammer changed');
  await user.click(screen.getByRole('button', { name: 'העברת מלאי בין מיקומים' }));
  await user.click(screen.getByRole('button', { name: 'ביטול השינויים' }));
  expect(screen.getByRole('dialog', { name: 'העברת מלאי' })).toBeTruthy();
});
it.each([
  ['מיקום מקור', '1'],
  ['מיקום יעד', '2'],
  ['מצב', 'damaged'],
  ['כמות', '2'],
  ['הערה', 'move'],
] as const)('guards navigation after changing transfer %s', async (label, value) => {
  const user = userEvent.setup();
  view(true, [splitItem], splitLocations);
  await user.click(screen.getByRole('button', { name: 'Hammer' }));
  await user.click(screen.getByRole('button', { name: 'העברת מלאי בין מיקומים' }));
  const field = screen.getByLabelText(label);
  if (field.tagName === 'SELECT') await user.selectOptions(field, value);
  else {
    await user.clear(field);
    await user.type(field, value);
  }
  const navigate = vi.fn();
  const guard = registerLeaveGuard.mock.lastCall![0] as (next: () => void) => boolean;
  expect(guard(navigate)).toBe(false);
  await screen.findByRole('alertdialog');
  await user.click(screen.getByRole('button', { name: 'להמשיך לערוך' }));
  expect(navigate).not.toHaveBeenCalled();
  expect(field).toHaveProperty('value', value);
  expect(screen.getByRole('dialog', { name: 'העברת מלאי' })).toBeTruthy();
});
it('stale count review identifies selected current balance and requested local target/delta', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
    String(url) === '/api/items?all=1'
      ? respond([
          {
            ...splitItem,
            available: 48,
            damaged: 8,
            stockRevision: 8,
            balances: [
              { locationId: 1, available: 18, damaged: 2 },
              { locationId: 2, available: 30, damaged: 6 },
            ],
          },
        ])
      : respond({ error: 'stale_stock', message: 'stale' }, 409),
  );
  const user = userEvent.setup();
  view(true, [splitItem], splitLocations);
  await user.click(screen.getByRole('button', { name: 'Hammer' }));
  const dialog = screen.getByRole('dialog');
  await user.selectOptions(within(dialog).getByLabelText('מיקום'), '1');
  await user.clear(within(dialog).getByLabelText('זמין'));
  await user.type(within(dialog).getByLabelText('זמין'), '17');
  await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
  await screen.findByText(/יתרות עדכניות: זמין 18.*פגום 2/);
  expect(screen.getByText(/מיקום: A · כמות מבוקשת: 17 · התאמה: -1/)).toBeTruthy();
});
it.each(['transfer', 'damage'] as const)(
  'closes a definitively stale %s and reopens with the refreshed revision',
  async (kind) => {
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? respond({ error: 'stale_stock', message: 'stale' }, 409)
        : respond({ eventId: 1 });
    });
    const user = userEvent.setup();
    const mounted = view(true, [item], splitLocations);
    onRefresh.mockImplementationOnce(async () => {
      mounted.rerender(
        <DialogStackProvider>
          <InventoryManagement
            items={[{ ...item, stockRevision: 8 }]}
            locations={splitLocations}
            ledgerEpoch={1}
            admin={true}
            onRefresh={onRefresh}
            showToast={showToast}
            registerLeaveGuard={registerLeaveGuard}
          />
        </DialogStackProvider>,
      );
    });
    const prepare = async () => {
      if (kind === 'transfer') {
        await user.click(screen.getByRole('button', { name: 'Hammer' }));
        await user.click(screen.getByRole('button', { name: 'העברת מלאי בין מיקומים' }));
        await user.selectOptions(screen.getByLabelText('מיקום מקור'), '1');
        await user.selectOptions(screen.getByLabelText('מיקום יעד'), '2');
      } else {
        await user.click(screen.getByRole('button', { name: 'טיפול בפגומים' }));
        await user.selectOptions(screen.getByLabelText('מיקום הפגומים'), '1');
      }
    };
    await prepare();
    await user.click(screen.getByRole('button', { name: kind === 'transfer' ? 'העברה' : 'שמירה' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await prepare();
    await user.click(screen.getByRole('button', { name: kind === 'transfer' ? 'העברה' : 'שמירה' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[0]!.stockRevision).toBe(7);
    expect(bodies[1]!.stockRevision).toBe(8);
  },
);
it('uncertain transfer retains exact frozen locations, condition and revision for retry', async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) throw new Error('lost response');
    return respond(splitItem);
  });
  const user = userEvent.setup();
  view(true, [splitItem], splitLocations);
  await user.click(screen.getByRole('button', { name: 'Hammer' }));
  await user.click(screen.getByRole('button', { name: 'העברת מלאי בין מיקומים' }));
  await user.selectOptions(screen.getByLabelText('מיקום מקור'), '1');
  await user.selectOptions(screen.getByLabelText('מיקום יעד'), '2');
  await user.selectOptions(screen.getByLabelText('מצב'), 'damaged');
  await user.click(screen.getByRole('button', { name: 'העברה' }));
  await screen.findByRole('button', { name: 'בדוק שוב את אותה פעולה' });
  expect(screen.getByLabelText('מיקום מקור')).toHaveProperty('disabled', true);
  await user.click(screen.getByRole('button', { name: 'בדוק שוב את אותה פעולה' }));
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({
    sourceLocationId: 1,
    destinationLocationId: 2,
    condition: 'damaged',
    stockRevision: 7,
  });
});
