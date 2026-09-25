import { useEffect, useState } from 'react';
import type { Radio, RadioFleet } from '../domain/types.js';
import { Dialog } from './Dialog';
import { ApiError, fetchRadios, radioCommand } from './api';
import type { ToastTone } from './Toast';

type Props = {
  active: boolean;
  isAdmin: boolean;
  showToast: (title: string, message: string, tone: ToastTone) => void;
};
type CustodyEdit = {
  radio: Radio;
  generation: number;
  holder: string;
  team: string;
  holderEdited: boolean;
};

export function Radios({ active, isAdmin, showToast }: Props) {
  const [fleet, setFleet] = useState<RadioFleet | null>(null);
  const [edit, setEdit] = useState<CustodyEdit | null>(null);
  const [count, setCount] = useState('');
  const [confirmCount, setConfirmCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadStatus, setLoadStatus] = useState<'loading' | 'failed' | 'ready'>('loading');
  const [loadRevision, setLoadRevision] = useState(0);

  useEffect(() => {
    if (!active) return;
    let live = true;
    setLoadStatus('loading');
    void fetchRadios()
      .then((next) => {
        if (live) {
          setFleet(next);
          setCount(String(next.count));
          setLoadStatus('ready');
        }
      })
      .catch((error) => {
        if (!live) return;
        setLoadStatus('failed');
        showToast(
          'טעינת מכשירי קשר',
          error instanceof Error ? error.message : 'הטעינה נכשלה',
          'error',
        );
      });
    return () => {
      live = false;
    };
  }, [active, showToast, loadRevision]);

  async function mutate(
    path: string,
    method: 'PUT' | 'POST',
    body: object,
    success: string,
    close = false,
  ) {
    setBusy(true);
    try {
      const next = await radioCommand(path, method, body);
      setFleet(next);
      setCount(String(next.count));
      if (close) {
        setEdit(null);
        setConfirmCount(null);
      }
      showToast(success, '', 'success');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'stale_radio_fleet') setEdit(null);
      showToast(
        'עדכון מכשיר קשר נכשל',
        error instanceof Error ? error.message : 'הפעולה נכשלה',
        'error',
      );
      try {
        setFleet(await fetchRadios());
      } catch {
        /* retain the last visible state */
      }
    } finally {
      setBusy(false);
    }
  }

  function submitCount() {
    if (!fleet) return;
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

  return (
    <section dir="rtl" aria-label="מכשירי קשר" className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">מכשירי קשר</h1>
          <p>מיקום ומצב מכשירי הקשר</p>
        </div>
        {isAdmin && fleet && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitCount();
            }}
            className="flex items-end gap-2"
          >
            <label>
              מספר מכשירי קשר{' '}
              <input
                type="number"
                min="0"
                step="1"
                value={count}
                onChange={(event) => setCount(event.target.value)}
                className="block rounded border px-2 py-1"
              />
            </label>
            <button type="submit" disabled={busy} className="secondary-button">
              שמירה
            </button>
          </form>
        )}
      </div>
      {loadStatus === 'failed' && !fleet ? (
        <button
          type="button"
          className="secondary-button"
          onClick={() => setLoadRevision((value) => value + 1)}
        >
          ניסיון טעינה מחדש
        </button>
      ) : !fleet ? (
        <p role="status">טוען מכשירי קשר…</p>
      ) : fleet.count === 0 ? (
        <p>אין מכשירי קשר מוגדרים.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-right">
            <thead>
              <tr>
                <th>מספר</th>
                <th>מחזיק/ה</th>
                <th>צוות</th>
                <th>מצב</th>
                <th>פעולות</th>
              </tr>
            </thead>
            <tbody>
              {fleet.radios.map((radio) => (
                <tr key={radio.number} className="border-t">
                  <td>{radio.number}</td>
                  <td>{radio.holder}</td>
                  <td>{radio.team}</td>
                  <td>{radio.lost ? 'אבוד' : 'תקין'}</td>
                  <td className="space-x-2">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || radio.lost}
                      onClick={() =>
                        setEdit({
                          radio,
                          generation: fleet.generation,
                          holder: radio.holder,
                          team: radio.team,
                          holderEdited: false,
                        })
                      }
                    >
                      עדכון מיקום
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          `/radios/${radio.number}/${radio.lost ? 'found' : 'lost'}`,
                          'POST',
                          { generation: fleet.generation },
                          radio.lost ? 'מכשיר הקשר נמצא' : 'מכשיר הקשר סומן כאבוד',
                        )
                      }
                    >
                      {radio.lost ? 'נמצא' : 'סמן כאבוד'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <Dialog
          title={`עדכון מיקום מכשיר קשר ${edit.radio.number}`}
          level="root"
          role="dialog"
          variant="standard"
          busy={busy}
          dismissible={!busy}
          onClose={() => setEdit(null)}
          actions={
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => setEdit(null)}
              >
                ביטול
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void mutate(
                    `/radios/${edit.radio.number}/return`,
                    'POST',
                    { generation: edit.generation },
                    'מכשיר הקשר הוחזר לצוללת',
                    true,
                  )
                }
              >
                החזרה לצוללת
              </button>
              <button type="submit" form="radio-custody-form" disabled={busy}>
                שמירה
              </button>
            </>
          }
        >
          <form
            id="radio-custody-form"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                `/radios/${edit.radio.number}/custody`,
                'PUT',
                { generation: edit.generation, holder: edit.holder, team: edit.team },
                'מיקום מכשיר הקשר עודכן',
                true,
              );
            }}
            className="space-y-3"
          >
            <label className="block">
              מחזיק/ה
              <input
                className="block w-full rounded border px-2 py-1"
                value={edit.holder}
                onChange={(event) =>
                  setEdit({
                    ...edit,
                    holder: event.target.value,
                    holderEdited: edit.holderEdited || event.target.value !== edit.holder,
                    team: !edit.holderEdited && event.target.value !== edit.holder ? '' : edit.team,
                  })
                }
                required
                maxLength={32767}
              />
            </label>
            <label className="block">
              צוות
              <input
                className="block w-full rounded border px-2 py-1"
                value={edit.team}
                onChange={(event) => setEdit({ ...edit, team: event.target.value })}
                maxLength={32767}
              />
            </label>
          </form>
        </Dialog>
      )}
      {confirmCount !== null && fleet && (
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
                disabled={busy}
                onClick={() => setConfirmCount(null)}
              >
                ביטול
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void mutate(
                    '/radios/count',
                    'PUT',
                    { count: confirmCount, generation: fleet.generation },
                    'מספר מכשירי הקשר עודכן',
                    true,
                  )
                }
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
    </section>
  );
}
