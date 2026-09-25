// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Item } from '../../src/domain/types';
import { ConsumableBatchDialog } from '../../src/web/ConsumableBatchDialog';
import { DialogStackProvider } from '../../src/web/Dialog';

const item = (id: number, name: string): Item => ({
  id,
  code: 100 + id,
  name,
  kind: 'consumable',
  aliases: [],
  lotSize: null,
  locationId: null,
  archived: false,
  available: 5,
  damaged: 0,
  borrowed: 0,
  lost: 0,
  stockSnapshot: 1,
});

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
    clear: () => {
      values.clear();
    },
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('ignores a malformed stored attempt key instead of freezing the desk', () => {
  localStorage.setItem(
    'mapatz-consumable-batch-attempt',
    JSON.stringify({
      key: 'not-a-uuid',
      ledgerEpoch: 1,
      items: [{ itemId: 1, quantity: 1, note: '' }],
    }),
  );
  render(
    <DialogStackProvider>
      <ConsumableBatchDialog
        items={[item(1, 'סרט')]}
        ledgerEpoch={1}
        refresh={vi.fn(async () => undefined)}
        showToast={vi.fn()}
      />
    </DialogStackProvider>,
  );
  expect(screen.queryByRole('dialog', { name: 'ניפוק ציוד מתכלה' })).toBeNull();
  expect(screen.getByRole('button', { name: 'ניפוק ציוד מתכלה' })).toBeTruthy();
});

it('restores a frozen attempt after remount and retries its saved key and payload without a current epoch', async () => {
  const key = '00000000-0000-4000-8000-000000000921';
  const frozen = { key, ledgerEpoch: 3, items: [{ itemId: 1, quantity: 2, note: 'saved note' }] };
  localStorage.setItem('mapatz-consumable-batch-attempt', JSON.stringify(frozen));
  const sent = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          outcome: 'committed',
          idempotencyKey: key,
          replayed: true,
          conflicts: [],
        }),
        { status: 201 },
      ),
  );
  const refresh = vi.fn(async () => undefined);
  render(
    <DialogStackProvider>
      <ConsumableBatchDialog
        items={[item(1, 'סרט')]}
        ledgerEpoch={null}
        refresh={refresh}
        showToast={vi.fn()}
      />
    </DialogStackProvider>,
  );
  const dialog = screen.getByRole('dialog', { name: 'ניפוק ציוד מתכלה' });
  expect(within(dialog).getByRole('spinbutton', { name: 'כמות סרט' })).toHaveProperty('value', '2');
  expect(within(dialog).getByRole('textbox', { name: 'הערה סרט' })).toHaveProperty(
    'value',
    'saved note',
  );
  await userEvent.click(within(dialog).getByRole('button', { name: 'בדיקת הפעולה השמורה' }));
  expect(sent).toHaveBeenCalledTimes(1);
  expect(new Headers(sent.mock.calls[0]?.[1]?.headers).get('Idempotency-Key')).toBe(key);
  expect(JSON.parse(String(sent.mock.calls[0]?.[1]?.body))).toEqual({
    ledgerEpoch: 3,
    items: frozen.items,
  });
  expect(refresh).toHaveBeenCalledOnce();
});

it('locks review navigation while the batch submission is in flight', async () => {
  let complete!: (value: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  render(
    <DialogStackProvider>
      <ConsumableBatchDialog
        items={[item(1, 'סרט')]}
        ledgerEpoch={1}
        refresh={vi.fn(async () => undefined)}
        showToast={vi.fn()}
      />
    </DialogStackProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'ניפוק ציוד מתכלה' }));
  const dialog = screen.getByRole('dialog', { name: 'ניפוק ציוד מתכלה' });
  await user.type(within(dialog).getByRole('combobox', { name: 'פריט מתכלה' }), 'סרט');
  await user.click(await screen.findByRole('option', { name: /סרט/ }));
  await user.click(within(dialog).getByRole('button', { name: 'הוספה לרשימה' }));
  await user.click(within(dialog).getByRole('button', { name: 'בדיקה ואישור' }));
  await user.click(screen.getByRole('button', { name: 'אישור ניפוק' }));
  expect(screen.getByRole('button', { name: 'חזרה לעריכה' })).toHaveProperty('disabled', true);
  const key = JSON.parse(localStorage.getItem('mapatz-consumable-batch-attempt') ?? '{}') as {
    key: string;
  };
  complete(
    new Response(
      JSON.stringify({
        outcome: 'committed',
        idempotencyKey: key.key,
        replayed: false,
        conflicts: [],
      }),
      { status: 201 },
    ),
  );
});

it('does not issue when review is canceled and the dirty batch is discarded', async () => {
  const send = vi.fn();
  vi.stubGlobal('fetch', send);
  render(
    <DialogStackProvider>
      <ConsumableBatchDialog
        items={[item(1, 'סרט')]}
        ledgerEpoch={1}
        refresh={vi.fn(async () => undefined)}
        showToast={vi.fn()}
      />
    </DialogStackProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'ניפוק ציוד מתכלה' }));
  const dialog = screen.getByRole('dialog', { name: 'ניפוק ציוד מתכלה' });
  await user.type(within(dialog).getByRole('combobox', { name: 'פריט מתכלה' }), 'סרט');
  await user.click(await screen.findByRole('option', { name: /סרט/ }));
  await user.click(within(dialog).getByRole('button', { name: 'הוספה לרשימה' }));
  await user.click(within(dialog).getByRole('button', { name: 'בדיקה ואישור' }));
  await user.click(screen.getByRole('button', { name: 'חזרה לעריכה' }));
  await user.click(within(dialog).getAllByRole('button', { name: 'סגירה' })[1]!);
  await user.click(screen.getByRole('button', { name: 'מחיקת טיוטה' }));
  expect(send).not.toHaveBeenCalled();
  expect(localStorage.getItem('mapatz-consumable-batch-attempt')).toBeNull();
});

it('retains the same frozen key after an idempotency conflict', async () => {
  const keys: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    keys.push(new Headers(init?.headers).get('Idempotency-Key') ?? '');
    return new Response(JSON.stringify({ error: 'idempotency_conflict', message: 'reused' }), {
      status: 409,
    });
  });
  const showToast = vi.fn();
  render(
    <DialogStackProvider>
      <ConsumableBatchDialog
        items={[item(1, 'סרט')]}
        ledgerEpoch={1}
        refresh={vi.fn(async () => undefined)}
        showToast={showToast}
      />
    </DialogStackProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'ניפוק ציוד מתכלה' }));
  const dialog = screen.getByRole('dialog', { name: 'ניפוק ציוד מתכלה' });
  await user.type(within(dialog).getByRole('combobox', { name: 'פריט מתכלה' }), 'סרט');
  await user.click(await screen.findByRole('option', { name: /סרט/ }));
  await user.click(within(dialog).getByRole('button', { name: 'הוספה לרשימה' }));
  await user.click(within(dialog).getByRole('button', { name: 'בדיקה ואישור' }));
  await user.click(screen.getByRole('button', { name: 'אישור ניפוק' }));
  const frozen = JSON.parse(localStorage.getItem('mapatz-consumable-batch-attempt') ?? '{}') as {
    key: string;
  };
  expect(frozen.key).toBe(keys[0]);
  expect(within(dialog).getByRole('button', { name: 'בדיקת הפעולה השמורה' })).toBeTruthy();
  expect(within(dialog).getByRole('spinbutton', { name: 'כמות סרט' })).toHaveProperty(
    'disabled',
    true,
  );
  await user.click(within(dialog).getByRole('button', { name: 'בדיקת הפעולה השמורה' }));
  expect(keys).toEqual([frozen.key, frozen.key]);
  expect(localStorage.getItem('mapatz-consumable-batch-attempt')).not.toBeNull();
  expect(showToast.mock.lastCall?.[2]).toBe('error');
});

it('submits only the edited, retained batch in one command and reconciles its key after a lost response', async () => {
  const requests: Array<{
    key: string;
    body: { items: Array<{ itemId: number; quantity: number }> };
  }> = [];
  let loseResponse = true;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const key = new Headers(init?.headers).get('Idempotency-Key') ?? '';
    const body = JSON.parse(String(init?.body)) as {
      items: Array<{ itemId: number; quantity: number }>;
    };
    requests.push({ key, body });
    if (loseResponse) {
      loseResponse = false;
      throw new Error('lost response');
    }
    return new Response(
      JSON.stringify({ outcome: 'committed', idempotencyKey: key, replayed: true, conflicts: [] }),
      { status: 201 },
    );
  });
  const refresh = vi.fn(async () => undefined);
  render(
    <DialogStackProvider>
      <ConsumableBatchDialog
        items={[item(1, 'סרט'), item(2, 'אזיקונים')]}
        ledgerEpoch={1}
        refresh={refresh}
        showToast={vi.fn()}
      />
    </DialogStackProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'ניפוק ציוד מתכלה' }));
  const dialog = screen.getByRole('dialog', { name: 'ניפוק ציוד מתכלה' });
  const search = within(dialog).getByRole('combobox', { name: 'פריט מתכלה' });
  await user.type(search, 'סרט');
  await user.click(await screen.findByRole('option', { name: /סרט/ }));
  await user.click(within(dialog).getByRole('button', { name: 'הוספה לרשימה' }));
  await user.type(search, 'אזיקונים');
  await user.click(await screen.findByRole('option', { name: /אזיקונים/ }));
  await user.click(within(dialog).getByRole('button', { name: 'הוספה לרשימה' }));
  await user.clear(within(dialog).getByRole('spinbutton', { name: 'כמות סרט' }));
  await user.type(within(dialog).getByRole('spinbutton', { name: 'כמות סרט' }), '2');
  await user.click(within(dialog).getAllByRole('button', { name: 'הסרה' })[1]!);
  await user.click(within(dialog).getByRole('button', { name: 'בדיקה ואישור' }));
  await user.click(screen.getByRole('button', { name: 'אישור ניפוק' }));
  expect(requests).toHaveLength(1);
  expect(requests[0]?.body.items).toEqual([{ itemId: 1, quantity: 2, note: '' }]);
  await user.click(within(dialog).getByRole('button', { name: 'בדיקת הפעולה השמורה' }));
  expect(requests).toHaveLength(2);
  expect(requests[0]?.key).toBe(requests[1]?.key);
  expect(refresh).toHaveBeenCalledOnce();
});

it('keeps quantity and note editable after an authoritative batch rejection', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const key = new Headers(init?.headers).get('Idempotency-Key');
    return new Response(
      JSON.stringify({
        outcome: 'rejected',
        idempotencyKey: key,
        replayed: false,
        conflicts: [
          { itemId: 1, code: 'insufficient_stock', available: 0 },
          { itemId: 2, code: 'insufficient_stock', available: 1 },
        ],
      }),
      { status: 409 },
    );
  });
  const showToast = vi.fn();
  render(
    <DialogStackProvider>
      <ConsumableBatchDialog
        items={[item(1, 'סרט'), item(2, 'אזיקונים')]}
        ledgerEpoch={1}
        refresh={vi.fn(async () => {
          throw new Error('offline');
        })}
        showToast={showToast}
      />
    </DialogStackProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'ניפוק ציוד מתכלה' }));
  const dialog = screen.getByRole('dialog', { name: 'ניפוק ציוד מתכלה' });
  await user.type(within(dialog).getByRole('combobox', { name: 'פריט מתכלה' }), 'סרט');
  await user.click(await screen.findByRole('option', { name: /סרט/ }));
  await user.type(within(dialog).getByRole('textbox', { name: 'הערה (רשות)' }), 'needed');
  await user.click(within(dialog).getByRole('button', { name: 'הוספה לרשימה' }));
  await user.type(within(dialog).getByRole('combobox', { name: 'פריט מתכלה' }), 'אזיקונים');
  await user.click(await screen.findByRole('option', { name: /אזיקונים/ }));
  await user.click(within(dialog).getByRole('button', { name: 'הוספה לרשימה' }));
  fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'כמות סרט' }), {
    target: { value: '2' },
  });
  await user.click(within(dialog).getByRole('button', { name: 'בדיקה ואישור' }));
  await user.click(screen.getByRole('button', { name: 'אישור ניפוק' }));
  expect(await within(dialog).findByRole('spinbutton', { name: 'כמות סרט' })).toHaveProperty(
    'value',
    '2',
  );
  expect(within(dialog).getByRole('textbox', { name: 'הערה סרט' })).toHaveProperty(
    'value',
    'needed',
  );
  expect(within(dialog).getByRole('button', { name: 'בדיקה ואישור' })).not.toHaveProperty(
    'disabled',
    true,
  );
  expect(showToast.mock.lastCall?.[1]).toContain('סרט: זמין 0');
  expect(showToast.mock.lastCall?.[1]).toContain('אזיקונים: זמין 1');
  expect(showToast.mock.lastCall?.[1]).toContain('רענון המלאי נכשל');
});

it('explains invalid edited quantities and repeated-item totals before review', async () => {
  const showToast = vi.fn();
  render(
    <DialogStackProvider>
      <ConsumableBatchDialog
        items={[item(1, 'סרט')]}
        ledgerEpoch={1}
        refresh={vi.fn(async () => undefined)}
        showToast={showToast}
      />
    </DialogStackProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'ניפוק ציוד מתכלה' }));
  const dialog = screen.getByRole('dialog', { name: 'ניפוק ציוד מתכלה' });
  for (let index = 0; index < 2; index += 1) {
    await user.type(within(dialog).getByRole('combobox', { name: 'פריט מתכלה' }), 'סרט');
    await user.click(await screen.findByRole('option', { name: /סרט/ }));
    await user.click(within(dialog).getByRole('button', { name: 'הוספה לרשימה' }));
  }
  const edit = (value: string) =>
    fireEvent.change(within(dialog).getAllByRole('spinbutton', { name: 'כמות סרט' })[1]!, {
      target: { value },
    });
  for (const value of ['0', '1.5', '5']) {
    edit(value);
    await user.click(within(dialog).getByRole('button', { name: 'בדיקה ואישור' }));
    expect(screen.queryByRole('alertdialog', { name: 'אישור ניפוק' })).toBeNull();
    expect(showToast.mock.lastCall?.[1]).toContain('סרט');
  }
});
