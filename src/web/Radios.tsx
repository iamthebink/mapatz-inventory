import { useEffect, useState } from 'react';
import { Radio as RadioIcon } from 'lucide-react';
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

  useEffect(() => {
    if (!isAdmin) {
      setConfirmCount(null);
      if (fleet) setCount(String(fleet.count));
    }
  }, [isAdmin, fleet]);

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
    if (!fleet || !isAdmin || busy) return;
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
    <section dir="rtl" aria-label="מכשירי קשר" className="mx-auto max-w-6xl space-y-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl bg-ctp-lavender/10 text-ctp-lavender">
          <RadioIcon className="size-5" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-2xl font-bold tracking-tight">מכשירי קשר</h2>
          <p className="mt-1 text-sm text-ctp-subtext">מיקום ומצב מכשירי הקשר</p>
        </div>
      </div>
      {fleet && (
        <div className="action-card flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 className="font-semibold">מספר מכשירי הקשר</h3>
            <p className="mt-1 text-sm text-ctp-subtext">שינוי הכמות יגדיר את כל המכשירים מחדש</p>
            {!isAdmin && (
              <p className="mt-1 text-sm text-ctp-subtext">שינוי הכמות דורש מצב מנהל.</p>
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
                disabled={!isAdmin || busy}
              />
            </label>
            <button type="submit" disabled={!isAdmin || busy} className="primary-button">
              שמירה
            </button>
          </form>
        </div>
      )}
      <div className="table-shell">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ctp-surface px-4 py-3">
          <h3 className="font-semibold">רשימת מכשירים</h3>
          {fleet && <span className="text-xs text-ctp-subtext">{fleet.count} מכשירים</span>}
        </div>
        {loadStatus === 'failed' && !fleet ? (
          <div className="grid min-h-32 place-items-center px-4">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setLoadRevision((value) => value + 1)}
            >
              ניסיון טעינה מחדש
            </button>
          </div>
        ) : !fleet ? (
          <p role="status" className="px-4 py-10 text-center text-sm text-ctp-subtext">
            טוען מכשירי קשר…
          </p>
        ) : fleet.count === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-ctp-subtext">אין מכשירי קשר מוגדרים.</p>
        ) : (
          <table className="data-table min-w-[680px]">
            <thead>
              <tr>
                <th scope="col">מספר</th>
                <th scope="col">מחזיק/ה</th>
                <th scope="col">צוות</th>
                <th scope="col">מצב</th>
                <th scope="col">פעולות</th>
              </tr>
            </thead>
            <tbody>
              {fleet.radios.map((radio) => (
                <tr key={radio.number}>
                  <td>
                    <span className="code-pill">{radio.number}</span>
                  </td>
                  <td className="font-medium">{radio.holder}</td>
                  <td className={radio.team ? undefined : 'text-ctp-overlay'}>
                    {radio.team || '—'}
                  </td>
                  <td>
                    <span
                      className={`status-badge ${radio.lost ? 'bg-ctp-red/10 text-ctp-red' : 'green'}`}
                    >
                      {radio.lost ? 'אבוד' : 'תקין'}
                    </span>
                  </td>
                  <td>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="small-button"
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
                        className={`small-button ${radio.lost ? 'text-ctp-green' : 'text-ctp-red'}`}
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
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
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
              <button
                type="submit"
                form="radio-custody-form"
                disabled={busy}
                className="primary-button"
              >
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
            className="dialog-form"
          >
            <div className="dialog-fields">
              <label className="field-label">
                מחזיק/ה
                <input
                  className="input-field"
                  value={edit.holder}
                  onChange={(event) =>
                    setEdit({
                      ...edit,
                      holder: event.target.value,
                      holderEdited: edit.holderEdited || event.target.value !== edit.holder,
                      team:
                        !edit.holderEdited && event.target.value !== edit.holder ? '' : edit.team,
                    })
                  }
                  required
                  maxLength={32767}
                />
              </label>
              <label className="field-label">
                צוות
                <input
                  className="input-field"
                  value={edit.team}
                  onChange={(event) => setEdit({ ...edit, team: event.target.value })}
                  maxLength={32767}
                />
              </label>
            </div>
          </form>
        </Dialog>
      )}
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
                disabled={busy}
                onClick={() => setConfirmCount(null)}
              >
                ביטול
              </button>
              <button
                type="button"
                className="danger-button"
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
