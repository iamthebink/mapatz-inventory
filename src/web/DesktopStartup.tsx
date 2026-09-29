import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { desktop } from './desktop';
import { initializeFrozenAttemptRecovery } from './borrower-workflow-recovery';
import { sendFrozenBorrowerAttempt } from './api';
import { Toast, type ToastMessage } from './Toast';

/** Gate every desktop entry URL, including reload on a non-desk route. */
export function DesktopStartup({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'failed' | 'ready'>(desktop ? 'loading' : 'ready');
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const running = useRef(false);
  const notify = useCallback(
    (message: string) =>
      setToast({ id: Date.now(), title: 'שחזור פעולה', message, tone: 'warning' }),
    [],
  );
  const reconcile = useCallback(async () => {
    if (!desktop || running.current) return;
    running.current = true;
    setState('loading');
    try {
      const result = await initializeFrozenAttemptRecovery(localStorage, sendFrozenBorrowerAttempt);
      setState(result.ready ? 'ready' : 'failed');
      if (!result.ready) notify('לא ניתן לקבוע בוודאות את מצב הפעולה. נסו שוב.');
    } catch {
      setState('failed');
      notify('לא ניתן לקבוע בוודאות את מצב הפעולה. נסו שוב.');
    } finally {
      running.current = false;
    }
  }, [notify]);
  useEffect(() => {
    void reconcile();
  }, [reconcile]);
  useEffect(() => {
    if (state === 'ready') return;
    return desktop?.onCloseRequest(() => notify('יש להשלים שחזור לפני היציאה.'));
  }, [notify, state]);
  if (state === 'ready') return children;
  return (
    <main className="mx-auto max-w-lg p-8" dir="rtl">
      <h1 className="text-2xl font-semibold">שחזור פעולות ממתינות</h1>
      <p className="mt-4">בודקים את הפעולות השמורות לפני פתיחת המלאי.</p>
      {state === 'failed' && (
        <button className="primary-button mt-4" onClick={() => void reconcile()}>
          <RefreshCw className="size-4" aria-hidden="true" />
          נסה שוב
        </button>
      )}
      {toast && <Toast toast={toast} onDismiss={() => setToast(null)} />}
    </main>
  );
}
