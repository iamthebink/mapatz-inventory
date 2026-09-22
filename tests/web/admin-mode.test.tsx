// @vitest-environment jsdom

import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdminModeControl,
  AdminModeStatus,
  AdminPasswordDialog,
  AdminRecoveryDialog,
} from '../../src/web/AdminMode';
import { formatAdminCountdown, recoveryRemainingMs } from '../../src/web/admin-mode';
import { DialogStackProvider } from '../../src/web/Dialog';

afterEach(() => cleanup());

describe('admin mode presentation', () => {
  it('requires each five-second gate and the full twenty seconds, with mercy adding time', () => {
    expect(recoveryRemainingMs(0, 19_000, 4_999, 0)).toBe(1);
    expect(recoveryRemainingMs(1, 19_000, 5_000, 0)).toBe(0);
    expect(recoveryRemainingMs(3, 19_000, 5_000, 0)).toBe(1_000);
    expect(recoveryRemainingMs(3, 20_000, 5_000, 8_000)).toBe(8_000);
  });

  it('confirms exit neutrally and keeps the current stage when continuing', async () => {
    const onClose = vi.fn();
    render(
      <DialogStackProvider>
        <AdminRecoveryDialog
          returnFocusRef={createRef<HTMLButtonElement>()}
          onClose={onClose}
          onError={() => undefined}
        />
      </DialogStackProvider>,
    );
    expect(screen.getByText('שלב 1 מתוך 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'יציאה מהשחזור' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('ההתקדמות תאבד');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'להמשיך בשחזור' }));
    fireEvent.click(screen.getByRole('button', { name: 'להמשיך בשחזור' }));
    expect(screen.getByText('שלב 1 מתוך 4')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'יציאה מהשחזור' })),
    );
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'יציאה' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('runs the fixed gates, makes mercy longer, and renders the exact password as text', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ password: '<secret&value>' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
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
      expect(screen.getByRole('button', { name: 'כן, עשיתי את זה' }).hasAttribute('disabled')).toBe(
        true,
      );
      await act(async () => vi.advanceTimersByTime(5_000));
      fireEvent.click(screen.getByRole('button', { name: 'כן, עשיתי את זה' }));
      expect(screen.getByText('שלב 2 מתוך 4')).toBeTruthy();
      expect(document.activeElement?.classList.contains('admin-recovery')).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'רחמים, נמאס לי' }));
      expect(screen.getByText(/״רחמים״ זה שם של מדף ריק/)).toBeTruthy();
      await act(async () => vi.advanceTimersByTime(8_000));
      fireEvent.click(screen.getByRole('button', { name: 'חזרה למסלול' }));
      fireEvent.click(screen.getByRole('button', { name: 'להמשיך בהשפלה' }));
      expect(screen.getByText('שלב 3 מתוך 4')).toBeTruthy();
      await act(async () => vi.advanceTimersByTime(5_000));
      fireEvent.click(screen.getByRole('button', { name: 'זה אני, לעזאזל' }));
      await act(async () => vi.advanceTimersByTime(5_000));
      expect(screen.getByRole('button', { name: 'יאללה, תראה לי' }).hasAttribute('disabled')).toBe(
        true,
      );
      await act(async () => vi.advanceTimersByTime(5_000));
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'יאללה, תראה לי' })),
      );
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(screen.getByText('<secret&value>').tagName).toBe('OUTPUT');
      expect(document.body.innerHTML).toContain('&lt;secret&amp;value&gt;');
      fireEvent.click(screen.getByText('סגירה'));
      expect(screen.getByRole('alertdialog').textContent).toContain('הסיסמה תוסתר');
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });
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
