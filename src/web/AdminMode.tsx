import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { forwardRef, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { formatAdminCountdown } from './admin-mode';
import { Dialog } from './Dialog';

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
  const passwordRef = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (error) passwordRef.current?.select();
  }, [error]);

  return (
    <Dialog
      title="הפעלת מצב מנהל"
      description="הזינו את סיסמת המנהל כדי להפעיל הרשאות מנהל."
      level="root"
      role="dialog"
      variant="standard"
      busy={pending}
      dismissible={!pending}
      onClose={onClose}
      initialFocusRef={passwordRef}
      returnFocusRef={returnFocusRef}
      returnFocusFallbackRef={returnFocusRef}
    >
      <div className="dialog-heading-icon">
        <KeyRound className="size-5" />
      </div>
      <form
        className="dialog-form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (!pending) onSubmit(String(new FormData(event.currentTarget).get('password')));
        }}
      >
        <fieldset disabled={pending}>
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
          <div className="dialog-actions">
            <button type="submit" disabled={pending} className="primary-button flex-1">
              הפעל מצב מנהל
            </button>
            <button type="button" className="secondary-button" disabled={pending} onClick={onClose}>
              ביטול
            </button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
