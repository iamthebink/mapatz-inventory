import { Eye, EyeOff, KeyRound, X } from 'lucide-react';
import { forwardRef, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { formatAdminCountdown } from './admin-mode';

export const AdminModeControl = forwardRef<
  HTMLButtonElement,
  {
    active: boolean;
    disabled: boolean;
    onClick: () => void;
  }
>(function AdminModeControl({ active, disabled, onClick }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`admin-mode-control ${active ? 'active' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      {active ? 'סיום מצב מנהל' : 'הפעל מצב מנהל'}
    </button>
  );
});

export function AdminModeStatus({ remaining }: { remaining: number }) {
  const countdown = formatAdminCountdown(remaining);
  const imminent = remaining <= 10;
  return (
    <div
      className={`admin-mode-status ${imminent ? 'imminent' : ''}`}
      aria-label={`מצב מנהל פעיל. מסתיים בעוד ${countdown}`}
    >
      <span className="admin-mode-marker" aria-hidden="true" />
      <strong className="admin-mode-status-full">מצב מנהל פעיל</strong>
      <strong className="admin-mode-status-compact">מצב מנהל</strong>
      <span aria-hidden="true">·</span>
      <span className="admin-mode-countdown" dir="ltr">
        {countdown}
      </span>
    </div>
  );
}

const focusableSelector =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function AdminPasswordDialog({
  pending,
  error,
  returnFocusRef,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  error: string;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSubmit: (password: string) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(pending);
  const [visible, setVisible] = useState(false);
  pendingRef.current = pending;

  useEffect(() => {
    const returnFocus = returnFocusRef.current;
    passwordRef.current?.focus();
    const dialog = dialogRef.current;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!pendingRef.current) onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      returnFocus?.focus();
    };
  }, [onClose, returnFocusRef]);

  useEffect(() => {
    if (error) passwordRef.current?.select();
  }, [error]);

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (!pending && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-password-title"
        aria-describedby="admin-password-description"
      >
        <button
          type="button"
          className="icon-button absolute top-4 left-4"
          onClick={onClose}
          disabled={pending}
          aria-label="סגירה"
        >
          <X className="size-5" />
        </button>
        <div className="grid size-11 place-items-center rounded-2xl bg-ctp-lavender/10 text-ctp-lavender">
          <KeyRound className="size-5" />
        </div>
        <h2 id="admin-password-title" className="mt-4 text-xl font-bold">
          הפעלת מצב מנהל
        </h2>
        <p id="admin-password-description" className="mt-1 text-sm text-ctp-subtext">
          הזינו את סיסמת המנהל כדי להפעיל הרשאות מנהל.
        </p>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            onSubmit(String(new FormData(event.currentTarget).get('password')));
          }}
        >
          <label className="field-label">
            סיסמה
            <span className="relative">
              <input
                ref={passwordRef}
                className="input-field ps-11"
                required
                name="password"
                type={visible ? 'text' : 'password'}
                autoComplete="current-password"
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={error ? 'admin-password-error' : undefined}
              />
              <button
                type="button"
                className="icon-button absolute top-1/2 left-1.5 -translate-y-1/2"
                onClick={() => setVisible((current) => !current)}
                aria-label={visible ? 'הסתרת סיסמה' : 'הצגת סיסמה'}
              >
                {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </span>
          </label>
          {error && (
            <p id="admin-password-error" className="admin-password-error" role="alert">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className="primary-button flex-1">
              הפעל מצב מנהל
            </button>
            <button type="button" className="secondary-button" disabled={pending} onClick={onClose}>
              ביטול
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
