// @vitest-environment jsdom

import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogStackProvider } from '../../src/web/Dialog';

afterEach(() => cleanup());

function Harness({
  pending = false,
  onClose = vi.fn(),
}: {
  pending?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [removeTrigger, setRemoveTrigger] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fallbackRef = useRef<HTMLButtonElement>(null);
  const initialRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <div>
        {!removeTrigger && (
          <button ref={triggerRef} onClick={() => setOpen(true)}>
            פתיחה
          </button>
        )}
        <button ref={fallbackRef}>חזרה בטוחה</button>
      </div>
      {open && (
        <Dialog
          title="בדיקת דיאלוג"
          level="root"
          role="dialog"
          variant="standard"
          busy={pending}
          dismissible={!pending}
          initialFocusRef={initialRef}
          returnFocusFallbackRef={fallbackRef}
          onClose={() => {
            onClose();
            setRemoveTrigger(true);
            setOpen(false);
          }}
        >
          <fieldset disabled={pending}>
            <input ref={initialRef} aria-label="ראשון" />
            <button type="button">אחרון</button>
          </fieldset>
        </Dialog>
      )}
    </>
  );
}

function Scene(props: Parameters<typeof Harness>[0]) {
  return (
    <DialogStackProvider>
      <Harness {...props} />
    </DialogStackProvider>
  );
}

describe('Dialog', () => {
  it('isolates the page, traps focus, and restores an explicit fallback', async () => {
    const user = userEvent.setup();
    render(<Scene />);

    await user.click(screen.getByRole('button', { name: 'פתיחה' }));
    const dialog = screen.getByRole('dialog');
    const background = document.getElementById('app-content')!;
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('ראשון')));
    expect(background.hasAttribute('inert')).toBe(true);
    expect(background.getAttribute('aria-hidden')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');

    screen.getByRole('button', { name: 'אחרון' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'סגירה' }));
    screen.getByRole('button', { name: 'סגירה' }).focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'אחרון' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog.isConnected).toBe(false);
    expect(background.hasAttribute('inert')).toBe(false);
    expect(document.body.style.overflow).toBe('');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'חזרה בטוחה' })),
    );
  });

  it('locks every dismissal path and excludes fieldset-disabled controls while pending', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Scene onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'פתיחה' }));
    rerender(<Scene pending onClose={onClose} />);

    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(dialog.parentElement!, { target: dialog.parentElement });
    await user.tab();
    expect(document.activeElement).toBe(dialog);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBe(dialog);

    rerender(<Scene pending={false} onClose={onClose} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('ראשון')));
    dialog.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'אחרון' }));
  });

  it('does not consume or act on prevented and composing Escape events', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Scene onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'פתיחה' }));

    const prevented = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    prevented.preventDefault();
    document.dispatchEvent(prevented);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }),
    );

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
