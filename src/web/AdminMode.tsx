import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { forwardRef, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import {
  formatAdminCountdown,
  recoveryMercyMs,
  recoveryRemainingMs,
  recoveryStages,
} from './admin-mode';
import { Dialog } from './Dialog';
import { api } from './api';

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
  onRecovery,
}: {
  pending: boolean;
  error: string;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSubmit: (password: string) => void;
  onRecovery?: () => void;
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
          {onRecovery && (
            <button
              type="button"
              className="admin-recovery-link"
              disabled={pending}
              onClick={onRecovery}
            >
              שכחתי את סיסמת המנהל
            </button>
          )}
        </fieldset>
      </form>
    </Dialog>
  );
}

export function AdminRecoveryDialog({
  returnFocusRef,
  onClose,
  onError,
}: {
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const [startedAt] = useState(() => performance.now());
  const [clock, setClock] = useState(() => performance.now());
  const [stage, setStage] = useState(0);
  const [stageEnteredAt, setStageEnteredAt] = useState(startedAt);
  const [penaltyMs, setPenaltyMs] = useState(0);
  const [mercyUntil, setMercyUntil] = useState<number | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const [pending, setPending] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const exitRef = useRef<HTMLButtonElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const wasConfirmingExitRef = useRef(false);
  const confirmExitRef = useRef(false);
  confirmExitRef.current = confirmExit;

  useEffect(() => {
    const timer = window.setInterval(() => setClock(performance.now()), 250);
    return () => {
      window.clearInterval(timer);
      abortRef.current?.abort();
    };
  }, []);

  const elapsed = clock - startedAt;
  const stageData = recoveryStages[stage] ?? recoveryStages[0]!;
  const remaining = recoveryRemainingMs(stage, elapsed, clock - stageEnteredAt, penaltyMs);
  const mercyRemaining = mercyUntil == null ? 0 : Math.max(0, mercyUntil - clock);
  const requestExit = () => setConfirmExit(true);

  useEffect(() => {
    if (!confirmExitRef.current) contentRef.current?.focus();
  }, [stage, mercyUntil, password]);

  useEffect(() => {
    const wasConfirmingExit = wasConfirmingExitRef.current;
    wasConfirmingExitRef.current = confirmExit;
    if (wasConfirmingExit && !confirmExit) {
      const timer = window.setTimeout(() => exitRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [confirmExit]);

  async function advance() {
    if (pending || password !== null || mercyUntil !== null) return;
    const now = performance.now();
    if (recoveryRemainingMs(stage, now - startedAt, now - stageEnteredAt, penaltyMs) > 0) return;
    if (stage < recoveryStages.length - 1) {
      setStageEnteredAt(now);
      setStage(stage + 1);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setPending(true);
    try {
      const response = await api<{ password: string }>('/password/recovery', {
        method: 'POST',
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setPassword(response.password);
    } catch (error) {
      if (!controller.signal.aborted) onError(error);
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return (
    <>
      <Dialog
        title={password === null ? stageData.title : 'הנה היא. בזהירות הפעם.'}
        description="שחזור סיסמת המנהל"
        level="root"
        role="dialog"
        variant="standard"
        busy={pending}
        dismissible
        onClose={requestExit}
        initialFocusRef={contentRef}
        returnFocusRef={returnFocusRef}
        returnFocusFallbackRef={returnFocusRef}
      >
        {password === null ? (
          <div ref={contentRef} className="admin-recovery" tabIndex={-1}>
            <p className="sr-only" role="status">
              {mercyUntil !== null
                ? 'בקשת הרחמים הוסיפה זמן לשחזור.'
                : `${stageData.title}. ${stageData.text}`}
            </p>
            {mercyUntil !== null ? (
              <>
                <p>
                  רחמים? במחסן הזה ״רחמים״ זה שם של מדף ריק. עכשיו נחכה עוד קצת ונחזור בדיוק למקום
                  שבו היינו.
                </p>
                <p className="admin-recovery-timer" aria-live="off">
                  עוד {Math.ceil(mercyRemaining / 1000)} שניות במעצר המחסן
                </p>
                <p className="sr-only" role="status">
                  {mercyRemaining === 0 ? 'אפשר לחזור למסלול.' : ''}
                </p>
                <button
                  ref={nextRef}
                  type="button"
                  className="primary-button"
                  disabled={mercyRemaining > 0}
                  onClick={() => setMercyUntil(null)}
                >
                  חזרה למסלול
                </button>
              </>
            ) : (
              <>
                <p>{stageData.text}</p>
                <p className="admin-recovery-progress">
                  שלב {stage + 1} מתוך {recoveryStages.length}
                </p>
                <p className="admin-recovery-timer" aria-live="off">
                  {remaining > 0
                    ? `עוד ${Math.ceil(remaining / 1000)} שניות לפני השלב הבא`
                    : 'אפשר להמשיך'}
                </p>
                <p className="sr-only" role="status">
                  {remaining === 0 ? 'אפשר להמשיך לשלב הבא.' : ''}
                </p>
                <div className="admin-recovery-actions">
                  <button
                    ref={nextRef}
                    type="button"
                    className="primary-button"
                    disabled={remaining > 0 || pending}
                    onClick={() => void advance()}
                  >
                    {pending ? 'מחפש את הסיסמה…' : stageData.action}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      const now = performance.now();
                      setPenaltyMs((value) => value + recoveryMercyMs);
                      setMercyUntil(now + recoveryMercyMs);
                    }}
                  >
                    רחמים, נמאס לי
                  </button>
                </div>
              </>
            )}
            <button
              ref={exitRef}
              type="button"
              className="admin-recovery-exit"
              onClick={requestExit}
            >
              יציאה מהשחזור
            </button>
          </div>
        ) : (
          <div ref={contentRef} className="admin-recovery" tabIndex={-1}>
            <p className="sr-only" role="status">
              הסיסמה הנוכחית מוצגת כעת.
            </p>
            <p>
              הנה הסיסמה הפשוטה, גאון. כן, זאת. בשביל זה גררת אותנו דרך כל החרא הזה. כדאי לשמור אותה
              במקום בטוח.
            </p>
            <output className="admin-recovery-password" dir="ltr">
              {password}
            </output>
            <button ref={nextRef} type="button" className="primary-button" onClick={requestExit}>
              סגירה
            </button>
            <button
              ref={exitRef}
              type="button"
              className="admin-recovery-exit"
              onClick={requestExit}
            >
              יציאה מהשחזור
            </button>
          </div>
        )}
      </Dialog>
      {confirmExit && (
        <Dialog
          title="יציאה משחזור הסיסמה?"
          description={
            password === null
              ? 'ההתקדמות תאבד. פתיחה מחדש תתחיל מההתחלה.'
              : 'הסיסמה תוסתר. פתיחה מחדש תתחיל מההתחלה.'
          }
          level="subordinate"
          role="alertdialog"
          variant="standard"
          busy={false}
          dismissible
          onClose={() => setConfirmExit(false)}
          initialFocusRef={continueRef}
          returnFocusRef={exitRef}
          returnFocusFallbackRef={exitRef}
        >
          <div className="dialog-actions">
            <button
              ref={continueRef}
              type="button"
              className="secondary-button"
              onClick={() => setConfirmExit(false)}
            >
              להמשיך בשחזור
            </button>
            <button type="button" className="primary-button" onClick={onClose}>
              יציאה
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
