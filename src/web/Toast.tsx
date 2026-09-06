import { CheckCircle2, CircleX, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { useEffect } from 'react';

export type ToastTone = 'success' | 'warning' | 'error';

export type ToastMessage = {
  id: number;
  message: string;
  tone: ToastTone;
};

const toastPresentation: Record<
  ToastTone,
  { icon: LucideIcon; label: string; role: 'status' | 'alert' }
> = {
  success: { icon: CheckCircle2, label: 'הצלחה', role: 'status' },
  warning: { icon: TriangleAlert, label: 'אזהרה', role: 'alert' },
  error: { icon: CircleX, label: 'שגיאה', role: 'alert' },
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

  useEffect(() => {
    if (toast.tone !== 'success') return;
    const timer = window.setTimeout(() => onDismiss(toast.id), 6_000);
    return () => window.clearTimeout(timer);
  }, [onDismiss, toast.id, toast.tone]);

  return (
    <div className="toast-viewport">
      <div className={`toast toast-${toast.tone}`} role={presentation.role} aria-atomic="true">
        <Icon className="toast-icon" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <strong className="block text-xs font-semibold text-ctp-text">
            {presentation.label}
          </strong>
          <span className="mt-0.5 block text-sm text-ctp-text">{toast.message}</span>
        </div>
        <button
          type="button"
          className="icon-button -m-1 shrink-0"
          aria-label="סגירת הודעה"
          onClick={() => onDismiss(toast.id)}
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
