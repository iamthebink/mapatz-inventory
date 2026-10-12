// @vitest-environment jsdom
import '../helpers/popover';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogStackProvider } from '../../src/web/Dialog';
import { InventoryManagement } from '../../src/web/InventoryManagement';
import type { Item, Location } from '../../src/web/InventoryDialogs';
import { openDatabase } from '../../src/db/database';
import { InventoryService } from '../../src/domain/inventory';
import { installWindowStorage } from '../helpers/window-storage.js';
import {
  persistFrozenAttempt,
  type FrozenOperationAttempt,
} from '../../src/web/borrower-workflow-recovery';
const item: Item = {
  id: 1,
  name: 'Hammer',
  kind: 'non_consumable',
  itemNote: '',
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
  ledgerEpoch: number | null = 1,
  preserveStorage = false,
) => {
  installWindowStorage(!preserveStorage);
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
        ledgerEpoch={ledgerEpoch}
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
  it.each(['stock', 'metadata'] as const)(
    'omits an unchanged captured note while a stale editor changes %s',
    async (change) => {
      const db = openDatabase(':memory:');
      try {
        const inventory = new InventoryService(db);
        const locationId = Number(inventory.listLocations()[0]!.id);
        const created = inventory.createItem({
          name: 'Concurrent notes',
          kind: 'non_consumable',
          locationId,
          itemNote: 'Captured note',
        });
        inventory.addStock(created.id, 20, '', locationId);
        const captured = inventory.listItems()[0]!;
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
          const body = JSON.parse(String(init!.body));
          return respond(inventory.saveInventoryItem({ ...body, itemId: captured.id }));
        });
        const user = userEvent.setup();
        view(
          true,
          [captured],
          [
            {
              id: locationId,
              code: 'test-location',
              name: 'Location',
              archived: false,
              isDefault: false,
            },
          ],
        );
        await user.click(screen.getByRole('button', { name: captured.name }));
        inventory.updateItem(captured.id, { name: captured.name, itemNote: 'Newer domain note' });
        const dialog = screen.getByRole('dialog', { name: 'עריכת פריט' });
        const field = within(dialog).getByRole('textbox', {
          name: change === 'stock' ? 'זמין' : 'שם פריט',
        });
        await user.clear(field);
        await user.type(field, change === 'stock' ? '21' : 'Renamed stale editor');
        await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
        expect(body).not.toHaveProperty('itemNote');
        expect(inventory.listItems()[0]!.itemNote).toBe('Newer domain note');
        expect(inventory.listItems()[0]!).toMatchObject(
          change === 'stock' ? { available: 21 } : { name: 'Renamed stale editor' },
        );
      } finally {
        db.close();
      }
    },
  );

  it.each(['consumable', 'non_consumable', 'camp_equipment'])(
    'creates %s with persistent notes and no stock-event field',
    async (kind) => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(item));
      const user = userEvent.setup();
      view();
      await user.click(screen.getByRole('button', { name: 'הוספת פריט חדש' }));
      const dialog = screen.getByRole('dialog', { name: 'הוספת פריט חדש' });
      await user.selectOptions(within(dialog).getByRole('combobox', { name: 'סוג' }), kind);
      expect(within(dialog).queryByRole('textbox', { name: 'הערות על השינוי' })).toBeNull();
      await user.type(
        within(dialog).getByRole('textbox', { name: 'הערות' }),
        'Full note\nSecond line',
      );
      await user.type(within(dialog).getByRole('textbox', { name: 'שם פריט' }), 'Noted');
      await user.selectOptions(within(dialog).getByRole('combobox', { name: 'מיקום' }), '1');
      await user.clear(within(dialog).getByRole('textbox', { name: 'זמין' }));
      await user.type(within(dialog).getByRole('textbox', { name: 'זמין' }), '3');
      expect(within(dialog).queryByRole('textbox', { name: 'הערות על השינוי' })).toBeNull();
      await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
      expect(body.itemNote).toBe('Full note\nSecond line');
      expect(body).not.toHaveProperty('note');
    },
  );
  it('reads and edits item notes separately from quantity-change notes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(item));
    const user = userEvent.setup();
    view(true, [{ ...item, itemNote: 'Full text\nSecond line' }]);
    const indicator = screen.getByLabelText('הערות לפריט Hammer');
    await user.click(indicator);
    expect(indicator.getAttribute('aria-expanded')).toBe('true');
    expect(indicator.parentElement!.querySelector('.item-note-text')!.textContent).toBe(
      'Full text\nSecond line',
    );
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    const dialog = screen.getByRole('dialog', { name: 'עריכת פריט' });
    const metadata = within(dialog).getByRole('textbox', { name: 'הערות' });
    expect(metadata).toHaveProperty('value', 'Full text\nSecond line');
    expect(within(dialog).queryByRole('textbox', { name: 'הערות על השינוי' })).toBeNull();
    await user.clear(metadata);
    await user.type(metadata, 'Edited metadata');
    await user.clear(within(dialog).getByRole('textbox', { name: 'זמין' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'זמין' }), '21');
    await user.type(
      within(dialog).getByRole('textbox', { name: 'הערות על השינוי' }),
      'Stock reason',
    );
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({
      itemNote: 'Edited metadata',
      note: 'Stock reason',
      targetAvailable: 21,
    });
  });
  it('hides blank indicators and preserves failed note drafts', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respond({ error: 'invalid_item_note', message: 'Save failed' }, 400),
    );
    view(true, [{ ...item, itemNote: '  \n ' }]);
    expect(screen.queryByLabelText('הערות לפריט Hammer')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    const dialog = screen.getByRole('dialog', { name: 'עריכת פריט' });
    const metadata = within(dialog).getByRole('textbox', { name: 'הערות' });
    await user.clear(metadata);
    await user.type(metadata, 'Keep this draft');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(metadata).toHaveProperty('value', 'Keep this draft');
    expect(screen.getByRole('dialog', { name: 'עריכת פריט' })).toBeTruthy();
  });

  it('omits the captured category when saving only metadata', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(item));
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    const dialog = screen.getByRole('dialog', { name: 'עריכת פריט' });
    await user.clear(within(dialog).getByRole('textbox', { name: 'שם פריט' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'שם פריט' }), 'Renamed');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.name).toBe('Renamed');
    expect(body).not.toHaveProperty('kind');
  });
  it('submits an edited category and requires explicit lot clearance', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(respond({ ...item, kind: 'camp_equipment' }));
    const user = userEvent.setup();
    view(true, [{ ...item, kind: 'consumable', damaged: 0, lotSize: 12 }]);
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    const dialog = screen.getByRole('dialog', { name: 'עריכת פריט' });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'סוג' }),
      'camp_equipment',
    );
    expect(within(dialog).getByRole('textbox', { name: 'גודל מארז' })).toHaveProperty(
      'value',
      '12',
    );
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    expect(fetch).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('יש לנקות את גודל המארז', expect.any(String), 'error');
    await user.clear(within(dialog).getByRole('textbox', { name: 'גודל מארז' }));
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toMatchObject({
      kind: 'camp_equipment',
      lotSize: null,
    });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).not.toHaveProperty('itemNote');
  });
  it.each([
    {
      borrowed: 2,
      lost: 0,
      damaged: 0,
      explanation: 'יש לסגור את ההשאלה הפעילה לפני שינוי סוג הפריט',
    },
    {
      borrowed: 0,
      lost: 2,
      damaged: 0,
      explanation: 'יש לטפל בכמויות הפגומות והאבודות לפני שינוי סוג הפריט',
    },
    {
      borrowed: 0,
      lost: 0,
      damaged: 2,
      explanation: 'יש לטפל בכמויות הפגומות והאבודות לפני שינוי סוג הפריט',
    },
  ])(
    'explains blocked category edits with error toasts ($borrowed borrowed, $lost lost, $damaged damaged)',
    async ({ explanation, ...balances }) => {
      const fetch = vi.spyOn(globalThis, 'fetch');
      const user = userEvent.setup();
      view(true, [{ ...item, ...balances }]);
      await user.click(screen.getByRole('button', { name: 'Hammer' }));
      const dialog = screen.getByRole('dialog', { name: 'עריכת פריט' });
      await user.selectOptions(within(dialog).getByRole('combobox', { name: 'סוג' }), 'consumable');
      await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
      expect(fetch).not.toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledWith('לא ניתן לשנות סוג', explanation, 'error');
    },
  );
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
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      'לא ניתן לבדוק פעולות שמורות',
      'בדוק את אחסון הדפדפן ונסה שוב',
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
it.each(['eligible', 'zero damaged', 'absent balance', 'no default', 'archived'] as const)(
  'preselects only an eligible damaged-stock default (%s)',
  async (scenario) => {
    const save = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({ eventId: 1 }, 201));
    const user = userEvent.setup();
    const locations = splitLocations.map((location) => ({
      ...location,
      isDefault: location.id === 2 && scenario !== 'no default',
      archived: location.id === 2 && scenario === 'archived',
    }));
    const balances = splitItem.balances
      .filter((balance) => scenario !== 'absent balance' || balance.locationId !== 2)
      .map((balance) => ({
        ...balance,
        damaged: balance.locationId === 2 && scenario === 'zero damaged' ? 0 : balance.damaged,
      }));
    view(
      true,
      [{ ...splitItem, balances, damaged: balances.reduce((sum, b) => sum + b.damaged, 0) }],
      locations,
    );
    await user.click(screen.getByRole('button', { name: 'טיפול בפגומים' }));
    expect(screen.getByLabelText('מיקום הפגומים')).toHaveProperty(
      'value',
      scenario === 'eligible' ? '2' : '',
    );
    if (scenario !== 'eligible') {
      await user.click(screen.getByRole('button', { name: 'שמירה' }));
      expect(save).not.toHaveBeenCalled();
      await user.selectOptions(screen.getByLabelText('מיקום הפגומים'), '1');
    }
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(JSON.parse(String(save.mock.calls[0]?.[1]?.body))).toMatchObject({
      locationId: scenario === 'eligible' ? 2 : 1,
      resolution: 'repair',
    });
  },
);
it('allows overriding the damaged default and clears that choice for the next item', async () => {
  const save = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({ eventId: 1 }, 201));
  const user = userEvent.setup();
  const otherItem = {
    ...item,
    id: 2,
    name: 'Saw',
    balances: [{ locationId: 2, available: 20, damaged: 4 }],
  };
  view(true, [splitItem, otherItem], splitLocations);
  await user.click(screen.getAllByRole('button', { name: 'טיפול בפגומים' })[0]!);
  expect(screen.getByLabelText('מיקום הפגומים')).toHaveProperty('value', '1');
  await user.selectOptions(screen.getByLabelText('מיקום הפגומים'), '2');
  await user.click(screen.getByRole('button', { name: 'שמירה' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(JSON.parse(String(save.mock.calls[0]?.[1]?.body))).toMatchObject({ locationId: 2 });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await user.click(screen.getAllByRole('button', { name: 'טיפול בפגומים' })[1]!);
  expect(screen.getByLabelText('מיקום הפגומים')).toHaveProperty('value', '');
});
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
  view(false, [{ ...splitItem, itemNote: 'Operator-readable note' }], splitLocations);
  await user.click(screen.getByRole('button', { name: 'Hammer' }));
  const dialog = screen.getByRole('dialog');
  const noteField = within(dialog).getByRole('textbox', { name: 'הערות' });
  expect(noteField).toHaveProperty('value', 'Operator-readable note');
  expect(noteField).toHaveProperty('readOnly', true);
  expect(noteField).toHaveProperty('disabled', false);
  expect(dialog.querySelector('.item-note-text')).toBeNull();
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

it('selects one shared default in the table and preserves it when editing metadata or reloading', async () => {
  const db = openDatabase(':memory:');
  try {
    const inventory = new InventoryService(db);
    const a = inventory.createLocation('a', 'Warehouse A');
    const b = inventory.createLocation('b', 'Warehouse B');
    const archived = inventory.createLocation('old', 'Old warehouse');
    inventory.saveInventoryLocation({
      key: 'archive-old',
      ledgerEpoch: 1,
      locationId: archived.id,
      code: archived.code,
      name: archived.name,
      archived: true,
    });
    const user = userEvent.setup();
    installWindowStorage(true);
    const element = () => (
      <DialogStackProvider>
        <InventoryManagement
          items={[]}
          locations={inventory.listLocations(true) as unknown as Location[]}
          ledgerEpoch={1}
          admin={true}
          onRefresh={onRefresh}
          showToast={showToast}
          registerLeaveGuard={registerLeaveGuard}
        />
      </DialogStackProvider>
    );
    const rendered = render(element());
    onRefresh.mockImplementation(async () => {
      rendered.rerender(element());
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const locationId = Number(String(input).split('/').at(-1));
      return respond(
        inventory.saveInventoryLocation({ ...JSON.parse(String(init!.body)), locationId }),
      );
    });
    await user.click(screen.getByRole('button', { name: 'מיקומים' }));
    expect(screen.getByRole('columnheader', { name: 'ברירת מחדל' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'מיקום ברירת מחדל: Old warehouse' })).toHaveProperty(
      'disabled',
      true,
    );
    for (const location of [a, b]) {
      await user.click(screen.getByRole('radio', { name: `מיקום ברירת מחדל: ${location.name}` }));
      await waitFor(() =>
        expect(
          screen.getByRole('radio', { name: `מיקום ברירת מחדל: ${location.name}` }),
        ).toHaveProperty('checked', true),
      );
      expect(
        screen.getAllByRole('radio').filter((radio) => (radio as HTMLInputElement).checked),
      ).toHaveLength(1);
      expect(inventory.defaultLocationId()).toBe(location.id);
    }
    const row = screen.getByRole('radio', { name: `מיקום ברירת מחדל: ${b.name}` }).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'עריכה' }));
    const dialog = screen.getByRole('dialog', { name: 'עריכת מיקום' });
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    await user.type(within(dialog).getByRole('textbox', { name: 'שם' }), ' renamed');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(JSON.parse(String(fetch.mock.calls.at(-1)![1]!.body))).not.toHaveProperty('isDefault');
    expect(inventory.defaultLocationId()).toBe(b.id);
    rendered.unmount();
    render(element());
    await user.click(screen.getByRole('button', { name: 'מיקומים' }));
    expect(
      screen.getByRole('radio', { name: 'מיקום ברירת מחדל: Warehouse B renamed' }),
    ).toHaveProperty('checked', true);
  } finally {
    onRefresh.mockImplementation(async () => undefined);
    db.close();
  }
});

it('keeps the default unchanged when table selection is rejected', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    respond({ error: { code: 'not_found', message: 'Location removed' } }, 404),
  );
  const locations = [
    { id: 1, code: 'a', name: 'A', archived: false, isDefault: true },
    { id: 2, code: 'b', name: 'B', archived: false, isDefault: false },
  ];
  view(true, [], locations);
  await userEvent.click(screen.getByRole('button', { name: 'מיקומים' }));
  await userEvent.click(screen.getByRole('radio', { name: 'מיקום ברירת מחדל: B' }));
  await waitFor(() =>
    expect(showToast).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'error'),
  );
  expect(screen.getByRole('radio', { name: 'מיקום ברירת מחדל: A' })).toHaveProperty(
    'checked',
    true,
  );
  expect(screen.getByRole('radio', { name: 'מיקום ברירת מחדל: B' })).toHaveProperty(
    'checked',
    false,
  );
});

it('locks table radios during uncertainty and retries the exact selection before refresh-only recovery', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  fetch.mockRejectedValueOnce(new Error('response lost'));
  fetch.mockResolvedValueOnce(respond({}));
  onRefresh.mockRejectedValueOnce(new Error('refresh failed'));
  const user = userEvent.setup();
  view(
    true,
    [],
    [
      { id: 1, code: 'a', name: 'A', archived: false, isDefault: true },
      { id: 2, code: 'b', name: 'B', archived: false, isDefault: false },
    ],
  );
  await user.click(screen.getByRole('button', { name: 'מיקומים' }));
  await user.click(screen.getByRole('radio', { name: 'מיקום ברירת מחדל: B' }));
  expect(screen.getAllByRole('radio').every((radio) => (radio as HTMLInputElement).disabled)).toBe(
    true,
  );
  await user.click(await screen.findByRole('button', { name: 'בדוק שוב את אותה פעולה' }));
  await screen.findByRole('button', { name: 'רענון נתונים' });
  expect(fetch.mock.calls[1]![1]!.body).toBe(fetch.mock.calls[0]![1]!.body);
  expect(screen.getAllByRole('radio').every((radio) => (radio as HTMLInputElement).disabled)).toBe(
    true,
  );
  await user.click(screen.getByRole('button', { name: 'רענון נתונים' }));
  await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not allow an operator to select a shared default', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  view(false);
  await userEvent.click(screen.getByRole('button', { name: 'מיקומים' }));
  const radio = screen.getByRole('radio');
  expect(radio).toHaveProperty('disabled', true);
  await userEvent.click(radio);
  expect(fetch).not.toHaveBeenCalled();
});

it('disables default selection until the ledger epoch is known', async () => {
  view(true, [], undefined, false, null);
  await userEvent.click(screen.getByRole('button', { name: 'מיקומים' }));
  expect(screen.getByRole('radio')).toHaveProperty('disabled', true);
});

it('supports keyboard default selection and blocks another change while saving', async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const user = userEvent.setup();
  view(
    true,
    [],
    [
      { id: 1, code: 'a', name: 'A', archived: false, isDefault: true },
      { id: 2, code: 'b', name: 'B', archived: false, isDefault: false },
    ],
  );
  await user.click(screen.getByRole('button', { name: 'מיקומים' }));
  screen.getByRole('radio', { name: 'מיקום ברירת מחדל: B' }).focus();
  await user.keyboard('[Space]');
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toMatchObject({
    code: 'b',
    isDefault: true,
  });
  expect(screen.getAllByRole('radio').every((radio) => (radio as HTMLInputElement).disabled)).toBe(
    true,
  );
  await user.click(screen.getByRole('radio', { name: 'מיקום ברירת מחדל: A' }));
  expect(fetch).toHaveBeenCalledOnce();
  finish(respond({}));
  await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
});

function lostFixture() {
  const db = openDatabase(':memory:');
  const service = new InventoryService(db);
  const source = Number(service.listLocations()[0]!.id);
  const target = Number(service.createLocation('found', 'Found destination').id);
  service.updateLocation(target, { code: 'found', name: 'Found destination', isDefault: true });
  const equipment = service.createItem({
    name: 'Recovery hammer',
    kind: 'non_consumable',
    locationId: source,
  });
  service.addStock(equipment.id, 8, '', source);
  const borrower = service.createBorrower({ fullName: 'First borrower', playaName: 'Alpha' });
  const other = service.createBorrower({ fullName: 'Second borrower', playaName: 'Beta' });
  for (const person of [borrower, other])
    service.markLost(service.checkout(equipment.id, person.id, 3, '', source), 3, true);
  const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    if (path.endsWith('/lost-borrowers'))
      return respond(service.getItemLostBorrowers(equipment.id));
    if (path.endsWith('/desk-snapshot'))
      return respond(service.getBorrowerDeskSnapshot(Number(path.split('/')[3])));
    if (path.endsWith('/operations')) {
      const result = service.commitBorrowerOperations(
        Number(path.split('/')[3]),
        new Headers(init?.headers).get('Idempotency-Key')!,
        JSON.parse(String(init?.body)),
      );
      return respond(result, 'outcome' in result && result.outcome === 'committed' ? 201 : 409);
    }
    throw new Error(`Unexpected read ${path}`);
  };
  return { db, service, source, target, equipment, borrower, other, serve };
}
async function openLost(borrowerId: number) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'השב אבדה' }));
  const dialog = screen.getByRole('dialog', { name: 'השב אבדה' });
  await waitFor(() =>
    expect((within(dialog).getByLabelText('שואל') as HTMLSelectElement).disabled).toBe(false),
  );
  await user.selectOptions(within(dialog).getByLabelText('שואל'), String(borrowerId));
  await waitFor(() =>
    expect(
      (within(dialog).getByRole('button', { name: 'השב אבדה' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  return { user, dialog };
}
describe('inventory lost recovery', () => {
  it('disables zero lost rows and defaults to stockless shared destination with damaged return support', async () => {
    const fixture = lostFixture();
    try {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fixture.serve);
      view(false, fixture.service.listItems(), fixture.service.listLocations() as Location[]);
      const { user, dialog } = await openLost(fixture.borrower.id);
      expect((within(dialog).getByLabelText('כמות') as HTMLInputElement).value).toBe('1');
      expect((within(dialog).getByLabelText('מיקום יעד') as HTMLSelectElement).value).toBe(
        String(fixture.target),
      );
      await user.click(within(dialog).getByLabelText('הוחזר פגום'));
      await user.click(within(dialog).getByRole('button', { name: 'השב אבדה' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const write = fetch.mock.calls.find(([url]) => String(url).endsWith('/operations'))!;
      expect(JSON.parse(String(write[1]?.body)).items[0].lostCredit[0]).toMatchObject({
        quantity: 1,
        condition: 'damaged',
        locationId: fixture.target,
      });
      expect(fixture.service.getBorrowerDeskSnapshot(fixture.borrower.id).holdings[0]!.lost).toBe(
        2,
      );
      expect(fixture.service.getBorrowerDeskSnapshot(fixture.other.id).holdings[0]!.lost).toBe(3);
      cleanup();
      view(false);
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'השב אבדה' }) as HTMLButtonElement).disabled,
        ).toBe(true),
      );
    } finally {
      fixture.db.close();
    }
  });
  it.each(['network', 'server', 'malformed'] as const)(
    'freezes intent after %s and retries byte-for-byte through authorization loss',
    async (failure) => {
      const fixture = lostFixture();
      try {
        let writes = 0;
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          if (!String(input).endsWith('/operations')) return fixture.serve(input, init);
          writes += 1;
          if (writes === 1) {
            await fixture.serve(input, init);
            if (failure === 'network') throw new Error('lost response');
            return respond({}, failure === 'server' ? 500 : 201);
          }
          if (writes === 2) return respond({ error: 'forbidden' }, 403);
          return fixture.serve(input, init);
        });
        view(false, fixture.service.listItems(), fixture.service.listLocations() as Location[]);
        const { user, dialog } = await openLost(fixture.borrower.id);
        await user.click(within(dialog).getByRole('button', { name: 'השב אבדה' }));
        await waitFor(() =>
          expect((within(dialog).getByLabelText('כמות') as HTMLInputElement).disabled).toBe(true),
        );
        expect(registerLeaveGuard.mock.calls.at(-1)![0](() => undefined)).toBe(false);
        await user.click(within(dialog).getByRole('button', { name: 'בדוק שוב את אותה פעולה' }));
        await waitFor(() => expect(writes).toBe(2));
        expect(window.localStorage.length).toBe(1);
        await user.click(within(dialog).getByRole('button', { name: 'בדוק שוב את אותה פעולה' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        const attempts = fetch.mock.calls
          .filter(([url]) => String(url).endsWith('/operations'))
          .map(([, init]) => init);
        expect(attempts[1]).toEqual(attempts[0]);
        expect(attempts[2]).toEqual(attempts[0]);
        expect(fixture.service.getBorrowerDeskSnapshot(fixture.borrower.id).holdings[0]!.lost).toBe(
          2,
        );
        expect(window.localStorage.length).toBe(0);
      } finally {
        fixture.db.close();
      }
    },
  );
  it('resolves an uncertain committed return after remount without creating another recovery', async () => {
    const fixture = lostFixture();
    try {
      let lose = true;
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const result = await fixture.serve(input, init);
        if (lose && String(input).endsWith('/operations')) {
          lose = false;
          throw new Error('lost response');
        }
        return result;
      });
      view(false, fixture.service.listItems(), fixture.service.listLocations() as Location[]);
      const { user, dialog } = await openLost(fixture.borrower.id);
      await user.click(within(dialog).getByRole('button', { name: 'השב אבדה' }));
      await waitFor(() => expect(window.localStorage.length).toBe(1));
      cleanup();
      view(
        false,
        fixture.service.listItems(),
        fixture.service.listLocations() as Location[],
        false,
        1,
        true,
      );
      await waitFor(() => expect(window.localStorage.length).toBe(0));
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/operations'))).toHaveLength(
        2,
      );
      expect(fixture.service.getBorrowerDeskSnapshot(fixture.borrower.id).holdings[0]!.lost).toBe(
        2,
      );
    } finally {
      fixture.db.close();
    }
  });
  it('uses refresh-only recovery after commit and never resends the command', async () => {
    const fixture = lostFixture();
    try {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fixture.serve);
      onRefresh.mockRejectedValueOnce(new Error('offline'));
      view(false, fixture.service.listItems(), fixture.service.listLocations() as Location[]);
      const { user, dialog } = await openLost(fixture.borrower.id);
      await user.click(within(dialog).getByRole('button', { name: 'השב אבדה' }));
      const retry = await within(dialog).findByRole('button', { name: 'רענון נתונים' });
      await user.click(retry);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/operations'))).toHaveLength(
        1,
      );
    } finally {
      fixture.db.close();
    }
  });
  it('preserves destination, quantity and note across conflict refresh and requires deliberate resubmission', async () => {
    const fixture = lostFixture();
    try {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fixture.serve);
      view(false, fixture.service.listItems(), fixture.service.listLocations() as Location[]);
      const { user, dialog } = await openLost(fixture.borrower.id);
      await user.selectOptions(within(dialog).getByLabelText('מיקום יעד'), String(fixture.source));
      await user.clear(within(dialog).getByLabelText('כמות'));
      await user.type(within(dialog).getByLabelText('כמות'), '3');
      await user.type(within(dialog).getByLabelText('הערה (רשות)'), 'keep me');
      fixture.service.commitBorrowerOperations(fixture.borrower.id, crypto.randomUUID(), {
        contractVersion: 1,
        ledgerEpoch: 1,
        items: [
          {
            itemId: fixture.equipment.id,
            lostCredit: [
              { quantity: 1, condition: 'usable', locationId: fixture.target, note: '' },
            ],
          },
        ],
      });
      await user.click(within(dialog).getByRole('button', { name: 'השב אבדה' }));
      await waitFor(() =>
        expect((within(dialog).getByLabelText('כמות') as HTMLInputElement).max).toBe('2'),
      );
      expect(within(dialog).getByText('Recovery hammer · אבוד: 5')).toBeTruthy();
      expect((within(dialog).getByLabelText('מיקום יעד') as HTMLSelectElement).value).toBe(
        String(fixture.source),
      );
      expect((within(dialog).getByLabelText('כמות') as HTMLInputElement).value).toBe('3');
      expect((within(dialog).getByLabelText('הערה (רשות)') as HTMLInputElement).value).toBe(
        'keep me',
      );
      expect(
        (within(dialog).getByRole('button', { name: 'השב אבדה' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/operations'))).toHaveLength(
        1,
      );
    } finally {
      fixture.db.close();
    }
  });
  it('retains the draft on a failed read and rejects mismatched epochs', async () => {
    const fixture = lostFixture();
    try {
      let fail = true;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (String(input).endsWith('/desk-snapshot')) {
          if (fail) {
            fail = false;
            throw new Error('offline');
          }
          return respond({
            ...fixture.service.getBorrowerDeskSnapshot(fixture.borrower.id),
            ledgerEpoch: 2,
          });
        }
        return fixture.serve(input, init);
      });
      view(false, fixture.service.listItems(), fixture.service.listLocations() as Location[]);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'השב אבדה' }));
      const dialog = screen.getByRole('dialog');
      await waitFor(() =>
        expect((within(dialog).getByLabelText('שואל') as HTMLSelectElement).disabled).toBe(false),
      );
      await user.type(within(dialog).getByLabelText('הערה (רשות)'), 'preserved');
      await user.selectOptions(within(dialog).getByLabelText('שואל'), String(fixture.borrower.id));
      await user.click(await within(dialog).findByRole('button', { name: 'ניסיון טעינה מחדש' }));
      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          'טעינת האבדות נכשלה',
          expect.stringContaining('הוחלף'),
          'error',
        ),
      );
      expect((within(dialog).getByLabelText('הערה (רשות)') as HTMLInputElement).value).toBe(
        'preserved',
      );
      expect(
        (within(dialog).getByRole('button', { name: 'השב אבדה' }) as HTMLButtonElement).disabled,
      ).toBe(true);
    } finally {
      fixture.db.close();
    }
  });
});

it.each(['setItem', 'removeItem'] as const)(
  'locks lost recovery after %s failure and retries without duplicate credit',
  async (method) => {
    const fixture = lostFixture();
    try {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fixture.serve);
      view(false, fixture.service.listItems(), fixture.service.listLocations() as Location[]);
      const { user, dialog } = await openLost(fixture.borrower.id);
      const failure = vi.spyOn(window.localStorage, method).mockImplementationOnce(() => {
        throw new Error('storage failure');
      });
      await user.click(within(dialog).getByRole('button', { name: 'השב אבדה' }));
      await waitFor(() =>
        expect((within(dialog).getByLabelText('כמות') as HTMLInputElement).disabled).toBe(true),
      );
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/operations'))).toHaveLength(
        method === 'setItem' ? 0 : 1,
      );
      if (method === 'setItem') {
        expect(showToast).toHaveBeenCalledWith(
          'שמירת נתוני השחזור נכשלה',
          'לא ניתן לאמת את שמירת הפעולה לשחזור. יש לבדוק שוב את אותה פעולה לפני שינוי נוסף.',
          'error',
        );
        expect(showToast).not.toHaveBeenCalledWith(
          'תוצאת הפעולה אינה ידועה',
          expect.anything(),
          expect.anything(),
        );
      }
      failure.mockRestore();
      await user.click(within(dialog).getByRole('button', { name: 'בדוק שוב את אותה פעולה' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(fixture.service.getBorrowerDeskSnapshot(fixture.borrower.id).holdings[0]!.lost).toBe(
        2,
      );
    } finally {
      fixture.db.close();
    }
  },
);

it('ignores stale borrower reads after selection changes and after the dirty dialog closes', async () => {
  const fixture = lostFixture();
  try {
    let resolveFirst!: (response: Response) => void;
    let hold = true;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (hold && String(input) === `/api/borrowers/${fixture.borrower.id}/desk-snapshot`)
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      return fixture.serve(input, init);
    });
    view(false, fixture.service.listItems(), fixture.service.listLocations() as Location[]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'השב אבדה' }));
    const dialog = screen.getByRole('dialog');
    await waitFor(() =>
      expect((within(dialog).getByLabelText('שואל') as HTMLSelectElement).disabled).toBe(false),
    );
    await user.selectOptions(within(dialog).getByLabelText('שואל'), String(fixture.borrower.id));
    await waitFor(() => expect(resolveFirst).toBeDefined());
    await user.selectOptions(within(dialog).getByLabelText('שואל'), String(fixture.other.id));
    await waitFor(() =>
      expect(
        (within(dialog).getByRole('button', { name: 'השב אבדה' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    resolveFirst(respond(fixture.service.getBorrowerDeskSnapshot(fixture.borrower.id)));
    hold = false;
    await user.click(within(dialog).getByRole('button', { name: 'השב אבדה' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetch.mock.calls.find(([url]) => String(url).endsWith('/operations'))?.[0]).toBe(
      `/api/borrowers/${fixture.other.id}/operations`,
    );
    hold = true;
    await user.click(screen.getByRole('button', { name: 'השב אבדה' }));
    await waitFor(() =>
      expect((screen.getByLabelText('שואל') as HTMLSelectElement).disabled).toBe(false),
    );
    await user.selectOptions(screen.getByLabelText('שואל'), String(fixture.borrower.id));
    await user.click(screen.getByRole('button', { name: 'ביטול' }));
    await user.click(screen.getByRole('button', { name: 'ביטול השינויים' }));
    resolveFirst(respond(fixture.service.getBorrowerDeskSnapshot(fixture.borrower.id)));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  } finally {
    fixture.db.close();
  }
});

it('keeps an untouched destination after conflict refresh and borrower changes update the shared default', async () => {
  const fixture = lostFixture();
  try {
    vi.spyOn(globalThis, 'fetch').mockImplementation(fixture.serve);
    view(false, fixture.service.listItems(), fixture.service.listLocations() as Location[]);
    const { user, dialog } = await openLost(fixture.borrower.id);
    expect((within(dialog).getByLabelText('מיקום יעד') as HTMLSelectElement).value).toBe(
      String(fixture.target),
    );
    await user.clear(within(dialog).getByLabelText('כמות'));
    await user.type(within(dialog).getByLabelText('כמות'), '3');
    const source = fixture.service
      .listLocations()
      .find((location) => location.id === fixture.source)!;
    fixture.service.updateLocation(fixture.source, {
      code: source.code,
      name: source.name,
      isDefault: true,
    });
    fixture.service.commitBorrowerOperations(fixture.borrower.id, crypto.randomUUID(), {
      contractVersion: 1,
      ledgerEpoch: 1,
      items: [
        {
          itemId: fixture.equipment.id,
          lostCredit: [{ quantity: 1, condition: 'usable', locationId: fixture.source, note: '' }],
        },
      ],
    });
    await user.click(within(dialog).getByRole('button', { name: 'השב אבדה' }));
    await waitFor(() =>
      expect((within(dialog).getByLabelText('כמות') as HTMLInputElement).max).toBe('2'),
    );
    expect((within(dialog).getByLabelText('מיקום יעד') as HTMLSelectElement).value).toBe(
      String(fixture.target),
    );
    expect(within(dialog).getByText('Recovery hammer · אבוד: 5')).toBeTruthy();
    await user.selectOptions(within(dialog).getByLabelText('שואל'), String(fixture.other.id));
    await waitFor(() =>
      expect((within(dialog).getByLabelText('כמות') as HTMLInputElement).max).toBe('3'),
    );
    expect((within(dialog).getByLabelText('מיקום יעד') as HTMLSelectElement).value).toBe(
      String(fixture.target),
    );
  } finally {
    fixture.db.close();
  }
});

it('retains the captured editor epoch when replacement and a parent refresh reuse item and borrower IDs', async () => {
  const fixture = lostFixture();
  try {
    let replaced = false;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (replaced && String(input).endsWith('/lost-borrowers'))
        return respond({
          ...fixture.service.getItemLostBorrowers(fixture.equipment.id),
          ledgerEpoch: 2,
        });
      if (replaced && String(input).endsWith('/desk-snapshot'))
        return respond({
          ...fixture.service.getBorrowerDeskSnapshot(Number(String(input).split('/')[3])),
          ledgerEpoch: 2,
        });
      return fixture.serve(input, init);
    });
    const rendered = view(
      false,
      fixture.service.listItems(),
      fixture.service.listLocations() as Location[],
    );
    const { user, dialog } = await openLost(fixture.borrower.id);
    await user.type(within(dialog).getByLabelText('הערה (רשות)'), 'original ledger draft');
    replaced = true;
    rendered.rerender(
      <DialogStackProvider>
        <InventoryManagement
          items={fixture.service
            .listItems()
            .map((entry) => ({ ...entry, name: 'Replacement item' }))}
          locations={fixture.service.listLocations() as Location[]}
          ledgerEpoch={2}
          admin={false}
          onRefresh={onRefresh}
          showToast={showToast}
          registerLeaveGuard={registerLeaveGuard}
        />
      </DialogStackProvider>,
    );
    // Selecting another borrower forces a read after the parent has refreshed to the new epoch.
    await user.selectOptions(within(dialog).getByLabelText('שואל'), String(fixture.other.id));
    await within(dialog).findByRole('button', { name: 'ניסיון טעינה מחדש' });
    expect(showToast).toHaveBeenCalledWith(
      'טעינת האבדות נכשלה',
      expect.stringContaining('הוחלף'),
      'error',
    );
    expect(
      (within(dialog).getByRole('button', { name: 'השב אבדה' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((within(dialog).getByLabelText('הערה (רשות)') as HTMLTextAreaElement).value).toBe(
      'original ledger draft',
    );
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/operations'))).toBe(false);
  } finally {
    fixture.db.close();
  }
});

it.each(['rejected', 'protocol'] as const)(
  'reports a definitive %s startup recovery and asks for deliberate review',
  async (outcome) => {
    const fixture = lostFixture();
    try {
      const attempt: FrozenOperationAttempt = {
        version: 1,
        kind: 'operation',
        subjectId: fixture.borrower.id,
        endpoint: `/borrowers/${fixture.borrower.id}/operations`,
        idempotencyKey: crypto.randomUUID(),
        ledgerEpoch: 1,
        stateRevision: fixture.service.getBorrowerDeskSnapshot(fixture.borrower.id).stateRevision,
        intent: 'save',
        body: {
          contractVersion: 1,
          ledgerEpoch: 1,
          items: [
            {
              itemId: fixture.equipment.id,
              lostCredit: [
                { quantity: 4, condition: 'usable', locationId: fixture.target, note: '' },
              ],
            },
          ],
        },
      };
      const storage = installWindowStorage(true);
      expect(persistFrozenAttempt(storage, attempt).ok).toBe(true);
      if (outcome === 'rejected')
        fixture.service.commitBorrowerOperations(
          fixture.borrower.id,
          attempt.idempotencyKey,
          attempt.body,
        );
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (outcome === 'protocol' && String(input).endsWith('/operations'))
          return respond(
            {
              error: 'ledger_epoch_changed',
              outcome: 'protocol_error',
              idempotencyKey: attempt.idempotencyKey,
              message: 'Ledger replaced',
            },
            409,
          );
        return fixture.serve(input, init);
      });
      view(
        false,
        fixture.service.listItems(),
        fixture.service.listLocations() as Location[],
        false,
        1,
        true,
      );
      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          'הפעולה הקודמת נדחתה',
          'יש לפתוח מחדש את הפעולה ולבדוק את הנתונים לפני שליחה נוספת.',
          'warning',
        ),
      );
      expect(storage.length).toBe(0);
      expect((screen.getByRole('button', { name: 'השב אבדה' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
      expect(onRefresh).not.toHaveBeenCalled();
    } finally {
      fixture.db.close();
    }
  },
);

it('shows archived lost obligations as disabled choices that require borrower reactivation', async () => {
  const fixture = lostFixture();
  try {
    fixture.db.prepare('UPDATE borrowers SET archived=1 WHERE id=?').run(fixture.other.id);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fixture.serve);
    view(false, fixture.service.listItems(), fixture.service.listLocations() as Location[]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'השב אבדה' }));
    const option = await screen.findByRole('option', {
      name: /Second borrower.*אבוד: 3.*יש להפעיל מחדש את השואל/,
    });
    expect((option as HTMLOptionElement).disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText('שואל'), String(fixture.other.id));
    expect((screen.getByLabelText('שואל') as HTMLSelectElement).value).toBe('');
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/desk-snapshot'))).toBe(false);
  } finally {
    fixture.db.close();
  }
});

it('blocks save and offers read retry when the lost lookup responds for another item', async () => {
  const fixture = lostFixture();
  try {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) =>
      String(input).endsWith('/lost-borrowers')
        ? respond({
            ...fixture.service.getItemLostBorrowers(fixture.equipment.id),
            itemId: fixture.equipment.id + 1,
          })
        : fixture.serve(input, init),
    );
    view(false, fixture.service.listItems(), fixture.service.listLocations() as Location[]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'השב אבדה' }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('button', { name: 'ניסיון טעינה מחדש' });
    expect(
      (within(dialog).getByRole('button', { name: 'השב אבדה' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((within(dialog).getByLabelText('שואל') as HTMLSelectElement).disabled).toBe(true);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/operations'))).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      'טעינת האבדות נכשלה',
      'השרת החזיר רשימת אבדות לא תקינה',
      'error',
    );
  } finally {
    fixture.db.close();
  }
});
