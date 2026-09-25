// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogStackProvider } from '../../src/web/Dialog';
import { InventoryManagement } from '../../src/web/InventoryManagement';
import type { Item } from '../../src/web/InventoryDialogs';

const item: Item = {
  id: 1,
  code: 100,
  name: 'Hammer',
  kind: 'non_consumable',
  lotSize: null,
  locationId: null,
  aliases: ['Mallet'],
  available: 20,
  borrowed: 0,
  lost: 0,
  damaged: 4,
  stockSnapshot: 7,
  archived: false,
};
const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const showToast = vi.fn();
const onRefresh = vi.fn(async () => undefined);
const registerLeaveGuard = vi.fn();
const view = (admin = true) =>
  render(
    <DialogStackProvider>
      <InventoryManagement
        items={[item]}
        locations={[]}
        ledgerEpoch={1}
        admin={admin}
        onRefresh={onRefresh}
        showToast={showToast}
        registerLeaveGuard={registerLeaveGuard}
      />
    </DialogStackProvider>,
  );
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  showToast.mockClear();
  onRefresh.mockClear();
  registerLeaveGuard.mockClear();
});

describe('inventory management UI', () => {
  it('retries uncertain location creation with the same command and returns to the locations table', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) throw new Error('connection lost');
      return respond({ id: 2, code: 'A-2', name: 'Second storage', archived: false }, 201);
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
        respond({ id: 2, code: 'A-2', name: 'Second storage', archived: false }, 201),
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

  it('shows the four balances and requires a discard decision for edited item details', async () => {
    const user = userEvent.setup();
    view();
    expect(screen.getByRole('columnheader', { name: 'מושאל' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'אבוד' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
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
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ path: String(url), body: JSON.parse(String(init?.body)) });
      return respond(item);
    });
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    await user.clear(screen.getByLabelText('זמין'));
    await user.type(screen.getByLabelText('זמין'), '17');
    expect(screen.getByText('התאמה: -3')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.path).toBe('/api/inventory/items/1');
    expect(calls[0]?.body).toMatchObject({ targetAvailable: 17, stockSnapshot: 7, name: 'Hammer' });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
  });

  it('lets operators inspect and restore damage while hiding catalog mutations and write-off', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ path: String(url), body: JSON.parse(String(init?.body)) });
      return respond({ eventId: 1 }, 201);
    });
    const user = userEvent.setup();
    view(false);
    expect(screen.queryByRole('button', { name: 'הוספת פריט חדש' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    expect((screen.getByLabelText('שם פריט') as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'ביטול' }));
    await user.click(screen.getByRole('button', { name: 'טיפול בפגומים' }));
    expect(screen.queryByRole('option', { name: 'גריעה קבועה' })).toBeNull();
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
        return respond([{ ...item, available: 18, stockSnapshot: 8 }]);
      saves.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (saves.length === 1) return respond({ error: 'stale_stock', message: 'stale' }, 409);
      return respond({ ...item, available: 17, stockSnapshot: 9 });
    });
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('button', { name: 'Hammer' }));
    await user.clear(screen.getByLabelText('זמין'));
    await user.type(screen.getByLabelText('זמין'), '17');
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await screen.findByText(/יתרות עדכניות: זמין 18/);
    expect((screen.getByLabelText('זמין') as HTMLInputElement).value).toBe('17');
    await user.click(screen.getByRole('button', { name: /בדקתי את היתרות/ }));
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]).toMatchObject({ targetAvailable: 17, stockSnapshot: 8 });
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
