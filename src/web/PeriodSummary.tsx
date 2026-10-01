import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { PeriodSummary as PeriodSummaryResult } from '../contracts/period-summary.js';
import { periodBounds, todayInIsrael } from '../domain/period-summary.js';
import { fetchPeriodSummary } from './api';
import type { Borrower } from '../domain/types.js';
import type { ToastTone } from './Toast';

type Props = {
  active: boolean;
  returnRevision: number;
  openCard: (borrower: Borrower) => void;
  showToast: (title: string, message: string, tone: ToastTone) => void;
};

type Selection = { mode: 'today' | 'all' | 'custom'; start: string; end: string };

const HISTORY_START = '0001-01-01';

export function PeriodSummary({ active, returnRevision, openCard, showToast }: Props) {
  const [range, setRange] = useState<Selection>(() => {
    const today = todayInIsrael();
    return { mode: 'today', start: today, end: today };
  });
  const selectionRef = useRef(range);
  const [calendarToday, setCalendarToday] = useState(range.end);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [result, setResult] = useState<PeriodSummaryResult | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [reload, setReload] = useState(0);
  const requestRef = useRef(0);
  const priorTodayRef = useRef(todayInIsrael());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const borrowerNameRefs = useRef(new Map<number, HTMLButtonElement>());
  const returnFocusRef = useRef<number | null>(null);
  const lastReturnRevisionRef = useRef(returnRevision);

  const selectPeriod = useCallback((next: Selection) => {
    const current = selectionRef.current;
    if (current.mode === next.mode && current.start === next.start && current.end === next.end)
      return;
    // Invalidate synchronously: an old response may settle before React runs the next effect.
    requestRef.current += 1;
    selectionRef.current = next;
    setResult(null);
    setStatus('loading');
    setRange(next);
  }, []);

  const checkRollover = useCallback(() => {
    const currentToday = todayInIsrael();
    if (currentToday === priorTodayRef.current) return false;
    priorTodayRef.current = currentToday;
    setCalendarToday(currentToday);
    const current = selectionRef.current;
    if (current.mode === 'custom' || current.end === currentToday) return false;
    selectPeriod({
      mode: current.mode,
      start: current.mode === 'all' ? HISTORY_START : currentToday,
      end: currentToday,
    });
    return true;
  }, [selectPeriod]);

  useEffect(() => {
    const timer = window.setInterval(checkRollover, 30_000);
    const visible = () => {
      if (document.visibilityState === 'visible') checkRollover();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', checkRollover);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', checkRollover);
    };
  }, [checkRollover]);

  useEffect(() => {
    if (!active) {
      requestRef.current += 1;
      return;
    }
    if (checkRollover()) return;
    const requestId = ++requestRef.current;
    setStatus('loading');
    setResult(null);
    void fetchPeriodSummary(range.start, range.end)
      .then((data) => {
        if (requestId !== requestRef.current) return;
        setResult(data);
        setStatus('ready');
        setExpanded(
          (current) =>
            new Set(
              [...current].filter((id) => data.borrowers.some((row) => row.borrower.id === id)),
            ),
        );
      })
      .catch((error: unknown) => {
        if (requestId !== requestRef.current) return;
        setStatus('failed');
        showToast(
          'טעינת סיכום',
          error instanceof Error ? error.message : 'טעינת הסיכום נכשלה',
          'error',
        );
        if (returnFocusRef.current !== null) {
          returnFocusRef.current = null;
          window.setTimeout(() => headingRef.current?.focus(), 0);
        }
      });
    return () => {
      requestRef.current += 1;
    };
  }, [active, checkRollover, range.mode, range.start, range.end, reload, showToast]);

  useEffect(() => {
    if (status !== 'ready' || !result || returnFocusRef.current === null) return;
    const id = returnFocusRef.current;
    returnFocusRef.current = null;
    (borrowerNameRefs.current.get(id) ?? headingRef.current)?.focus();
  }, [result, status]);

  useEffect(() => {
    if (returnRevision === lastReturnRevisionRef.current) return;
    lastReturnRevisionRef.current = returnRevision;
    setReload((value) => value + 1);
  }, [returnRevision]);

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('he');
    return (result?.borrowers ?? []).filter(
      ({ borrower }) =>
        !term ||
        `${borrower.name} ${borrower.username} ${borrower.contact}`
          .toLocaleLowerCase('he')
          .includes(term),
    );
  }, [result, search]);

  // The technical history bound is never exposed in the custom date controls.
  const editableRange = range.mode === 'all' ? { start: range.end, end: range.end } : range;

  function updateDate(key: 'start' | 'end', value: string) {
    const next: Selection = { ...editableRange, mode: 'custom', [key]: value };
    try {
      periodBounds(next.start, next.end);
      selectPeriod(next);
    } catch (error) {
      showToast(
        'טווח תאריכים',
        error instanceof Error ? error.message : 'טווח התאריכים אינו תקין',
        'warning',
      );
    }
  }

  return (
    <section className="period-summary" aria-labelledby="period-summary-heading" hidden={!active}>
      <h2 id="period-summary-heading" ref={headingRef} tabIndex={-1}>
        סיכום
      </h2>
      <p>מאזן השאלות נטו בתקופה שנבחרה; אינו מציג את הציוד המוחזק כעת בידי השואל.</p>
      <div className="period-summary-controls">
        <div className="period-summary-shortcuts" role="group" aria-label="תקופת הסיכום">
          <button
            type="button"
            className="secondary-button"
            aria-pressed={range.mode === 'today'}
            onClick={() => {
              const today = todayInIsrael();
              selectPeriod({ mode: 'today', start: today, end: today });
            }}
          >
            היום
          </button>
          <button
            type="button"
            className="secondary-button"
            aria-pressed={range.mode === 'all'}
            onClick={() =>
              selectPeriod({ mode: 'all', start: HISTORY_START, end: todayInIsrael() })
            }
          >
            הכל
          </button>
          <span className="period-summary-selection" aria-live="polite">
            {range.mode === 'all' ? 'הכל עד ' : range.mode === 'today' ? 'היום: ' : 'טווח: '}
            {range.mode === 'custom' && (
              <>
                <bdi>{range.start}</bdi>
                {' – '}
              </>
            )}
            <bdi>{range.end}</bdi>
          </span>
        </div>
        <label>
          חיפוש שואל{' '}
          <input
            className="input-field"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="שם, מזהה או איש קשר"
          />
        </label>
        <button
          type="button"
          className="secondary-button"
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          רענון
        </button>
      </div>
      <details className="period-summary-advanced">
        <summary>טווח תאריכים</summary>
        <p>בחירת טווח תאריכים מותאם אישית</p>
        <div className="period-summary-controls">
          <label>
            מתאריך{' '}
            <input
              className="input-field"
              type="date"
              value={editableRange.start}
              max={calendarToday}
              onChange={(event) => updateDate('start', event.target.value)}
            />
          </label>
          <label>
            עד תאריך{' '}
            <input
              className="input-field"
              type="date"
              value={editableRange.end}
              max={calendarToday}
              onChange={(event) => updateDate('end', event.target.value)}
            />
          </label>
        </div>
      </details>
      {status === 'loading' && <p role="status">טוען סיכום…</p>}
      {status === 'ready' &&
        result &&
        (result.borrowers.length === 0 ? (
          <p>אין יתרות השאלה חיוביות בתקופה זו.</p>
        ) : visible.length === 0 ? (
          <p>אין שואלים התואמים לחיפוש.</p>
        ) : (
          <div className="period-summary-table-scroll">
            <table className="period-summary-table">
              <thead>
                <tr>
                  <th scope="col">שואל</th>
                  <th scope="col">מזהה</th>
                  <th scope="col">איש קשר</th>
                  <th scope="col">כמות</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(({ borrower, total, items }) => {
                  const isExpanded = expanded.has(borrower.id);
                  return [
                    <tr key={`borrower-${borrower.id}`}>
                      <td>
                        <div className="period-summary-borrower">
                          <button
                            type="button"
                            className="period-summary-expander"
                            aria-label={`${isExpanded ? 'הסתרת' : 'הצגת'} ציוד של ${borrower.name}`}
                            aria-expanded={isExpanded}
                            aria-controls={`period-items-${borrower.id}`}
                            onClick={() =>
                              setExpanded((current) => {
                                const next = new Set(current);
                                if (next.has(borrower.id)) next.delete(borrower.id);
                                else next.add(borrower.id);
                                return next;
                              })
                            }
                          >
                            <span aria-hidden="true" dir="ltr">
                              {isExpanded ? '▼' : '◀'}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="borrower-directory-action"
                            aria-label={`פתיחת כרטיס שואל — ${borrower.name}`}
                            ref={(node) => {
                              if (node) borrowerNameRefs.current.set(borrower.id, node);
                              else borrowerNameRefs.current.delete(borrower.id);
                            }}
                            onClick={() => {
                              returnFocusRef.current = borrower.id;
                              openCard(borrower);
                            }}
                          >
                            {borrower.name}
                          </button>
                        </div>
                      </td>
                      <td>
                        <bdi dir="ltr">{borrower.username}</bdi>
                      </td>
                      <td>{borrower.contact || '—'}</td>
                      <td>{total}</td>
                    </tr>,
                    <tr
                      key={`items-${borrower.id}`}
                      id={`period-items-${borrower.id}`}
                      hidden={!isExpanded}
                    >
                      <td colSpan={4}>
                        <table className="period-summary-items">
                          <thead>
                            <tr>
                              <th scope="col">ציוד</th>
                              <th scope="col">כמות</th>
                            </tr>
                          </thead>
                          <tbody>
                            {items.map((item) => (
                              <tr key={item.itemId}>
                                <td>{item.name}</td>
                                <td>{item.quantity}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}
