// @vitest-environment jsdom

import { createRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdminModeControl,
  AdminModeStatus,
  AdminPasswordDialog,
  AdminRecoveryDialog,
} from '../../src/web/AdminMode';
import { formatAdminCountdown } from '../../src/web/admin-mode';
import { DialogStackProvider } from '../../src/web/Dialog';

afterEach(() => cleanup());

describe('admin mode presentation', () => {
  it('formats the ten-minute countdown without exceeding the configured window', () => {
    expect(formatAdminCountdown(601)).toBe('10:00');
    expect(formatAdminCountdown(600)).toBe('10:00');
    expect(formatAdminCountdown(9.2)).toBe('00:10');
    expect(formatAdminCountdown(-1)).toBe('00:00');
  });

  it('uses one stable action shape with state-specific labels', () => {
    const normal = renderToStaticMarkup(
      <AdminModeControl active={false} disabled={false} onClick={() => undefined} />,
    );
    const active = renderToStaticMarkup(
      <AdminModeControl active disabled={false} onClick={() => undefined} />,
    );

    expect(normal).toContain('class="admin-mode-control "');
    expect(normal).toContain('הפעל מצב מנהל');
    expect(active).toContain('class="admin-mode-control active"');
    expect(active).toContain('סיום מצב מנהל');
    expect(normal.match(/<button/g)).toHaveLength(1);
    expect(active.match(/<button/g)).toHaveLength(1);
  });

  it('exposes active state and countdown as text rather than color alone', () => {
    const markup = renderToStaticMarkup(<AdminModeStatus remaining={522} />);

    expect(markup).toContain('מצב מנהל פעיל');
    expect(markup).toContain('08:42');
    expect(markup).toContain('aria-label="מצב מנהל פעיל. מסתיים בעוד 08:42"');
    expect(markup).toContain('dir="ltr"');
  });

  it('associates wrong-password feedback with the password field', () => {
    render(
      <DialogStackProvider>
        <AdminPasswordDialog
          pending={false}
          error="הסיסמה אינה נכונה."
          returnFocusRef={createRef<HTMLButtonElement>()}
          onClose={() => undefined}
          onSubmit={() => undefined}
        />
      </DialogStackProvider>,
    );
    const markup = document.body.innerHTML;

    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-describedby="admin-password-error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('הסיסמה אינה נכונה.');
  });

  it('prevents dismissing the password dialog while authentication is pending', () => {
    render(
      <DialogStackProvider>
        <AdminPasswordDialog
          pending
          error=""
          returnFocusRef={createRef<HTMLButtonElement>()}
          onClose={() => undefined}
          onSubmit={() => undefined}
        />
      </DialogStackProvider>,
    );
    const markup = document.body.innerHTML;

    expect(markup).toContain('<fieldset disabled="">');
    expect(markup.match(/disabled=""/g)).toHaveLength(4);
  });

  it('ignores Escape and backdrop dismissal while authentication is pending', () => {
    const onClose = vi.fn();
    const returnFocusRef = createRef<HTMLButtonElement>();
    render(
      <DialogStackProvider>
        <button ref={returnFocusRef}>הפעלת מנהל</button>
        <AdminPasswordDialog
          pending
          error=""
          returnFocusRef={returnFocusRef}
          onClose={onClose}
          onSubmit={() => undefined}
        />
      </DialogStackProvider>,
    );

    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBe(dialog);
  });
});

describe('interactive recovery', () => {
  async function setup() {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const onClose = vi.fn();
    const onError = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <DialogStackProvider>
        <button ref={ref}>admin</button>
        <AdminRecoveryDialog returnFocusRef={ref} onClose={onClose} onError={onError} />
      </DialogStackProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'אני אידיוט.ית ושכחתי סיסמה' }));
    await screen.findByRole('textbox', { name: 'בקשה להצגת הסיסמה' });
    const field = screen.getByRole('textbox', { name: 'בקשה להצגת הסיסמה' });
    fireEvent.focus(field);
    expect(field.getAttribute('placeholder')).toBe('פה פה יא חמור.ה');
    fireEvent.change(field, { target: { value: 'ab' } });
    fireEvent.submit(field.closest('form')!);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect((field as HTMLInputElement).value).toBe('');
    expect(field.getAttribute('placeholder')).toBe('פה פה יא חמור.ה');
    expect(screen.queryByTestId('recovery-addition')).toBeNull();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'abc' } });
    expect((field as HTMLInputElement).value).toBe('');
    expect(field.getAttribute('placeholder')).toBe('רגע בעצם פה');
    fireEvent.change(field, { target: { value: 'wrong' } });
    fireEvent.submit(field.closest('form')!);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(field, { target: { value: 'תראי לי את הסיסמה בבקשה' } });
    expect(field.getAttribute('aria-invalid')).toBe('false');
    fireEvent.submit(field.closest('form')!);
    await screen.findByTestId('recovery-addition');
    const addition = screen.getByRole('textbox', { name: 'סכום המספרים' });
    const original = screen.getByTestId('recovery-addition').textContent!;
    fireEvent.change(addition, { target: { value: '2abc' } });
    fireEvent.submit(addition.closest('form')!);
    expect(screen.getByTestId('recovery-addition').textContent).toBe(original);
    for (let version = 0; version < 2; version++) {
      const digits = screen
        .getByTestId('recovery-addition')
        .textContent!.match(/\d+/g)!
        .map(Number);
      fireEvent.change(addition, { target: { value: String(digits[0]! + digits[1]!) } });
      fireEvent.submit(addition.closest('form')!);
      if (version === 0)
        expect(screen.getByTestId('recovery-addition').textContent).not.toBe(original);
    }
    await screen.findByRole('textbox', { name: 'תוצאת האינטגרל' });
    return { onClose, onError };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('removes the subordinate before unmounting recovery and restores admin focus', async () => {
    const ref = createRef<HTMLButtonElement>();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <DialogStackProvider>
          <button ref={ref}>admin</button>
          {open && (
            <AdminRecoveryDialog
              returnFocusRef={ref}
              onClose={() => setOpen(false)}
              onError={() => undefined}
            />
          )}
        </DialogStackProvider>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'יציאה מהשחזור' }));
    fireEvent.click(screen.getByRole('button', { name: 'יציאה' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(ref.current));
  });

  it('completes skip, serializes retrieval, preserves exact text and reports copy failure', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ password: '<secret&value>' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { onClose } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'די כבר, הגזמת' }));
    const reveal = await screen.findByRole('button', { name: 'לחצו כאן להצגת הסיסמה' });
    fireEvent.click(reveal);
    fireEvent.click(reveal);
    await screen.findByText('<secret&value>');
    expect(fetchSpy).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'העתקת הסיסמה' }));
    await screen.findByRole('alert', { name: /לא ניתן להעתיק ללוח/ });
    fireEvent.click(screen.getByRole('button', { name: 'יציאה מהשחזור' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('הסיסמה תוסתר');
    fireEvent.click(screen.getByRole('button', { name: 'להמשיך בשחזור' }));
    expect(screen.getByText('<secret&value>')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'יציאה מהשחזור' })),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'יציאה' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('solves the integral, retries failed retrieval without replay, and copies exactly', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ password: 'exact password' }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { onError } = await setup();
    const math = screen.getByRole('math').textContent!;
    const multiplier = math.match(/([23])x³/)?.[1] ?? '1';
    const field = screen.getByRole('textbox', { name: 'תוצאת האינטגרל' });
    fireEvent.change(field, { target: { value: 'wrong' } });
    fireEvent.submit(field.closest('form')!);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(field, { target: { value: String(Number(multiplier) * 2) } });
    fireEvent.submit(field.closest('form')!);
    fireEvent.submit(field.closest('form')!);
    const retry = await screen.findByRole('button', { name: 'נסו שוב' });
    expect(onError).toHaveBeenCalledOnce();
    fireEvent.click(retry);
    await screen.findByText('exact password');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'העתקת הסיסמה' }));
    await screen.findByRole('status', { name: /הסיסמה הועתקה ללוח/ });
    expect(writeText).toHaveBeenCalledWith('exact password');
  });

  it('defers request completion during confirmation without stealing focus', async () => {
    let resolve!: (response: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const { onClose } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'די כבר, הגזמת' }));
    fireEvent.click(await screen.findByRole('button', { name: 'לחצו כאן להצגת הסיסמה' }));
    fireEvent.click(screen.getByRole('button', { name: 'יציאה מהשחזור' }));
    await act(async () =>
      resolve(
        new Response(JSON.stringify({ password: 'deferred' }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    expect(screen.queryByText('deferred')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'להמשיך בשחזור' }));
    fireEvent.click(screen.getByRole('button', { name: 'להמשיך בשחזור' }));
    await screen.findByText('deferred');
    fireEvent.click(screen.getByRole('button', { name: 'יציאה מהשחזור' }));
    fireEvent.click(screen.getByRole('button', { name: 'יציאה' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
  });
  it.each(['success', 'rejection'])('ignores late %s after confirmed exit', async (outcome) => {
    let resolve!: (response: Response) => void;
    let reject!: (cause: Error) => void;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((done, fail) => {
          resolve = done;
          reject = fail;
        }),
    );
    const { onClose, onError } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'די כבר, הגזמת' }));
    fireEvent.click(await screen.findByRole('button', { name: 'לחצו כאן להצגת הסיסמה' }));
    fireEvent.click(screen.getByRole('button', { name: 'יציאה מהשחזור' }));
    fireEvent.click(screen.getByRole('button', { name: 'יציאה' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
    await act(async () => {
      if (outcome === 'success')
        resolve(
          new Response(JSON.stringify({ password: 'late secret' }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      else reject(new Error('late failure'));
    });
    expect(screen.queryByText('late secret')).toBeNull();
    expect(document.querySelector('.admin-recovery-password')).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(document.querySelector('.toast')).toBeNull();
    expect(screen.queryByRole('button', { name: 'נסו שוב' })).toBeNull();
  });

  it('pauses an ordinary timed transition during confirmation and resumes once', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    try {
      render(
        <DialogStackProvider>
          <AdminRecoveryDialog
            returnFocusRef={createRef<HTMLButtonElement>()}
            onClose={() => undefined}
            onError={() => undefined}
          />
        </DialogStackProvider>,
      );
      const welcome = screen.getByRole('button', { name: 'אני אידיוט.ית ושכחתי סיסמה' });
      fireEvent.click(welcome);
      await act(async () => vi.advanceTimersByTime(100));
      fireEvent.click(screen.getByRole('button', { name: 'יציאה מהשחזור' }));
      await act(async () => vi.advanceTimersByTime(1000));
      expect(screen.queryByRole('textbox', { name: 'בקשה להצגת הסיסמה' })).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'להמשיך בשחזור' }));
      expect(document.querySelector('.dialog-backdrop-recovery')?.hasAttribute('inert')).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'להמשיך בשחזור' }));
      await act(async () => vi.advanceTimersByTime(249));
      expect(screen.queryByRole('textbox', { name: 'בקשה להצגת הסיסמה' })).toBeNull();
      await act(async () => vi.advanceTimersByTime(1));
      expect(screen.getByRole('textbox', { name: 'בקשה להצגת הסיסמה' })).toBeTruthy();
      expect(
        document
          .querySelector('.admin-recovery-content')
          ?.classList.contains('recovery-transition'),
      ).toBe(false);
      expect(document.querySelector('.recovery-text-enter')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
