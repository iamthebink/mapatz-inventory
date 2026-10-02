import { useRef, useState } from 'react';
import type { BorrowerImportMode, BorrowerImportPreview } from '../contracts/borrower-import.js';
import { commitBorrowerImport, previewBorrowerImport } from './api';
import { Dialog } from './Dialog';
import type { ToastTone } from './Toast';

export function BorrowerImportDialog({
  onClose,
  refresh,
  showToast,
  beforeRequest,
}: {
  onClose: () => void;
  refresh: () => Promise<void>;
  showToast: (title: string, message: string, tone: ToastTone) => void;
  beforeRequest: () => Promise<unknown>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<BorrowerImportMode>('merge');
  const [preview, setPreview] = useState<BorrowerImportPreview | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function commit(selected: File, current: BorrowerImportPreview) {
    const result = await commitBorrowerImport(selected, mode, current.confirmationToken);
    if (result.outcome === 'confirmation_required') {
      setPreview(result.preview.affected.length ? result.preview : null);
      // A prior response may have been lost after commit; reconcile without inferring success.
      await refresh();
      showToast(
        'ייבוא שואלים',
        'הנתונים השתנו. יש לבדוק את ההשלכות ולאשר מחדש את הייבוא.',
        'warning',
      );
      return;
    }
    setPreview(null);
    try {
      await refresh();
      showToast(
        'ייבוא שואלים',
        `נוספו ${result.added}, עודכנו ${result.updated}, הועברו לארכיון ${result.archived}. הוחזרו למלאי ${result.returned} יחידות.`,
        'success',
      );
    } catch {
      showToast('ייבוא שואלים', 'הייבוא הושלם, אך התצוגה לא התרעננה. יש לרענן את המסך.', 'warning');
    }
    onClose();
  }

  async function submit(confirmed?: BorrowerImportPreview) {
    if (!file || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await beforeRequest();
      if (confirmed) await commit(file, confirmed);
      else {
        const current = await previewBorrowerImport(file, mode);
        if (current.affected.length) setPreview(current);
        else await commit(file, current);
      }
    } catch (error) {
      showToast('ייבוא שואלים', error instanceof Error ? error.message : 'הייבוא נכשל', 'error');
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <Dialog
        title="ייבוא שואלים מקובץ"
        level="root"
        role="dialog"
        variant="standard"
        busy={pending}
        dismissible={!pending}
        onClose={onClose}
        actions={
          <>
            <button type="button" className="secondary-button" disabled={pending} onClick={onClose}>
              ביטול
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={pending || !file}
              onClick={() => void submit()}
            >
              ייבוא
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <p>
            קובץ XLSX, הגיליון הראשון בלבד. בשורה הראשונה העמודות בסדר הבא:{' '}
            <bdi dir="ltr">Playa Name, Full Name, Phone Number, Camp/Department</bdi>.
          </p>
          <p>
            שם מלא הוא חובה. שם פלאיה, מספר טלפון ומחנה / מחלקה יכולים להיות ריקים. צירוף זהה של כל
            הפרטים יידחה.
          </p>
          <label className="field-label">
            קובץ שואלים
            <input
              type="file"
              accept=".xlsx"
              disabled={pending}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setPreview(null);
              }}
              className="input-field"
            />
          </label>
          <label className="field-label">
            אופן הייבוא
            <select
              className="input-field"
              value={mode}
              disabled={pending}
              onChange={(event) => {
                setMode(event.target.value as BorrowerImportMode);
                setPreview(null);
              }}
            >
              <option value="merge">מיזוג עם הרשימה הקיימת</option>
              <option value="replace">החלפת הרשימה הפעילה</option>
            </select>
          </label>
          <p>
            ההתאמה לפי צירוף כל ארבעת פרטי השואל. צירוף קיים שומר על הכרטיס שלו, וצירוף חדש יוצר
            כרטיס חדש. שואלים תואמים בארכיון יחזרו לרשימה הפעילה. בהחלפה, שואלים שאינם בקובץ יועברו
            לארכיון.
          </p>
        </div>
      </Dialog>
      {preview && (
        <Dialog
          title="אישור החזרת ציוד והחלפת שואלים"
          description="לשואלים הבאים יש ציוד מושאל. אישור הייבוא יחזיר את הכמויות המפורטות למלאי הזמין ויעביר את השואלים לארכיון. כמויות שאבדו יישארו אבודות."
          level="subordinate"
          role="alertdialog"
          variant="destructive"
          busy={pending}
          dismissible={!pending}
          onClose={() => setPreview(null)}
          initialFocusRef={cancelRef}
          actions={
            <>
              <button
                ref={cancelRef}
                type="button"
                className="secondary-button"
                disabled={pending}
                onClick={() => setPreview(null)}
              >
                ביטול
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={pending}
                onClick={() => void submit(preview)}
              >
                אישור החזרה וייבוא
              </button>
            </>
          }
        >
          <ul className="space-y-3">
            {preview.affected.map((borrower) => (
              <li key={borrower.id}>
                <strong>
                  {borrower.fullName} — <bdi>{borrower.playaName || '—'}</bdi>
                  {' · מספר טלפון: '}
                  <bdi dir="ltr">{borrower.phoneNumber || '—'}</bdi>
                  {' · מחנה / מחלקה: '}
                  {borrower.campDepartment || '—'}
                </strong>
                <ul>
                  {borrower.loans.map((loan) => (
                    <li key={loan.checkoutId}>
                      {loan.itemName}: {loan.quantity} יחידות
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </>
  );
}
