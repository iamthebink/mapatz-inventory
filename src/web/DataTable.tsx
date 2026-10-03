import { StickyTable } from './StickyTable';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from 'lucide-react';

export type TableColumn<T> = {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number;
  className?: string;
};

type Props<T> = {
  rows: T[];
  columns: TableColumn<T>[];
  rowKey: (row: T) => string | number;
  searchText: (row: T) => string;
  searchPlaceholder?: string;
  toolbar?: ReactNode;
  emptyMessage?: string;
  initialSort?: { key: string; direction: 'asc' | 'desc' };
  pagination?: boolean;
};

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  searchText,
  searchPlaceholder = 'סינון הטבלה…',
  toolbar,
  emptyMessage = 'אין רשומות להצגה',
  initialSort,
  pagination = false,
}: Props<T>) {
  const tableShellRef = useRef<HTMLDivElement>(null);
  const restoreReadingStartRef = useRef(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState(
    initialSort ?? {
      key: columns.find((column) => column.sortValue)?.key ?? '',
      direction: 'asc' as const,
    },
  );
  const visibleRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('he');
    const filtered = normalizedQuery
      ? rows.filter((row) => searchText(row).toLocaleLowerCase('he').includes(normalizedQuery))
      : rows;
    const column = columns.find((candidate) => candidate.key === sort.key);
    if (!column?.sortValue) return filtered;
    return [...filtered].sort((left, right) => {
      const leftValue = column.sortValue!(left);
      const rightValue = column.sortValue!(right);
      const comparison =
        typeof leftValue === 'number' && typeof rightValue === 'number'
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue), 'he', { numeric: true });
      return sort.direction === 'asc' ? comparison : -comparison;
    });
  }, [columns, query, rows, searchText, sort]);

  const pageCount = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * pageSize;
  const displayedRows = pagination
    ? visibleRows.slice(pageStart, pageStart + pageSize)
    : visibleRows;

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  useLayoutEffect(() => {
    if (!restoreReadingStartRef.current) return;
    restoreReadingStartRef.current = false;
    const table = tableShellRef.current?.querySelector('table');
    if (!table) return;
    const boundary = Math.max(
      0,
      document.querySelector('.app-nav')?.getBoundingClientRect().bottom ?? 0,
    );
    const top = table.getBoundingClientRect().top;
    // Sorting starts a fresh reading order. Move its natural start into view
    // without replacing or refocusing the actual header control.
    if (top < boundary) window.scrollBy({ top: top - boundary, behavior: 'instant' });
  }, [sort]);

  function changeQuery(value: string) {
    setQuery(value);
    setPage(0);
  }

  function toggleSort(column: TableColumn<T>) {
    if (!column.sortValue) return;
    restoreReadingStartRef.current = true;
    setPage(0);
    setSort((current) =>
      current.key === column.key
        ? { key: column.key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key: column.key, direction: 'asc' },
    );
  }

  return (
    <div className="space-y-3">
      <div
        className={
          toolbar
            ? 'flex flex-col gap-3 lg:flex-row lg:items-center'
            : 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'
        }
      >
        <div className={`relative w-full ${toolbar ? 'lg:min-w-72 lg:flex-1' : 'sm:max-w-sm'}`}>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ctp-overlay"
          />
          <input
            className="input-field pe-10 ps-10"
            aria-label="סינון הטבלה"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="icon-button absolute left-1.5 top-1/2 -translate-y-1/2"
              aria-label="ניקוי סינון"
              onClick={() => changeQuery('')}
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        {toolbar && <div className="flex min-w-0 flex-wrap items-center gap-3">{toolbar}</div>}
        <span className={`text-xs text-ctp-subtext ${toolbar ? 'lg:ms-auto' : ''}`}>
          {visibleRows.length} מתוך {rows.length}
        </span>
      </div>
      {pagination && (
        <nav className="table-pagination" aria-label="דפדוף בטבלה">
          <label className="flex items-center gap-2">
            שורות בעמוד
            <select
              className="input-field w-auto"
              aria-label="שורות בעמוד"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(0);
              }}
            >
              {[25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <span aria-live="polite">
            {visibleRows.length > 0
              ? `${pageStart + 1}–${pageStart + displayedRows.length} מתוך ${visibleRows.length}`
              : '0 רשומות'}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="secondary-button"
              aria-label="העמוד הקודם"
              disabled={currentPage === 0 || visibleRows.length === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              הקודם
            </button>
            <button
              type="button"
              className="secondary-button"
              aria-label="העמוד הבא"
              disabled={currentPage >= pageCount - 1 || visibleRows.length === 0}
              onClick={() => setPage(currentPage + 1)}
            >
              הבא
            </button>
          </div>
        </nav>
      )}
      <div ref={tableShellRef} className="table-shell">
        <StickyTable className="data-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={column.className}
                  aria-sort={
                    column.sortValue
                      ? sort.key === column.key
                        ? sort.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                      : undefined
                  }
                >
                  {column.sortValue ? (
                    <button
                      type="button"
                      className="sort-button"
                      onClick={() => toggleSort(column)}
                    >
                      {column.label}
                      {sort.key !== column.key ? (
                        <ArrowUpDown className="size-3.5 opacity-50" />
                      ) : sort.direction === 'asc' ? (
                        <ArrowUp className="size-3.5" />
                      ) : (
                        <ArrowDown className="size-3.5" />
                      )}
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayedRows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((column) => (
                  <td key={column.key} className={column.className}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </StickyTable>
        {visibleRows.length === 0 && (
          <div className="grid min-h-32 place-items-center px-4 text-sm text-ctp-subtext">
            {emptyMessage}
          </div>
        )}
      </div>
    </div>
  );
}
