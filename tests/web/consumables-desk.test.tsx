// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Item } from '../../src/domain/types';
import { ConsumablesDesk } from '../../src/web/ConsumablesDesk';
import { hasStoredConsumableAttempt } from '../../src/web/consumable-attempt-storage';
import { DialogStackProvider } from '../../src/web/Dialog';

const item = (id: number, name: string, available = 5): Item => ({
  id,
  code: 100 + id,
  name,
  kind: 'consumable',
  aliases: [],
  lotSize: null,
  locationId: null,
  archived: false,
  available,
  damaged: 0,
  borrowed: 0,
  lost: 0,
  stockSnapshot: 1,
});
const stock = [item(1, 'סרט'), item(2, 'אזיקונים'), item(3, 'כפפות', 0)];
const storageKey = 'mapatz-consumable-batch-attempt';
type LeaveGuard = (continueNavigation: () => void) => boolean;
function mount(
  items = stock,
  refresh = vi.fn(async () => undefined),
  showToast = vi.fn(),
  registerLeaveGuard?: (guard: LeaveGuard | null) => void,
) {
  render(
    <DialogStackProvider>
      <ConsumablesDesk
        items={items}
        ledgerEpoch={1}
        refresh={refresh}
        showToast={showToast}
        registerLeaveGuard={registerLeaveGuard}
      />
    </DialogStackProvider>,
  );
  return { user: userEvent.setup(), refresh, showToast };
}
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  });
});

it('ignores malformed stored attempts and cannot review an empty pending batch', () => {
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      key: 'bad-key',
      ledgerEpoch: 1,
      items: [{ itemId: 1, quantity: 1, note: '' }],
    }),
  );
  expect(hasStoredConsumableAttempt()).toBe(false);
  mount([item(1, 'סרט')]);
  expect(screen.getByRole('button', { name: 'ניפוק' })).toHaveProperty('disabled', false);
  expect(screen.getByRole('button', { name: 'בדיקה ואישור הניפוק' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(screen.queryByRole('button', { name: 'בדיקת הפעולה השמורה' })).toBeNull();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shows searchable active stock, including zero-stock rows, with disabled issue action', async () => {
  const { user } = mount([...stock, { ...item(4, 'ארכיון'), archived: true }]);
  expect(screen.getByRole('row', { name: /כפפות/ })).toBeTruthy();
  expect(
    within(screen.getByRole('row', { name: /כפפות/ })).getByRole('button', { name: 'ניפוק' }),
  ).toHaveProperty('disabled', true);
  expect(screen.queryByText('ארכיון')).toBeNull();
  await user.type(screen.getByRole('searchbox', { name: 'חיפוש ציוד מתכלה' }), 'אזיקונים');
  expect(screen.getByText('פריט אחד')).toBeTruthy();
  expect(screen.getByRole('row', { name: /אזיקונים/ })).toBeTruthy();
  expect(screen.queryByRole('row', { name: /סרט/ })).toBeNull();
  await user.clear(screen.getByRole('searchbox', { name: 'חיפוש ציוד מתכלה' }));
  await user.type(screen.getByRole('searchbox', { name: 'חיפוש ציוד מתכלה' }), 'missing');
  expect(screen.getByText('לא נמצאו פריטים המתאימים לחיפוש.')).toBeTruthy();
});

it('stages only from an item-specific dialog and keeps invalid quantity focused there', async () => {
  const send = vi.fn();
  vi.stubGlobal('fetch', send);
  const { user } = mount([item(1, 'סרט')]);
  const row = screen.getByRole('row', { name: /סרט/ });
  await user.click(within(row).getByRole('button', { name: 'ניפוק' }));
  const dialog = screen.getByRole('dialog', { name: 'ניפוק סרט' });
  expect(
    within(dialog).getByText(
      (_text, element) =>
        element?.tagName === 'P' && element.textContent?.includes('סרט · קוד 101') === true,
    ),
  ).toBeTruthy();
  await user.clear(within(dialog).getByRole('spinbutton', { name: 'כמות' }));
  await user.type(within(dialog).getByRole('spinbutton', { name: 'כמות' }), '6');
  await user.click(within(dialog).getByRole('button', { name: 'הוספה לעסקה' }));
  expect(within(dialog).getByRole('alert').textContent).toContain('סרט');
  expect(document.activeElement).toBe(within(dialog).getByRole('spinbutton', { name: 'כמות' }));
  await user.clear(within(dialog).getByRole('spinbutton', { name: 'כמות' }));
  await user.type(within(dialog).getByRole('spinbutton', { name: 'כמות' }), '2');
  await user.click(within(dialog).getByRole('button', { name: 'הוספה לעסקה' }));
  expect(screen.queryByRole('dialog', { name: 'ניפוק סרט' })).toBeNull();
  expect(screen.getByText('× 2')).toBeTruthy();
  expect(screen.getByText('סך יחידות לניפוק').nextElementSibling?.textContent).toBe('2');
  expect(send).not.toHaveBeenCalled();
});

it('sends one atomic command with corrected retained rows and retries the same key after uncertainty', async () => {
  const requests: Array<{ key: string; body: { items: unknown[] } }> = [];
  let lost = true;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const key = new Headers(init?.headers).get('Idempotency-Key') ?? '';
    requests.push({ key, body: JSON.parse(String(init?.body)) });
    if (lost) {
      lost = false;
      throw new Error('lost response');
    }
    return new Response(
      JSON.stringify({ outcome: 'committed', idempotencyKey: key, replayed: true, conflicts: [] }),
      { status: 201 },
    );
  });
  const { user, refresh } = mount();
  await user.click(
    within(screen.getByRole('row', { name: /סרט/ })).getByRole('button', { name: 'ניפוק' }),
  );
  await user.click(screen.getByRole('button', { name: 'הוספה לעסקה' }));
  await user.click(
    within(screen.getByRole('row', { name: /אזיקונים/ })).getByRole('button', { name: 'ניפוק' }),
  );
  await user.click(screen.getByRole('button', { name: 'הוספה לעסקה' }));
  await user.click(screen.getAllByRole('button', { name: 'עריכת כמות והערה' })[0]!);
  const edit = screen.getByRole('dialog', { name: 'עריכת כמות והערה סרט' });
  await user.clear(within(edit).getByRole('spinbutton', { name: 'כמות' }));
  await user.type(within(edit).getByRole('spinbutton', { name: 'כמות' }), '2');
  await user.click(within(edit).getByRole('button', { name: 'שמירת שינוי' }));
  await user.click(screen.getAllByRole('button', { name: 'הסרה' })[1]!);
  expect(screen.getByText('סך יחידות לניפוק').nextElementSibling?.textContent).toBe('2');
  await user.click(screen.getByRole('button', { name: 'בדיקה ואישור הניפוק' }));
  const review = screen.getByRole('alertdialog', { name: 'אישור ניפוק' });
  expect(within(review).getByText(/סרט · קוד 101 · כמות 2/)).toBeTruthy();
  expect(within(review).getByText('סך יחידות לניפוק: 2')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'אישור ניפוק' }));
  expect(requests).toHaveLength(1);
  expect(requests[0]?.body.items).toEqual([{ itemId: 1, quantity: 2, note: '' }]);
  await user.click(screen.getByRole('button', { name: 'בדיקת הפעולה השמורה' }));
  expect(requests.map((request) => request.key)).toEqual([requests[0]?.key, requests[0]?.key]);
  expect(refresh).toHaveBeenCalledOnce();
});

it('restores a valid attempt and preserves correction controls after authoritative rejection', async () => {
  const key = '00000000-0000-4000-8000-000000000921';
  localStorage.setItem(
    storageKey,
    JSON.stringify({ key, ledgerEpoch: 3, items: [{ itemId: 1, quantity: 2, note: 'saved' }] }),
  );
  expect(hasStoredConsumableAttempt()).toBe(true);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        outcome: 'rejected',
        idempotencyKey: key,
        replayed: false,
        conflicts: [{ itemId: 1, code: 'insufficient_stock', available: 1 }],
      }),
      { status: 409 },
    ),
  );
  const { user, showToast } = mount();
  expect(
    screen.getByText('הפעולה נשלחה. יש לבדוק את תוצאתה השמורה לפני המשך העבודה.'),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'עריכת כמות והערה' })).toHaveProperty('disabled', true);
  await user.click(screen.getByRole('button', { name: 'בדיקת הפעולה השמורה' }));
  expect(screen.getByText('הכמויות במלאי לא משתנות עד האישור הסופי.')).toBeTruthy();
  expect(await screen.findByRole('button', { name: 'עריכת כמות והערה' })).toHaveProperty(
    'disabled',
    false,
  );
  await user.click(screen.getByRole('button', { name: 'עריכת כמות והערה' }));
  const edit = screen.getByRole('dialog', { name: 'עריכת כמות והערה סרט' });
  expect(within(edit).getByRole('spinbutton', { name: 'כמות' })).toHaveProperty('value', '2');
  expect(within(edit).getByRole('textbox', { name: 'הערה (רשות)' })).toHaveProperty(
    'value',
    'saved',
  );
  expect(showToast.mock.lastCall?.[1]).toContain('סרט: זמין 1');
});

it('rejects a repeated selection that exceeds cumulative stock and keeps the item in focus', async () => {
  const { user } = mount([item(1, 'סרט', 2)]);
  const issue = () =>
    within(screen.getByRole('row', { name: /סרט/ })).getByRole('button', { name: 'ניפוק' });
  await user.click(issue());
  await user.click(screen.getByRole('button', { name: 'הוספה לעסקה' }));
  await user.click(issue());
  const dialog = screen.getByRole('dialog', { name: 'ניפוק סרט' });
  await user.clear(within(dialog).getByRole('spinbutton', { name: 'כמות' }));
  await user.type(within(dialog).getByRole('spinbutton', { name: 'כמות' }), '2');
  await user.click(within(dialog).getByRole('button', { name: 'הוספה לעסקה' }));
  expect(within(dialog).getByRole('alert').textContent).toContain('סרט');
  expect(document.querySelectorAll('.consumables-draft-item')).toHaveLength(1);
  expect(document.activeElement).toBe(within(dialog).getByRole('spinbutton', { name: 'כמות' }));
});

it('blocks an invalid edit while retaining the original quantity and total', async () => {
  const showToast = vi.fn();
  const { user } = mount(
    [item(1, 'סרט')],
    vi.fn(async () => undefined),
    showToast,
  );
  await user.click(
    within(screen.getByRole('row', { name: /סרט/ })).getByRole('button', { name: 'ניפוק' }),
  );
  await user.click(screen.getByRole('button', { name: 'הוספה לעסקה' }));
  await user.click(screen.getByRole('button', { name: 'עריכת כמות והערה' }));
  const edit = screen.getByRole('dialog', { name: 'עריכת כמות והערה סרט' });
  await user.clear(within(edit).getByRole('spinbutton', { name: 'כמות' }));
  await user.type(within(edit).getByRole('spinbutton', { name: 'כמות' }), '0');
  await user.click(within(edit).getByRole('button', { name: 'שמירת שינוי' }));
  expect(within(edit).getByRole('alert').textContent).toContain('סרט');
  await user.click(within(edit).getByRole('button', { name: 'ביטול' }));
  expect(screen.getByText('סך יחידות לניפוק').nextElementSibling?.textContent).toBe('1');
  expect(showToast).not.toHaveBeenCalled();
});

it('locks navigation and editing while the atomic submission is in flight', async () => {
  let finish!: (response: Response) => void;
  const sent = vi.spyOn(globalThis, 'fetch').mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  let guard!: LeaveGuard;
  const { user } = mount(
    [item(1, 'סרט')],
    vi.fn(async () => undefined),
    vi.fn(),
    (next) => {
      if (next) guard = next;
    },
  );
  await user.click(screen.getByRole('button', { name: 'ניפוק' }));
  await user.click(screen.getByRole('button', { name: 'הוספה לעסקה' }));
  await user.click(screen.getByRole('button', { name: 'בדיקה ואישור הניפוק' }));
  await user.click(screen.getByRole('button', { name: 'אישור ניפוק' }));
  expect(sent).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'עריכת כמות והערה', hidden: true })).toHaveProperty(
    'disabled',
    true,
  );
  expect(screen.getByRole('button', { name: 'חזרה לעריכה' })).toHaveProperty('disabled', true);
  const navigate = vi.fn();
  expect(guard(navigate)).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  const frozen = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as { key: string };
  finish(
    new Response(
      JSON.stringify({
        outcome: 'committed',
        idempotencyKey: frozen.key,
        replayed: false,
        conflicts: [],
      }),
      { status: 201 },
    ),
  );
  await waitFor(() => expect(localStorage.getItem(storageKey)).toBeNull());
});

it('preserves the original key and payload after idempotency conflict', async () => {
  const sent: Array<{ key: string | null; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    sent.push({
      key: new Headers(init?.headers).get('Idempotency-Key'),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ error: 'idempotency_conflict', message: 'reused' }), {
      status: 409,
    });
  });
  const { user } = mount([item(1, 'סרט')]);
  await user.click(screen.getByRole('button', { name: 'ניפוק' }));
  await user.click(screen.getByRole('button', { name: 'הוספה לעסקה' }));
  await user.click(screen.getByRole('button', { name: 'בדיקה ואישור הניפוק' }));
  await user.click(screen.getByRole('button', { name: 'אישור ניפוק' }));
  expect(screen.getByRole('button', { name: 'עריכת כמות והערה' })).toHaveProperty('disabled', true);
  await user.click(screen.getByRole('button', { name: 'בדיקת הפעולה השמורה' }));
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(localStorage.getItem(storageKey)).not.toBeNull();
});

it('does not commit a canceled review or a discarded draft', async () => {
  const sent = vi.fn();
  vi.stubGlobal('fetch', sent);
  let guard!: LeaveGuard;
  const { user } = mount(
    [item(1, 'סרט')],
    vi.fn(async () => undefined),
    vi.fn(),
    (next) => {
      if (next) guard = next;
    },
  );
  await user.click(screen.getByRole('button', { name: 'ניפוק' }));
  await user.click(screen.getByRole('button', { name: 'הוספה לעסקה' }));
  await user.click(screen.getByRole('button', { name: 'בדיקה ואישור הניפוק' }));
  await user.click(screen.getByRole('button', { name: 'חזרה לעריכה' }));
  const navigate = vi.fn();
  act(() => expect(guard(navigate)).toBe(false));
  await user.click(screen.getByRole('button', { name: 'מחיקת טיוטה' }));
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  expect(sent).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'בדיקה ואישור הניפוק' })).toHaveProperty(
    'disabled',
    true,
  );
});

it('keeps a root quantity or review dialog above navigation until it closes', async () => {
  let guard!: LeaveGuard;
  const showToast = vi.fn();
  const { user } = mount(
    [item(1, 'סרט')],
    vi.fn(async () => undefined),
    showToast,
    (next) => {
      if (next) guard = next;
    },
  );
  const navigate = vi.fn();
  await user.click(screen.getByRole('button', { name: 'ניפוק' }));
  act(() => expect(guard(navigate)).toBe(false));
  expect(screen.queryByRole('alertdialog', { name: 'מחיקת טיוטת ניפוק?' })).toBeNull();
  expect(showToast.mock.lastCall?.[1]).toContain('יש לסגור את חלון');
  await user.click(screen.getByRole('button', { name: 'הוספה לעסקה' }));
  await user.click(screen.getByRole('button', { name: 'בדיקה ואישור הניפוק' }));
  act(() => expect(guard(navigate)).toBe(false));
  expect(screen.queryByRole('alertdialog', { name: 'מחיקת טיוטת ניפוק?' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'חזרה לעריכה' }));
  act(() => expect(guard(navigate)).toBe(false));
  expect(screen.getByRole('alertdialog', { name: 'מחיקת טיוטת ניפוק?' })).toBeTruthy();
  expect(navigate).not.toHaveBeenCalled();
});

it.each(['archived', 'removed'] as const)(
  'clears a %s item selection after stock refresh',
  async (change) => {
    const selected = item(1, 'סרט');
    const showToast = vi.fn();
    let guard!: LeaveGuard;
    const props = {
      ledgerEpoch: 1,
      refresh: vi.fn(async () => undefined),
      showToast,
      registerLeaveGuard: (next: LeaveGuard | null) => {
        if (next) guard = next;
      },
    };
    const { rerender } = render(
      <DialogStackProvider>
        <ConsumablesDesk {...props} items={[selected]} />
      </DialogStackProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'ניפוק' }));
    expect(screen.getByRole('dialog', { name: 'ניפוק סרט' })).toBeTruthy();
    rerender(
      <DialogStackProvider>
        <ConsumablesDesk
          {...props}
          items={change === 'archived' ? [{ ...selected, archived: true }] : []}
        />
      </DialogStackProvider>,
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ניפוק סרט' })).toBeNull());
    expect(showToast.mock.lastCall?.[1]).toContain('הפריט שנבחר אינו זמין עוד');
    expect(guard(vi.fn())).toBe(true);
  },
);

it('cancels browser unload while a draft is staged', async () => {
  const { user } = mount([item(1, 'סרט')]);
  await user.click(screen.getByRole('button', { name: 'ניפוק' }));
  await user.click(screen.getByRole('button', { name: 'הוספה לעסקה' }));
  const unload = new Event('beforeunload', { cancelable: true });
  expect(window.dispatchEvent(unload)).toBe(false);
  expect(unload.defaultPrevented).toBe(true);
});
