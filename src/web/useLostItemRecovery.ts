import { useEffect, useRef, useState } from 'react';
import { sendFrozenBorrowerAttempt, fetchBorrowerVerification } from './api';
import {
  dispatchFrozenAttempt,
  initializeFrozenAttemptRecovery,
  resolveFrozenAttempt,
  verifyCommittedAttempt,
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
  const retiredRefresh = useRef(false);

  async function refresh(retired = false) {
    retiredRefresh.current ||= retired;
    setRefreshOnly(true);
    try {
      await callbacks.current.onRefresh();
      callbacks.current.onCommitted();
      setRefreshOnly(false);
      if (retiredRefresh.current)
        callbacks.current.showToast(
          'נתוני השואל השתנו',
          'נתוני המלאי או השואל השתנו. יש לפתוח מחדש את הפעולה.',
          'warning',
        );
      else callbacks.current.showToast('המלאי עודכן', 'השינוי נשמר בהצלחה', 'success');
      retiredRefresh.current = false;
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
      const recovery = await initializeFrozenAttemptRecovery(
        storage,
        sendFrozenBorrowerAttempt,
        fetchBorrowerVerification,
      );
      setStartup(!recovery.ready);
      if (
        recovery.ready &&
        recovery.results.some(
          (result) =>
            result.kind === 'definitive' &&
            'outcome' in result.result &&
            result.result.outcome === 'committed',
        )
      )
        await refresh(
          recovery.results.some(
            (result) => result.kind === 'definitive' && result.verification === 'retired',
          ),
        );
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
      if (
        result.kind === 'definitive' &&
        result.attempt.kind === 'operation' &&
        result.attempt.verification === 'committed'
      ) {
        setAttempt(result.attempt);
        retryDispatch.current = false;
        const verification = await verifyCommittedAttempt(
          storage,
          result.attempt,
          fetchBorrowerVerification,
        );
        if (verification.kind === 'pending') {
          callbacks.current.showToast(
            'השינוי נשמר',
            'יש לאמת את נתוני האמת לפני המשך העבודה.',
            'warning',
          );
          return;
        }
        setAttempt(null);
        await refresh(verification.kind === 'retired');
        return;
      }
      if (!result.cleared) {
        if (retryDispatch.current) {
          callbacks.current.showToast(
            'שמירת נתוני השחזור נכשלה',
            'לא ניתן לאמת את שמירת הפעולה לשחזור. יש לבדוק שוב את אותה פעולה לפני שינוי נוסף.',
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
