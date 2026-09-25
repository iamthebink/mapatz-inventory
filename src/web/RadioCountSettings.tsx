import { useEffect, useState } from 'react';
import type { RadioFleet } from '../domain/types.js';
import { Dialog } from './Dialog';
import { fetchRadios, radioCommand } from './api';
import type { ToastTone } from './Toast';

type Props = {
  isAdmin: boolean;
  sessionReconciling: boolean;
  showToast: (title: string, message: string, tone: ToastTone) => void;
};

export function RadioCountSettings({ isAdmin, sessionReconciling, showToast }: Props) {
  const [fleet, setFleet] = useState<RadioFleet | null>(null);
  const [count, setCount] = useState('');
  const [confirmCount, setConfirmCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadRevision, setLoadRevision] = useState(0);
  const disabled = !isAdmin || sessionReconciling || busy || !fleet;

  useEffect(() => {
    let live = true;
    setLoading(true);
    void fetchRadios()
      .then((next) => {
        if (!live) return;
        setFleet(next);
        setCount(String(next.count));
      })
      .catch((error) => {
        if (!live) return;
        showToast(
          'טעינת מספר מכשירי הקשר',
          error instanceof Error ? error.message : 'הטעינה נכשלה',
          'error',
        );
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [loadRevision, showToast]);

  useEffect(() => {
    if (!isAdmin) {
      setConfirmCount(null);
      if (fleet) setCount(String(fleet.count));
    }
  }, [isAdmin, fleet]);

  function submitCount() {
    if (disabled || !fleet) return;
    const next = Number(count);
    if (!Number.isSafeInteger(next) || next < 0 || count.trim() === '') {
      showToast('מספר מכשירי קשר לא תקין', 'יש להזין מספר שלם שאינו שלילי', 'error');
      return;
    }
    if (next === fleet.count) {
      showToast('מספר מכשירי הקשר לא השתנה', '', 'success');
      return;
    }
    setConfirmCount(next);
  }

  async function saveCount() {
    if (disabled || !fleet || confirmCount === null) return;
    setBusy(true);
    try {
      const next = await radioCommand('/radios/count', 'PUT', {
        count: confirmCount,
        generation: fleet.generation,
      });
      setFleet(next);
      setCount(String(next.count));
      setConfirmCount(null);
      showToast('מספר מכשירי הקשר עודכן', '', 'success');
    } catch (error) {
      setConfirmCount(null);
      showToast(
        'עדכון מספר מכשירי הקשר נכשל',
        error instanceof Error ? error.message : 'הפעולה נכשלה',
        'error',
      );
      try {
        const next = await fetchRadios();
        setFleet(next);
        setCount(String(next.count));
      } catch {
        setFleet(null);
        setCount('');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="action-card flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="font-semibold">מספר מכשירי הקשר</h3>
          <p className="mt-1 text-sm text-ctp-subtext">שינוי הכמות יגדיר את כל המכשירים מחדש</p>
          {!isAdmin && <p className="mt-1 text-sm text-ctp-subtext">שינוי הכמות דורש מצב מנהל.</p>}
          {loading && <p role="status">טוען מספר מכשירי קשר…</p>}
          {!loading && !fleet && (
            <button
              type="button"
              className="secondary-button mt-2"
              onClick={() => setLoadRevision((value) => value + 1)}
            >
              ניסיון טעינה מחדש
            </button>
          )}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitCount();
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <label className="field-label">
            מספר מכשירי קשר
            <input
              type="number"
              min="0"
              step="1"
              value={count}
              onChange={(event) => setCount(event.target.value)}
              className="input-field w-32"
              disabled={disabled}
            />
          </label>
          <button type="submit" disabled={disabled} className="primary-button">
            שמירה
          </button>
        </form>
      </section>
      {isAdmin && confirmCount !== null && fleet && (
        <Dialog
          title="אישור שינוי מספר מכשירי קשר"
          level="root"
          role="alertdialog"
          variant="destructive"
          busy={busy}
          dismissible={!busy}
          onClose={() => setConfirmCount(null)}
          actions={
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || sessionReconciling}
                onClick={() => setConfirmCount(null)}
              >
                ביטול
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={disabled}
                onClick={() => void saveCount()}
              >
                אישור שינוי
              </button>
            </>
          }
        >
          <p>
            שינוי מספר מכשירי הקשר מ־{fleet.count} ל־{confirmCount} ימחק את כל מיקומי המכשירים
            והסימונים כאבודים. כל המכשירים יוגדרו מחדש בצוללת, ללא צוות וללא סימון כאבוד. להמשיך?
          </p>
        </Dialog>
      )}
    </>
  );
}
