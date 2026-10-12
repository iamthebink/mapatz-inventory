import { useEffect, useRef, useState } from 'react';
import { sendFrozenBorrowerAttempt } from './api';
import {
  dispatchFrozenAttempt,
  initializeFrozenAttemptRecovery,
  resolveFrozenAttempt,
  safeWindowStorage,
  type FrozenOperationAttempt,
} from './borrower-workflow-recovery';
import type { ToastTone } from './Toast';

/** Owns borrower-command durability independently of management-command serialization. */
export function useLostItemRecovery({
  onRefresh,
  onCommitted,
  onRejected,
  showToast,
}: {
  onRefresh: () => Promise<void>;
  onCommitted: () => void;
  onRejected: () => void;
  showToast: (title: string, message: string, tone: ToastTone) => void;
}) {
  const callbacks = useRef({ onRefresh, onCommitted, onRejected, showToast });
  callbacks.current = { onRefresh, onCommitted, onRejected, showToast };
  const [startup, setStartup] = useState(true);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState<FrozenOperationAttempt | null>(null);
  const [refreshOnly, setRefreshOnly] = useState(false);
  const busy = useRef(false);
  const startupPromise = useRef<Promise<void> | null>(null);
  // Persistence failure before transport can safely repeat the same dispatch envelope.
  const retryDispatch = useRef(false);

  async function refresh() {
    setRefreshOnly(true);
    try {
      await callbacks.current.onRefresh();
      callbacks.current.onCommitted();
      setRefreshOnly(false);
      callbacks.current.showToast('המלאי עודכן', 'השינוי נשמר בהצלחה', 'success');
    } catch {
      callbacks.current.showToast('השינוי נשמר', 'רענון הנתונים נכשל. יש לרענן שוב.', 'warning');
    }
  }

  async function initialize() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const storage = safeWindowStorage();
      if (!storage) throw new Error('storage');
      const recovery = await initializeFrozenAttemptRecovery(storage, sendFrozenBorrowerAttempt);
      setStartup(!recovery.ready);
      if (
        recovery.results.some(
          (result) =>
            result.kind === 'definitive' &&
            'outcome' in result.result &&
            result.result.outcome === 'committed',
        )
      )
        await refresh();
      if (
        recovery.results.some(
          (result) =>
            result.kind === 'definitive' &&
            (!('outcome' in result.result) || result.result.outcome !== 'committed'),
        )
      )
        callbacks.current.showToast(
          'הפעולה הקודמת נדחתה',
          'יש לפתוח מחדש את הפעולה ולבדוק את הנתונים לפני שליחה נוספת.',
          'warning',
        );
      if (!recovery.ready)
        callbacks.current.showToast(
          'פעולה קודמת ממתינה לבדיקה',
          'יש לבדוק שוב את אותה פעולה לפני שינוי נוסף. בדוק גם את ההרשאה ואחסון הדפדפן.',
          'warning',
        );
    } catch {
      setStartup(true);
      callbacks.current.showToast(
        'לא ניתן לבדוק פעולות שמורות',
        'בדוק את אחסון הדפדפן ונסה שוב',
        'error',
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  useEffect(() => {
    // A single initialization also under React StrictMode's effect replay.
    startupPromise.current ??= initialize();
    // Initialization uses current callbacks through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send(next: FrozenOperationAttempt, retry = false) {
    if (busy.current || startup || refreshOnly || (attempt && !retry)) return;
    const storage = safeWindowStorage();
    if (!storage) {
      callbacks.current.showToast(
        'לא ניתן לשמור את הפעולה',
        'אחסון הדפדפן אינו זמין כרגע',
        'error',
      );
      return;
    }
    busy.current = true;
    setPending(true);
    setAttempt(next);
    const firstDispatch = !retry || retryDispatch.current;
    try {
      const result = await (firstDispatch ? dispatchFrozenAttempt : resolveFrozenAttempt)(
        storage,
        next,
        sendFrozenBorrowerAttempt,
      );
      retryDispatch.current =
        firstDispatch && result.kind === 'storage-failure' && result.failure.operation === 'write';
      if (!result.cleared) {
        if (retryDispatch.current) {
          callbacks.current.showToast(
            'הפעולה לא נשלחה',
            'לא ניתן לשמור את הפעולה באחסון הדפדפן. יש לנסות שוב את אותה פעולה לפני שינוי נוסף.',
            'error',
          );
          return;
        }
        callbacks.current.showToast(
          'תוצאת הפעולה אינה ידועה',
          'יש לבדוק שוב את אותה פעולה לפני שינוי נוסף. הכמות והיעד נשמרו.',
          'warning',
        );
        return;
      }
      setAttempt(null);
      if (
        result.kind === 'definitive' &&
        'outcome' in result.result &&
        result.result.outcome === 'committed'
      ) {
        await refresh();
      } else {
        try {
          await callbacks.current.onRefresh();
        } catch {
          callbacks.current.showToast(
            'רענון נכשל',
            'יש לבדוק את האפשרויות העדכניות לפני שליחה נוספת',
            'error',
          );
        }
        callbacks.current.onRejected();
        callbacks.current.showToast(
          'הפעולה לא נשמרה',
          result.kind === 'definitive' && 'message' in result.result
            ? result.result.message
            : 'יש לבדוק את ההרשאה ולנסות שוב במפורש',
          'warning',
        );
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function retry() {
    if (busy.current) return;
    if (startup) return initialize();
    if (attempt) return send(attempt, true);
    if (refreshOnly) {
      busy.current = true;
      setPending(true);
      try {
        await refresh();
      } finally {
        busy.current = false;
        setPending(false);
      }
    }
  }
  const locked = startup || pending || attempt !== null || refreshOnly;
  useEffect(() => {
    if (!locked) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [locked]);
  return {
    locked,
    pending,
    startup,
    attempt,
    refreshOnly,
    send,
    retry,
    isBusy: () => busy.current,
  };
}
