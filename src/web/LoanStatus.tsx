import { useEffect, useRef, useState } from 'react';
import type { Borrower } from '../domain/types';
import { api } from './api';
import { DataTable, type TableColumn } from './DataTable';
import type { ToastTone } from './Toast';

type Loan = {
  checkoutId: number;
  itemName: string;
  borrowerId: number;
  borrowerName: string;
  outstanding: number;
  createdAt: string;
};

type LoanRow = Loan & { date: string; dateSearch: string; timestamp: number };
type LoadState = { kind: 'loading' | 'ready' | 'failed'; rows: LoanRow[]; revision: number };

const dateFormat = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function loanRow(loan: Loan): LoanRow {
  // The ledger stores SQLite CURRENT_TIMESTAMP values in UTC without a zone suffix.
  const timestamp = new Date(`${loan.createdAt.replace(' ', 'T')}Z`).getTime();
  const parts = dateFormat.formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)!.value;
  const day = part('day');
  const month = part('month');
  const year = part('year');
  const date = dateFormat.format(timestamp);
  return {
    ...loan,
    timestamp,
    date,
    dateSearch: `${date} ${day}/${month}/${year} ${year}-${month}-${day}`,
  };
}

export function LoanStatus({
  showToast,
  openCard,
}: {
  showToast: (title: string, message: string, tone: ToastTone) => void;
  openCard: (borrower: Pick<Borrower, 'id' | 'fullName'>, onReturn: () => void) => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: 'loading', rows: [], revision: -1 });
  const [revision, setRevision] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const borrowerNameRefs = useRef(new Map<number, HTMLButtonElement>());
  const returnFocusRef = useRef<{ checkoutId: number; afterRevision: number } | null>(null);

  useEffect(() => {
    const pending = returnFocusRef.current;
    // Restore only after the return-triggered refresh, never against the old rows.
    if (state.kind === 'loading' || !pending || state.revision <= pending.afterRevision) return;
    const { checkoutId } = pending;
    returnFocusRef.current = null;
    const trigger = state.kind === 'ready' ? borrowerNameRefs.current.get(checkoutId) : null;
    (trigger ?? headingRef.current)?.focus();
  }, [state]);

  const columns: TableColumn<LoanRow>[] = [
    {
      key: 'borrower',
      label: 'שואל',
      render: (row) => (
        <button
          type="button"
          className="borrower-directory-action"
          aria-label={`פתיחת כרטיס שואל — ${row.borrowerName}`}
          ref={(node) => {
            if (node) borrowerNameRefs.current.set(row.checkoutId, node);
            else borrowerNameRefs.current.delete(row.checkoutId);
          }}
          onClick={() =>
            openCard({ id: row.borrowerId, fullName: row.borrowerName }, () => {
              returnFocusRef.current = { checkoutId: row.checkoutId, afterRevision: revision };
              setRevision((current) => current + 1);
            })
          }
        >
          {row.borrowerName}
        </button>
      ),
      sortValue: (row) => row.borrowerName,
    },
    { key: 'item', label: 'פריט', render: (row) => row.itemName, sortValue: (row) => row.itemName },
    {
      key: 'quantity',
      label: 'כמות',
      render: (row) => row.outstanding,
      sortValue: (row) => row.outstanding,
    },
    {
      key: 'date',
      label: 'תאריך השאלה',
      render: (row) => <bdi dir="ltr">{row.date}</bdi>,
      sortValue: (row) => row.timestamp,
    },
  ];

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, kind: 'loading' }));
    void api<Loan[]>('/loans')
      .then((loans) => {
        if (cancelled) return;
        setState({
          kind: 'ready',
          rows: loans.filter((loan) => loan.outstanding > 0).map(loanRow),
          revision,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState((current) => ({ ...current, kind: 'failed', revision }));
        showToast(
          'טעינת מצב השאלות',
          error instanceof Error ? error.message : 'טעינת ההשאלות נכשלה',
          'error',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [revision, showToast]);

  return (
    <section className="space-y-4" aria-labelledby="loan-status-heading">
      <div className="flex items-center justify-between gap-3">
        <h2
          id="loan-status-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-xl font-bold text-ctp-text"
        >
          מצב השאלות
        </h2>
        <button
          type="button"
          className="secondary-button"
          disabled={state.kind === 'loading'}
          onClick={() => setRevision((current) => current + 1)}
        >
          {state.kind === 'failed' ? 'ניסיון טעינה מחדש' : 'רענון'}
        </button>
      </div>
      {state.kind === 'loading' && <p role="status">טוען השאלות…</p>}
      <div hidden={state.kind !== 'ready'}>
        <DataTable
          rows={state.rows}
          columns={columns}
          rowKey={(row) => row.checkoutId}
          searchText={(row) => `${row.itemName} ${row.borrowerName} ${row.dateSearch}`}
          searchPlaceholder="חיפוש לפי פריט, שואל או תאריך השאלה…"
          emptyMessage="לא נמצאו השאלות להצגה"
          initialSort={{ key: 'date', direction: 'desc' }}
          pagination
        />
      </div>
    </section>
  );
}
