import { useEffect, useRef, useState } from 'react';
import type {
  BorrowerDeskSnapshot,
  ItemLostBorrowersSnapshot,
} from '../contracts/borrower-workflow';
import { fetchBorrowerDeskSnapshot, fetchItemLostBorrowers } from './api';
import type { FrozenOperationAttempt } from './borrower-workflow-recovery';
import type { Item } from './InventoryDialogs';
import type { ToastTone } from './Toast';

export function LostItemRecoveryDialog({
  item,
  ledgerEpoch,
  revision,
  locked,
  onDirty,
  onSave,
  onClose,
  showToast,
}: {
  item: Item;
  ledgerEpoch: number | null;
  revision: number;
  locked: boolean;
  onDirty: () => void;
  onSave: (attempt: FrozenOperationAttempt) => Promise<void>;
  onClose: () => void;
  showToast: (title: string, message: string, tone: ToastTone) => void;
}) {
  const [list, setList] = useState<ItemLostBorrowersSnapshot | null>(null);
  const [borrowerId, setBorrowerId] = useState('');
  const [snapshot, setSnapshot] = useState<BorrowerDeskSnapshot | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [destination, setDestination] = useState('');
  const [damaged, setDamaged] = useState(false);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const destinationInitialized = useRef(false);
  const toast = useRef(showToast);
  toast.current = showToast;

  useEffect(() => {
    let current = true;
    setLoading(true);
    setFailed(false);
    setSnapshot(null);
    void (async () => {
      try {
        const nextList = await fetchItemLostBorrowers(item.id);
        if (!current) return;
        if (nextList.ledgerEpoch !== ledgerEpoch)
          throw new Error('המלאי הוחלף. יש לרענן את הנתונים ולפתוח את הפעולה מחדש.');
        setList(nextList);
        if (borrowerId) {
          const nextSnapshot = await fetchBorrowerDeskSnapshot(Number(borrowerId));
          if (!current) return;
          if (nextSnapshot.ledgerEpoch !== nextList.ledgerEpoch)
            throw new Error('המלאי הוחלף. יש לרענן את הנתונים ולפתוח את הפעולה מחדש.');
          setSnapshot(nextSnapshot);
          if (!destinationInitialized.current) {
            setDestination(nextSnapshot.defaultLocationId?.toString() ?? '');
            destinationInitialized.current = true;
          }
        }
      } catch (error) {
        if (!current) return;
        setFailed(true);
        toast.current(
          'טעינת האבדות נכשלה',
          error instanceof Error ? error.message : 'נסה שוב',
          'error',
        );
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [item.id, ledgerEpoch, borrowerId, revision, reload]);

  const totalLost = list?.borrowers.reduce((total, entry) => total + entry.lost, 0) ?? item.lost;
  const lost = snapshot?.holdings.find((holding) => holding.itemId === item.id)?.lost ?? 0;
  const valid =
    !locked &&
    !loading &&
    !failed &&
    snapshot &&
    list &&
    snapshot.ledgerEpoch === ledgerEpoch &&
    !snapshot.borrower.archived &&
    list.borrowers.some((entry) => entry.borrower.id === Number(borrowerId)) &&
    snapshot.inventory.some((entry) => entry.id === item.id && !entry.archived) &&
    /^\d+$/.test(quantity) &&
    Number.isSafeInteger(Number(quantity)) &&
    Number(quantity) > 0 &&
    Number(quantity) <= lost &&
    snapshot.locations.some(
      (location) => location.id === Number(destination) && !location.archived,
    ) &&
    note.length <= 500;
  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || !snapshot) return;
        void onSave({
          version: 1,
          kind: 'operation',
          endpoint: `/borrowers/${snapshot.borrower.id}/operations`,
          subjectId: snapshot.borrower.id,
          stateRevision: snapshot.stateRevision,
          ledgerEpoch: snapshot.ledgerEpoch,
          idempotencyKey: crypto.randomUUID(),
          intent: 'save',
          body: {
            contractVersion: 1,
            ledgerEpoch: snapshot.ledgerEpoch,
            items: [
              {
                itemId: item.id,
                lostCredit: [
                  {
                    locationId: Number(destination),
                    quantity: Number(quantity),
                    condition: damaged ? 'damaged' : 'usable',
                    note: note.trim(),
                  },
                ],
              },
            ],
          },
        });
      }}
    >
      <p>
        {item.name} · אבוד: {totalLost}
      </p>
      {loading && <p role="status">טוען אבדות…</p>}
      {!loading && list?.borrowers.length === 0 && <p>אין שואלים עם אבדות לפריט זה</p>}
      <label className="field-label">
        שואל
        <select
          className="input-field"
          value={borrowerId}
          disabled={locked || !list}
          onChange={(event) => {
            setBorrowerId(event.target.value);
            setSnapshot(null);
            onDirty();
          }}
        >
          <option value="">בחרו שואל</option>
          {list?.borrowers.map(({ borrower, lost: balance }) => (
            <option key={borrower.id} value={borrower.id} disabled={borrower.archived}>
              {borrower.fullName} · {borrower.playaName} · {borrower.campDepartment} ·{' '}
              {borrower.phoneNumber} · אבוד: {balance}
              {borrower.archived ? ' · בארכיון — יש להפעיל מחדש את השואל' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="field-label">
        כמות
        <input
          className="input-field"
          type="number"
          min="1"
          max={lost || undefined}
          step="1"
          value={quantity}
          disabled={locked}
          onChange={(event) => {
            setQuantity(event.target.value);
            onDirty();
          }}
        />
      </label>
      <label className="field-label">
        מיקום יעד
        <select
          className="input-field"
          value={destination}
          disabled={locked || !snapshot}
          onChange={(event) => {
            destinationInitialized.current = true;
            setDestination(event.target.value);
            onDirty();
          }}
        >
          <option value="">בחרו מיקום</option>
          {snapshot?.locations
            .filter((location) => !location.archived)
            .map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
        </select>
      </label>
      <div className="checkbox-label return-damage-toggle">
        <input
          type="checkbox"
          aria-labelledby="lost-return-damage-label"
          checked={damaged}
          disabled={locked}
          onChange={(event) => {
            setDamaged(event.target.checked);
            onDirty();
          }}
        />
        <span id="lost-return-damage-label">הוחזר פגום</span>
      </div>
      <label className="field-label">
        הערה (רשות)
        <textarea
          className="input-field"
          maxLength={500}
          value={note}
          disabled={locked}
          onChange={(event) => {
            setNote(event.target.value);
            onDirty();
          }}
        />
      </label>
      <div className="dialog-actions">
        <button className="primary-button" type="submit" disabled={!valid}>
          השב אבדה
        </button>
        <button className="secondary-button" type="button" onClick={onClose} disabled={locked}>
          ביטול
        </button>
        {failed && (
          <button
            className="secondary-button"
            type="button"
            disabled={locked || loading}
            onClick={() => setReload((value) => value + 1)}
          >
            ניסיון טעינה מחדש
          </button>
        )}
      </div>
    </form>
  );
}
