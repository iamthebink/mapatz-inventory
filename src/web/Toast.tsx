import { CheckCircle2, CircleX, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialogStack } from './Dialog';

export type ToastTone = 'success' | 'warning' | 'error';

export type ToastMessage = {
  id: number;
  title: string;
  message: string;
  tone: ToastTone;
};

const AUTO_DISMISS_MS = 6_000;
const EXIT_FALLBACK_MS = 250;

const toastPresentation: Record<
  ToastTone,
  { icon: LucideIcon; accessibleTone: string; role: 'status' | 'alert' }
> = {
  success: { icon: CheckCircle2, accessibleTone: 'הצלחה', role: 'status' },
  warning: { icon: TriangleAlert, accessibleTone: 'אזהרה', role: 'alert' },
  error: { icon: CircleX, accessibleTone: 'שגיאה', role: 'alert' },
};

export function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: (id: number) => void;
}) {
  const presentation = toastPresentation[toast.tone];
  const Icon = presentation.icon;
  const [exiting, setExiting] = useState(false);
  const { depth } = useDialogStack();
  const modalOpen = depth > 0;

  const requestDismiss = useCallback(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      onDismiss(toast.id);
      return;
    }
    setExiting(true);
  }, [onDismiss, toast.id]);

  useEffect(() => {
    if (toast.tone !== 'success') return;
    const timer = window.setTimeout(requestDismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [requestDismiss, toast.tone]);

  useEffect(() => {
    if (!exiting) return;
    const fallback = window.setTimeout(() => onDismiss(toast.id), EXIT_FALLBACK_MS);
    return () => window.clearTimeout(fallback);
  }, [exiting, onDismiss, toast.id]);

  const host = document.getElementById('toast-root');
  if (!host) throw new Error('Dialog stack invariant violation: #toast-root is missing');

  return createPortal(
    <div className="toast-viewport">
      <div
        className={`toast toast-${toast.tone}${exiting ? ' toast-exiting' : ''}${modalOpen ? ' toast-modal-open' : ''}`}
        role={presentation.role}
        aria-atomic="true"
        aria-label={`${presentation.accessibleTone}: ${toast.title}. ${toast.message}`}
        onAnimationEnd={(event) => {
          if (
            exiting &&
            event.currentTarget === event.target &&
            event.animationName === 'toast-exit'
          ) {
            onDismiss(toast.id);
          }
        }}
      >
        <Icon className="toast-icon" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <strong className="block text-xs font-semibold text-ctp-text">{toast.title}</strong>
          <span className="mt-0.5 block text-sm text-ctp-text">{toast.message}</span>
        </div>
        <button
          type="button"
          className="icon-button -m-1 shrink-0"
          aria-label="סגירת הודעה"
          disabled={exiting || modalOpen}
          tabIndex={modalOpen ? -1 : undefined}
          onClick={requestDismiss}
        >
          <X className="size-4" />
        </button>
      </div>
    </div>,
    host,
  );
}
