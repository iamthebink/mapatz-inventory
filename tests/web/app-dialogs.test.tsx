// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/App';

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
  holdPath,
  removeLoanAfterReturn = false,
  inventoryItems = [item],
}: {
  failPath?: string;
  holdPath?: string;
  removeLoanAfterReturn?: boolean;
  inventoryItems?: Array<typeof item | typeof campEquipment>;
} = {}) {
  const requests: RecordedRequest[] = [];
  let role: 'operator' | 'admin' = 'admin';
  let loans = [loan];
  let releaseHeld: (() => void) | undefined;
  let holdNextSession = false;
  let releaseSession: (() => void) | undefined;

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
        return response(undefined, 204);
      }
      if (path === '/api/session') {
        if (holdNextSession) {
          holdNextSession = false;
          await new Promise<void>((resolve) => (releaseSession = resolve));
        }
        return response({ role, deadline: role === 'admin' ? Date.now() + 600_000 : null });
      }
      if (path === '/api/items' || path === '/api/items?all=1') return response(inventoryItems);
      if (path === '/api/borrowers' || path === '/api/borrowers?all=1') return response([borrower]);
      if (path === '/api/locations?all=1') return response([location]);
      if (path === '/api/loans') return response(loans);
      if (path === '/api/ledger') return response([]);
      throw new Error(`Unexpected request: ${method} ${path}`);
    }),
  );

  return {
    requests,
    releaseHeld: () => releaseHeld?.(),
    startSessionReconciliation: () => {
      holdNextSession = true;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    releaseSessionReconciliation: () => releaseSession?.(),
    expireAdmin: () => {
      role = 'operator';
      window.dispatchEvent(new Event('mapatz-auth-stale'));
    },
  };
}

async function renderReadyApp() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText('פטיש');
  return user;
}

function bodyOf(request: RecordedRequest): unknown {
  return JSON.parse(String(request.init.body));
}

async function openManagement(user: ReturnType<typeof userEvent.setup>, tabName: string) {
  await user.click(screen.getByRole('button', { name: 'ניהול' }));
  await user.click(screen.getByRole('tab', { name: new RegExp(tabName) }));
}

it('shows camp equipment in inventory and catalog but excludes it from operator actions', async () => {
  installApiMock({ inventoryItems: [item, campEquipment] });
  const user = await renderReadyApp();
  expect(screen.getByText('ציוד מחנה')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'ניפוק והשאלה' }));
  const issue = screen.getByText('ניפוק מתכלה').closest('form')!;
  const checkout = screen.getByText('השאלת ציוד').closest('form')!;
  expect(within(issue).queryByRole('option', { name: /שולחן קבוע/ })).toBeNull();
  expect(within(checkout).queryByRole('option', { name: /שולחן קבוע/ })).toBeNull();

  await openManagement(user, 'פריטים ומיקומים');
  expect(screen.getByRole('option', { name: 'ציוד מחנה' })).toBeTruthy();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App dialog workflows', () => {
  it('validates and submits one atomic return form, then restores a stable fallback', async () => {
    const api = installApiMock({ removeLoanAfterReturn: true });
    const user = await renderReadyApp();
    const returnsTab = screen.getByRole('button', { name: 'החזרות' });
    await user.click(returnsTab);
    const returnTrigger = screen.getByRole('button', { name: 'החזרה' });
    await user.click(returnTrigger);

    const dialog = screen.getByRole('dialog', { name: 'החזרת ציוד' });
    const usable = within(dialog).getByLabelText('כמות תקינה') as HTMLInputElement;
    const damaged = within(dialog).getByLabelText('כמות פגומה');
    const backgrounds = [...document.querySelectorAll<HTMLElement>('[data-dialog-background]')];
    expect(backgrounds).toHaveLength(4);
    for (const background of backgrounds) {
      expect(background.inert).toBe(true);
      expect(background.getAttribute('aria-hidden')).toBe('true');
    }
    await waitFor(() => expect(document.activeElement).toBe(usable));
    await user.keyboard('1');
    expect(usable.value).toBe('1');
    await user.clear(usable);
    await user.type(usable, '2');
    await user.clear(damaged);
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    expect(api.requests.filter((request) => request.path === '/api/return')).toHaveLength(0);
    const fieldset = dialog.querySelector('fieldset')!;
    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toContain('מספרים שלמים');
    expect(fieldset.getAttribute('aria-describedby')).toBe(alert.id);
    expect(fieldset.getAttribute('aria-invalid')).toBe('true');
    await user.type(damaged, '1');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    expect(api.requests.filter((request) => request.path === '/api/return')).toHaveLength(0);
    expect(within(dialog).getByRole('alert').textContent).toContain('בין 1 ל־2');

    await user.clear(usable);
    await user.type(usable, '1');
    await user.type(within(dialog).getByLabelText('הערה (רשות)'), 'תקין');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const request = api.requests.find((entry) => entry.path === '/api/return')!;
    expect(request.init.method).toBe('POST');
    expect(bodyOf(request)).toEqual({ checkoutId: 41, usable: 1, damaged: 1, note: 'תקין' });
    expect(document.activeElement).toBe(returnsTab);
    for (const background of backgrounds) {
      expect(background.inert).toBe(false);
      expect(background.hasAttribute('aria-hidden')).toBe(false);
    }
  });

  it('keeps a failed return available with its values intact', async () => {
    installApiMock({ failPath: '/api/return' });
    const user = await renderReadyApp();
    await user.click(screen.getByRole('button', { name: 'החזרות' }));
    const returnTrigger = screen.getByRole('button', { name: 'החזרה' });
    await user.click(returnTrigger);
    const dialog = screen.getByRole('dialog');
    const note = within(dialog).getByLabelText('הערה (רשות)');
    await user.type(note, 'ניסיון חוזר');
    const save = within(dialog).getByRole('button', { name: 'שמירה' });
    await user.click(save);

    const toastText = await screen.findByText('השרת דחה את הפעולה');
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect((note as HTMLTextAreaElement).value).toBe('ניסיון חוזר');
    await waitFor(() => expect(document.activeElement).toBe(save));
    expect(toastText.closest('[data-dialog-background]')).toBeNull();
    expect(toastText.closest('.toast')?.hasAttribute('inert')).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'ביטול' }));
    expect(document.activeElement).toBe(returnTrigger);
  });

  it('routes mark-lost and unmark-lost through the same bounded typed form', async () => {
    const api = installApiMock();
    const user = await renderReadyApp();
    await user.click(screen.getByRole('button', { name: 'החזרות' }));

    await user.click(screen.getByRole('button', { name: 'סמן אבוד' }));
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'בטל אובדן' }));
    await user.click(screen.getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const lostRequests = api.requests.filter((request) => request.path === '/api/lost');
    expect(lostRequests.map(bodyOf)).toEqual([
      { checkoutId: 41, quantity: 2, lost: true, note: '' },
      { checkoutId: 41, quantity: 1, lost: false, note: '' },
    ]);
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
    const api = installApiMock({ holdPath: '/api/return' });
    const user = await renderReadyApp();
    await user.click(screen.getByRole('button', { name: 'החזרות' }));
    await user.click(screen.getByRole('button', { name: 'החזרה' }));
    const save = screen.getByRole('button', { name: 'שמירה' });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.requests.filter((request) => request.path === '/api/return')).toHaveLength(1),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(screen.getByRole('dialog')).toBeTruthy();

    api.releaseHeld();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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
    const managementTab = screen.getByRole('button', { name: 'ניהול' });
    const input = screen.getByLabelText('בחירת קובץ לייבוא איפוס');
    await user.upload(
      input,
      new File(['reset'], 'reset.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );

    api.expireAdmin();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(managementTab);
  });

  it('blocks representative invalid lost, item, borrower, and location edits inline', async () => {
    const api = installApiMock();
    const user = await renderReadyApp();
    await user.click(screen.getByRole('button', { name: 'החזרות' }));

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
