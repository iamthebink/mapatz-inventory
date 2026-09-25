import { useEffect, useRef, useState } from 'react';
import type { Item } from '../domain/types';
import { ActiveDescendantCombobox } from './ActiveDescendantCombobox';
import { Dialog } from './Dialog';
import { sendConsumableBatchCommand } from './api';
import { isCommandUuid } from './borrower-workflow-recovery';
import type { ToastTone } from './Toast';

type Entry = { itemId: number; quantity: number; note: string };
type Attempt = { key: string; ledgerEpoch: number; items: Entry[] };
const storageKey = 'mapatz-consumable-batch-attempt';
function clearStoredAttempt() {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    /* Storage may be unavailable. */
  }
}

function storedAttempt(): Attempt | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const attempt = value as Partial<Attempt>;
    if (
      !isCommandUuid(attempt.key) ||
      !Number.isSafeInteger(attempt.ledgerEpoch) ||
      Number(attempt.ledgerEpoch) < 1 ||
      !Array.isArray(attempt.items) ||
      !attempt.items.length
    )
      return null;
    if (
      !attempt.items.every(
        (item) =>
          Number.isSafeInteger(item.itemId) &&
          item.itemId > 0 &&
          Number.isSafeInteger(item.quantity) &&
          item.quantity > 0 &&
          typeof item.note === 'string' &&
          item.note.length <= 500,
      )
    )
      return null;
    return attempt as Attempt;
  } catch {
    return null;
  }
}

export function ConsumableBatchDialog({
  items,
  ledgerEpoch,
  refresh,
  showToast,
  registerLeaveGuard,
}: {
  items: Item[];
  ledgerEpoch: number | null;
  refresh: () => Promise<void>;
  showToast: (title: string, message: string, tone: ToastTone) => void;
  registerLeaveGuard?: (guard: ((continueNavigation: () => void) => boolean) | null) => void;
}) {
  const initialAttempt = useRef(storedAttempt());
  const [open, setOpen] = useState(Boolean(initialAttempt.current));
  const [review, setReview] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [note, setNote] = useState('');
  const [entries, setEntries] = useState<Entry[]>(initialAttempt.current?.items ?? []);
  const [attempt, setAttempt] = useState<Attempt | null>(initialAttempt.current);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const pendingNavigation = useRef<(() => void) | null>(null);
  const dirty = entries.length > 0 || query.length > 0 || note.length > 0 || quantity !== '1';
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
      if (!dirty) return true;
      pendingNavigation.current = continueNavigation;
      setDiscard(true);
      return false;
    });
    return () => registerLeaveGuard?.(null);
  }, [attempt, busy, dirty, registerLeaveGuard, showToast]);
  const active = items.filter((item) => item.kind === 'consumable' && !item.archived);
  const itemName = (itemId: number) =>
    items.find((item) => item.id === itemId)?.name ?? `#${itemId}`;
  const draftError = (): string | null => {
    if (entries.length === 0) return 'יש להוסיף פריט אחד לפחות.';
    const totals = new Map<number, number>();
    for (const entry of entries) {
      const item = active.find((candidate) => candidate.id === entry.itemId);
      if (!item) return `${itemName(entry.itemId)}: הפריט אינו זמין עוד.`;
      if (!Number.isSafeInteger(entry.quantity) || entry.quantity < 1)
        return `${item.name}: יש להזין כמות חיובית ושלמה.`;
      const total = (totals.get(entry.itemId) ?? 0) + entry.quantity;
      if (!Number.isSafeInteger(total) || total > item.available)
        return `${item.name}: ניתן לנפק עד ${item.available} יחידות בסך הכול.`;
      totals.set(entry.itemId, total);
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
    setOpen(false);
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
  const close = () => {
    if (busy || attempt) return;
    if (dirty) setDiscard(true);
    else setOpen(false);
  };
  const add = () => {
    const amount = Number(quantity);
    const item = active.find((candidate) => candidate.id === selectedId);
    const already = entries
      .filter((entry) => entry.itemId === selectedId)
      .reduce((sum, entry) => sum + entry.quantity, 0);
    if (
      !item ||
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      !Number.isSafeInteger(already + amount) ||
      already + amount > item.available
    ) {
      showToast(
        'ניפוק ציוד מתכלה',
        item
          ? `${item.name}: יש להזין כמות חיובית עד ${Math.max(0, item.available - already)}`
          : 'יש לבחור פריט מהרשימה',
        'warning',
      );
      return;
    }
    setEntries((current) => [...current, { itemId: item.id, quantity: amount, note }]);
    setSelectedId(null);
    setQuery('');
    setQuantity('1');
    setNote('');
    queueMicrotask(() => search.current?.focus());
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
      <button ref={trigger} type="button" className="primary-button" onClick={() => setOpen(true)}>
        ניפוק ציוד מתכלה
      </button>
      {open && (
        <Dialog
          title="ניפוק ציוד מתכלה"
          level="root"
          role="dialog"
          variant="standard"
          busy={busy}
          dismissible={!busy && !attempt}
          onClose={close}
          returnFocusRef={trigger}
          initialFocusRef={search}
          actions={
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || Boolean(attempt)}
                onClick={close}
              >
                סגירה
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy || entries.length === 0}
                onClick={() => (attempt ? void submit() : reviewDraft())}
              >
                {attempt ? 'בדיקת הפעולה השמורה' : 'בדיקה ואישור'}
              </button>
            </>
          }
        >
          <div className="dialog-form consumable-batch-dialog" dir="rtl">
            <ActiveDescendantCombobox
              label="פריט מתכלה"
              value={query}
              onChange={(value) => {
                setQuery(value);
                setSelectedId(null);
              }}
              onSelect={(item) => {
                setSelectedId(item.id);
                setQuery(item.name);
              }}
              options={active
                .filter((item) =>
                  `${item.code} ${item.name} ${item.aliases.join(' ')}`
                    .toLocaleLowerCase()
                    .includes(query.toLocaleLowerCase()),
                )
                .map((item) => ({
                  id: `batch-item-${item.id}`,
                  value: item,
                  label: item.name,
                  description: `זמין: ${item.available}`,
                }))}
              inputRef={search}
              disabled={busy || Boolean(attempt)}
              openOnFocus
            />
            <label className="field-label">
              כמות
              <input
                className="input-field"
                type="number"
                min="1"
                step="1"
                value={quantity}
                disabled={busy || Boolean(attempt)}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </label>
            <label className="field-label">
              הערה (רשות)
              <input
                className="input-field"
                maxLength={500}
                value={note}
                disabled={busy || Boolean(attempt)}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || Boolean(attempt)}
              onClick={add}
            >
              הוספה לרשימה
            </button>
            <div className="borrower-review-list">
              {entries.map((entry, index) => (
                <div className="borrower-review-row" key={index}>
                  <strong>{itemName(entry.itemId)}</strong>
                  <label className="field-label">
                    כמות
                    <input
                      className="input-field"
                      aria-label={`כמות ${itemName(entry.itemId)}`}
                      type="number"
                      min="1"
                      step="1"
                      value={entry.quantity}
                      disabled={busy || Boolean(attempt)}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setEntries((current) =>
                          current.map((row, position) =>
                            position === index ? { ...row, quantity: value } : row,
                          ),
                        );
                      }}
                    />
                  </label>
                  <label className="field-label">
                    הערה
                    <input
                      className="input-field"
                      aria-label={`הערה ${itemName(entry.itemId)}`}
                      maxLength={500}
                      value={entry.note}
                      disabled={busy || Boolean(attempt)}
                      onChange={(event) =>
                        setEntries((current) =>
                          current.map((row, position) =>
                            position === index ? { ...row, note: event.target.value } : row,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="small-button"
                    disabled={busy || Boolean(attempt)}
                    onClick={() =>
                      setEntries((current) => current.filter((_, position) => position !== index))
                    }
                  >
                    הסרה
                  </button>
                </div>
              ))}
            </div>
          </div>
        </Dialog>
      )}
      {review && (
        <Dialog
          title="אישור ניפוק"
          level="subordinate"
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
                        .filter((row) => row.itemId === entry.itemId)
                        .reduce((sum, row) => sum + row.quantity, 0) >
                      (active.find((item) => item.id === entry.itemId)?.available ?? 0),
                  )
                }
                onClick={() => void submit()}
              >
                אישור ניפוק
              </button>
            </>
          }
        >
          <div className="borrower-review-list">
            {entries.map((entry, index) => (
              <p key={index}>
                {itemName(entry.itemId)} · {entry.quantity}
                {entry.note && ` · ${entry.note}`}
              </p>
            ))}
          </div>
        </Dialog>
      )}
      {discard && (
        <Dialog
          title="מחיקת טיוטת ניפוק?"
          level="subordinate"
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
              <button type="button" className="primary-button" onClick={discardDraft}>
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
