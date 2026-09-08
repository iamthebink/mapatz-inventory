// @vitest-environment jsdom

import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminModeControl, AdminModeStatus, AdminPasswordDialog } from '../../src/web/AdminMode';
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
