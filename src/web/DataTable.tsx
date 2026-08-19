import { useMemo, useState, type ReactNode } from 'react';
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
  emptyMessage?: string;
  initialSort?: { key: string; direction: 'asc' | 'desc' };
};

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  searchText,
  searchPlaceholder = 'סינון הטבלה…',
  emptyMessage = 'אין רשומות להצגה',
  initialSort,
}: Props<T>) {
  const [query, setQuery] = useState('');
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

  function toggleSort(column: TableColumn<T>) {
    if (!column.sortValue) return;
    setSort((current) =>
      current.key === column.key
        ? { key: column.key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key: column.key, direction: 'asc' },
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ctp-overlay"
          />
          <input
            className="input-field pe-10 ps-10"
            aria-label="סינון הטבלה"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="icon-button absolute left-1.5 top-1/2 -translate-y-1/2"
              aria-label="ניקוי סינון"
              onClick={() => setQuery('')}
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <span className="text-xs text-ctp-subtext">
          {visibleRows.length} מתוך {rows.length}
        </span>
      </div>
      <div className="table-shell">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={column.className}>
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
            {visibleRows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((column) => (
                  <td key={column.key} className={column.className}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {visibleRows.length === 0 && (
          <div className="grid min-h-32 place-items-center px-4 text-sm text-ctp-subtext">
            {emptyMessage}
          </div>
        )}
      </div>
    </div>
  );
}
