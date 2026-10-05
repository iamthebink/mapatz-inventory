import type { Location } from './InventoryDialogs';
import { StickyTable } from './StickyTable';
import { useEffect, useRef, useState } from 'react';
import { Check, ClipboardCheck, PackageMinus, RefreshCw, Undo2 } from 'lucide-react';
import type { Item } from '../domain/types';
import { Dialog } from './Dialog';
import { sendConsumableBatchCommand } from './api';
import type { ToastTone } from './Toast';

import {
  clearStoredAttempt,
  storedAttempt,
  storageKey,
  type Attempt,
  type Entry,
} from './consumable-attempt-storage';

const itemCount = (count: number) => (count === 1 ? 'פריט אחד' : `${count} פריטים`);

export function ConsumablesDesk({
  items,
  locations,
  ledgerEpoch,
  refresh,
  showToast,
  registerLeaveGuard,
}: {
  items: Item[];
  locations: Location[];
  ledgerEpoch: number | null;
  refresh: () => Promise<void>;
  showToast: (title: string, message: string, tone: ToastTone) => void;
  registerLeaveGuard?: (guard: ((continueNavigation: () => void) => boolean) | null) => void;
}) {
  const initialAttempt = useRef(storedAttempt());
  const [review, setReview] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [locationId, setLocationId] = useState('');
  const [note, setNote] = useState('');
  const [quantityError, setQuantityError] = useState('');
  const [entries, setEntries] = useState<Entry[]>(initialAttempt.current?.items ?? []);
  const [attempt, setAttempt] = useState<Attempt | null>(initialAttempt.current);
  const [busy, setBusy] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const quantityField = useRef<HTMLInputElement>(null);
  const rowTrigger = useRef<HTMLButtonElement>(null);
  const pendingNavigation = useRef<(() => void) | null>(null);
  const dirty = entries.length > 0 || selectedId !== null;
  useEffect(() => {
    registerLeaveGuard?.((continueNavigation) => {
      if (busy || attempt) {
        showToast(
          'ניפוק ציוד מתכלה',
          'יש לבדוק את תוצאת הפעולה השמורה לפני יציאה מהדלפק.',
          'warning',
        );
        return false;
      }
      if (selectedId !== null || review) {
        showToast(
          'ניפוק ציוד מתכלה',
          'יש לסגור את חלון הפריט או האישור לפני יציאה מהדלפק.',
          'warning',
        );
        return false;
      }
      if (!dirty) return true;
      pendingNavigation.current = continueNavigation;
      setDiscard(true);
      return false;
    });
    return () => registerLeaveGuard?.(null);
  }, [attempt, busy, dirty, registerLeaveGuard, review, selectedId, showToast]);
  useEffect(() => {
    if (!dirty && !attempt && !busy) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [attempt, busy, dirty]);
  const active = items.filter((item) => item.kind === 'consumable' && !item.archived);
  const visible = active.filter((item) =>
    `${item.name} ${item.aliases.join(' ')}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const selected = active.find((item) => item.id === selectedId);
  const totalUnits = entries.reduce((sum, entry) => sum + entry.quantity, 0);
  const itemName = (itemId: number) =>
    items.find((item) => item.id === itemId)?.name ?? 'פריט לא זמין';
  const draftError = (): string | null => {
    if (entries.length === 0) return 'יש להוסיף פריט אחד לפחות.';
    const totals = new Map<string, number>();
    for (const entry of entries) {
      const item = active.find((candidate) => candidate.id === entry.itemId);
      if (!item) return `${itemName(entry.itemId)}: הפריט אינו זמין עוד.`;
      if (!Number.isSafeInteger(entry.quantity) || entry.quantity < 1)
        return `${item.name}: יש להזין כמות חיובית ושלמה.`;
      const key = JSON.stringify([entry.itemId, entry.locationId]);
      if (!locations.some((l) => l.id === entry.locationId && !l.archived))
        return 'יש לבחור מיקום פעיל';
      const available =
        item.balances.find((p) => p.locationId === entry.locationId)?.available ?? 0;
      const total = (totals.get(key) ?? 0) + entry.quantity;
      if (!Number.isSafeInteger(total) || total > available)
        return `${item.name}: ניתן לנפק עד ${available} יחידות במיקום שנבחר.`;
      totals.set(key, total);
    }
    return null;
  };
  const reviewDraft = () => {
    const error = draftError();
    if (error) {
      showToast('ניפוק ציוד מתכלה', error, 'warning');
      return;
    }
    setReview(true);
  };
  const clear = () => {
    clearStoredAttempt();
    setAttempt(null);
    setEntries([]);
    setQuery('');
    setSelectedId(null);
    setQuantity('1');
    setNote('');
    setReview(false);
    setDiscard(false);
    setQuantityError('');
    pendingNavigation.current = null;
  };
  const discardDraft = () => {
    const next = pendingNavigation.current;
    setDiscard(false);
    window.setTimeout(() => {
      clear();
      if (next) queueMicrotask(next);
    }, 0);
  };
  const closeQuantity = () => {
    setSelectedId(null);
    setQuantity('1');
    setNote('');
    setQuantityError('');
  };
  useEffect(() => {
    if (
      selectedId === null ||
      items.some((item) => item.id === selectedId && item.kind === 'consumable' && !item.archived)
    )
      return;
    setSelectedId(null);
    setQuantity('1');
    setNote('');
    setQuantityError('');
    showToast('ניפוק ציוד מתכלה', 'הפריט שנבחר אינו זמין עוד. יש לבחור פריט אחר.', 'warning');
  }, [items, selectedId, showToast]);
  const openQuantity = (item: Item, trigger: HTMLButtonElement) => {
    rowTrigger.current = trigger;
    setSelectedId(item.id);
    const defaultLocation = locations.find(
      (l) =>
        l.isDefault &&
        !l.archived &&
        (item.balances.find((p) => p.locationId === l.id)?.available ?? 0) -
          entries
            .filter((entry) => entry.itemId === item.id && entry.locationId === l.id)
            .reduce((sum, entry) => sum + entry.quantity, 0) >
          0,
    );
    setLocationId(defaultLocation?.id.toString() ?? '');
    setQuantity('1');
    setNote('');
    setQuantityError('');
  };
  const stageQuantity = () => {
    const amount = Number(quantity);
    const item = active.find((candidate) => candidate.id === selectedId);
    const already = entries.reduce(
      (sum, entry) =>
        sum +
        (entry.itemId === selectedId && entry.locationId === Number(locationId)
          ? entry.quantity
          : 0),
      0,
    );
    const available =
      item?.balances.find((p) => p.locationId === Number(locationId))?.available ?? 0;
    if (
      !locations.some((l) => l.id === Number(locationId) && !l.archived) ||
      !item ||
      !/^\d+$/.test(quantity) ||
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      !Number.isSafeInteger(already + amount) ||
      already + amount > available
    ) {
      setQuantityError(
        item
          ? `${item.name}: יש להזין כמות חיובית ושלמה עד ${Math.max(0, available - already)}.`
          : 'יש לבחור פריט מהרשימה.',
      );
      queueMicrotask(() => quantityField.current?.focus());
      return;
    }
    const next: Entry = { itemId: item.id, locationId: Number(locationId), quantity: amount, note };
    setEntries((current) => [...current, next]);
    closeQuantity();
  };
  const submit = async () => {
    if (busy) return;
    if (!attempt) {
      const error = draftError();
      if (error) {
        showToast('ניפוק ציוד מתכלה', error, 'warning');
        return;
      }
    }
    const command =
      attempt ??
      (ledgerEpoch === null ? null : { key: crypto.randomUUID(), ledgerEpoch, items: entries });
    if (!command) return;
    if (!attempt) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(command));
      } catch {
        showToast('ניפוק ציוד מתכלה', 'לא ניתן לשמור את הפעולה לשחזור.', 'error');
        return;
      }
      setAttempt(command);
    }
    setBusy(true);
    try {
      const classification = await sendConsumableBatchCommand({
        idempotencyKey: command.key,
        request: { ledgerEpoch: command.ledgerEpoch, items: command.items },
      });
      if (classification.kind === 'authorization') {
        setReview(false);
        showToast('ניפוק ציוד מתכלה', 'נדרש אימות מחדש לפני בדיקת הפעולה', 'warning');
        return;
      }
      if (classification.kind === 'key-conflict') {
        setReview(false);
        showToast(
          'ניפוק ציוד מתכלה',
          'מפתח הפעולה כבר שימש לפעולה אחרת. תוצאת הניפוק אינה מוכחת; יש לבדוק את הפעולה השמורה לפני ניסיון חדש.',
          'error',
        );
        return;
      }
      if (classification.kind === 'stale' || classification.kind === 'protocol-rejected') {
        clearStoredAttempt();
        setAttempt(null);
        setReview(false);
        let refreshFailed = false;
        try {
          await refresh();
        } catch {
          refreshFailed = true;
        }
        showToast(
          'ניפוק ציוד מתכלה',
          (classification.kind === 'stale'
            ? 'המלאי הוחלף. יש לבדוק את הרשימה מחדש.'
            : 'הבקשה נדחתה. יש לבדוק ולתקן את הרשימה.') +
            (refreshFailed ? ' רענון המלאי נכשל.' : ''),
          'warning',
        );
        return;
      }
      if (
        classification.kind === 'definitive' &&
        'outcome' in classification.result &&
        (classification.result.outcome === 'committed' ||
          classification.result.outcome === 'rejected')
      ) {
        if (classification.result.outcome === 'committed') {
          clear();
          showToast('ניפוק ציוד מתכלה', 'הניפוק נשמר', 'success');
          try {
            await refresh();
          } catch {
            showToast('ניפוק ציוד מתכלה', 'הניפוק נשמר, אך רענון המלאי נכשל.', 'warning');
          }
          return;
        }
        const conflicts = classification.result.conflicts
          .map(
            (conflict) =>
              `${itemName(conflict.itemId)}: ${conflict.available === undefined ? 'לא זמין' : `זמין ${conflict.available}`}`,
          )
          .join('; ');
        clearStoredAttempt();
        setAttempt(null);
        setReview(false);
        let refreshFailed = false;
        try {
          await refresh();
        } catch {
          refreshFailed = true;
        }
        showToast(
          'ניפוק ציוד מתכלה',
          `${conflicts}. יש לתקן את הרשימה.${refreshFailed ? ' רענון המלאי נכשל.' : ''}`,
          'warning',
        );
        return;
      }
      throw new Error('Uncertain command result');
    } catch {
      setReview(false);
      showToast(
        'ניפוק ציוד מתכלה',
        'תוצאת הפעולה אינה ידועה. יש לבדוק שוב את אותה פעולה.',
        'warning',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="consumables-desk" aria-labelledby="consumables-desk-title" dir="rtl">
        <div className="consumables-desk-heading">
          <div>
            <h2 id="consumables-desk-title">ציוד מתכלה</h2>
            <p>בחירת פריטים לניפוק ללא שיוך לשואל</p>
          </div>
        </div>
        <div className="consumables-desk-layout">
          <div className="consumables-stock action-card">
            <div className="consumables-card-heading">
              <h3>ציוד מתכלה זמין</h3>
              <span>{itemCount(visible.length)}</span>
            </div>
            <div className="consumables-stock-search">
              <label className="field-label" htmlFor="consumables-search">
                חיפוש ציוד מתכלה
              </label>
              <input
                ref={search}
                id="consumables-search"
                className="input-field"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="שם או שם נוסף"
              />
            </div>
            <div className="table-shell consumables-table-scroll">
              <StickyTable className="consumables-table">
                <thead>
                  <tr>
                    <th scope="col">פריט</th>
                    <th scope="col">זמין</th>
                    <th scope="col">פעולה</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => (
                    <tr key={item.id}>
                      <th scope="row">
                        <strong>{item.name}</strong>
                      </th>
                      <td className="consumables-available">{item.available}</td>
                      <td>
                        <button
                          type="button"
                          className="small-button"
                          disabled={item.available < 1 || busy || Boolean(attempt)}
                          onClick={(event) => openQuantity(item, event.currentTarget)}
                        >
                          <PackageMinus className="size-3.5" aria-hidden="true" />
                          ניפוק
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </StickyTable>
            </div>
            {visible.length === 0 && (
              <p className="consumables-empty">
                {active.length === 0
                  ? 'אין ציוד מתכלה זמין לתצוגה.'
                  : 'לא נמצאו פריטים המתאימים לחיפוש.'}
              </p>
            )}
          </div>
          <div className="consumables-pending action-card">
            <div className="consumables-card-heading">
              <div>
                <h3>פעולה בהכנה</h3>
                <p>
                  {attempt
                    ? 'הפעולה נשלחה. יש לבדוק את תוצאתה השמורה לפני המשך העבודה.'
                    : 'הכמויות במלאי לא משתנות עד האישור הסופי.'}
                </p>
              </div>
              <span className="consumables-count-badge">{itemCount(entries.length)}</span>
            </div>
            {entries.length === 0 ? (
              <p className="consumables-empty">בחרו פריטים מהטבלה כדי להכין ניפוק.</p>
            ) : (
              <ul className="consumables-draft-list">
                {entries.map((entry, index) => (
                  <li className="consumables-draft-item" key={index}>
                    <div className="consumables-draft-top">
                      <div>
                        <strong>{itemName(entry.itemId)}</strong>
                        <small>
                          {locations.find((l) => l.id === entry.locationId)?.name ??
                            'מיקום לא זמין'}
                        </small>
                        {entry.note && <small>{entry.note}</small>}
                      </div>
                      <span className="consumables-quantity-chip">× {entry.quantity}</span>
                    </div>
                    <div className="consumables-draft-actions">
                      <button
                        type="button"
                        className="small-button"
                        disabled={busy || Boolean(attempt)}
                        onClick={() => {
                          setEntries((current) =>
                            current.filter((_, position) => position !== index),
                          );
                          queueMicrotask(() => search.current?.focus());
                        }}
                      >
                        <Undo2 className="size-3.5" aria-hidden="true" />
                        ביטול פעולה
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="consumables-pending-footer">
              <p>
                <span>סך יחידות לניפוק</span>
                <strong>{totalUnits}</strong>
              </p>
              <button
                type="button"
                className="primary-button"
                disabled={busy || entries.length === 0}
                onClick={() => (attempt ? void submit() : reviewDraft())}
              >
                {attempt ? (
                  <RefreshCw className="size-4" aria-hidden="true" />
                ) : (
                  <ClipboardCheck className="size-4" aria-hidden="true" />
                )}
                {attempt ? 'בדיקת הפעולה השמורה' : 'בדיקה ואישור הניפוק'}
              </button>
              <small>האישור הסופי יוצג בחלון נפרד, כמו בכרטיס שואל.</small>
            </div>
          </div>
        </div>
      </section>
      {selected && (
        <Dialog
          title={`ניפוק ${selected.name}`}
          description={
            <span className="quantity-dialog-item">
              <span className="quantity-dialog-item-label">פריט: </span>
              <strong className="quantity-dialog-item-name">
                <bdi>{selected.name}</bdi>
              </strong>
            </span>
          }
          level="root"
          role="dialog"
          variant="standard"
          busy={false}
          dismissible
          onClose={closeQuantity}
          returnFocusRef={rowTrigger}
          initialFocusRef={quantityField}
          actions={
            <>
              <button type="button" className="secondary-button" onClick={closeQuantity}>
                ביטול
              </button>
              <button type="button" className="primary-button" onClick={stageQuantity}>
                הוספה לעסקה
              </button>
            </>
          }
        >
          <div className="dialog-form" dir="rtl">
            <p>
              <strong>{selected.name}</strong> · זמין {selected.available}
            </p>
            <label className="field-label">
              מיקום מקור
              <select
                className="input-field"
                value={locationId}
                onChange={(event) => {
                  setLocationId(event.target.value);
                  setQuantityError('');
                }}
              >
                <option value="">בחרו מיקום</option>
                {locations
                  .filter(
                    (l) =>
                      !l.archived &&
                      (selected.balances.find((p) => p.locationId === l.id)?.available ?? 0) > 0,
                  )
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} · זמין{' '}
                      {selected.balances.find((p) => p.locationId === l.id)?.available ?? 0}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field-label">
              כמות
              <input
                ref={quantityField}
                className="input-field"
                type="number"
                min="1"
                step="1"
                value={quantity}
                aria-invalid={Boolean(quantityError)}
                aria-describedby={quantityError ? 'consumables-quantity-error' : undefined}
                onChange={(event) => {
                  setQuantity(event.target.value);
                  setQuantityError('');
                }}
              />
            </label>
            {quantityError && (
              <p id="consumables-quantity-error" className="field-error" role="alert">
                {quantityError}
              </p>
            )}
            <label className="field-label">
              הערה (רשות)
              <input
                className="input-field"
                maxLength={500}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
          </div>
        </Dialog>
      )}
      {review && (
        <Dialog
          title="אישור ניפוק"
          level="root"
          role="alertdialog"
          variant="standard"
          busy={busy}
          dismissible={!busy}
          onClose={() => setReview(false)}
          actions={
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => setReview(false)}
              >
                <Undo2 className="size-4" aria-hidden="true" />
                חזרה לעריכה
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={
                  busy ||
                  entries.some(
                    (entry) => !Number.isSafeInteger(entry.quantity) || entry.quantity < 1,
                  ) ||
                  entries.some(
                    (entry) =>
                      entries
                        .filter(
                          (row) =>
                            row.itemId === entry.itemId && row.locationId === entry.locationId,
                        )
                        .reduce((sum, row) => sum + row.quantity, 0) >
                      (active
                        .find((item) => item.id === entry.itemId)
                        ?.balances.find((p) => p.locationId === entry.locationId)?.available ?? 0),
                  )
                }
                onClick={() => void submit()}
              >
                <Check className="size-4" aria-hidden="true" />
                אישור ניפוק
              </button>
            </>
          }
        >
          <div className="borrower-review-list">
            {entries.map((entry, index) => (
              <p key={index}>
                {itemName(entry.itemId)} · {locations.find((l) => l.id === entry.locationId)?.name}{' '}
                · כמות {entry.quantity}
                {entry.note && ` · ${entry.note}`}
              </p>
            ))}
            <p>
              <strong>סך יחידות לניפוק: {totalUnits}</strong>
            </p>
          </div>
        </Dialog>
      )}
      {discard && (
        <Dialog
          title="מחיקת טיוטת ניפוק?"
          level="root"
          role="alertdialog"
          variant="destructive"
          busy={false}
          dismissible
          onClose={() => {
            pendingNavigation.current = null;
            setDiscard(false);
          }}
          actions={
            <>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  pendingNavigation.current = null;
                  setDiscard(false);
                }}
              >
                להמשיך לערוך
              </button>
              <button type="button" className="danger-button" onClick={discardDraft}>
                מחיקת טיוטה
              </button>
            </>
          }
        >
          <p>הפריטים ברשימה טרם נופקו.</p>
        </Dialog>
      )}
    </>
  );
}
