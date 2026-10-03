// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable, type TableColumn } from '../../src/web/DataTable';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
type Row = { id: number; name: string };
const rows: Row[] = Array.from({ length: 120 }, (_, index) => ({
  id: index + 1,
  name: `record ${index + 1}`,
}));
const columns: TableColumn<Row>[] = [
  { key: 'id', label: 'מספר', render: (row) => row.id, sortValue: (row) => row.id },
  { key: 'name', label: 'שם', render: (row) => row.name },
];
function table(data = rows, pagination = true) {
  return (
    <DataTable
      rows={data}
      columns={columns}
      rowKey={(row) => row.id}
      searchText={(row) => row.name}
      pagination={pagination}
    />
  );
}
function bodyRows() {
  return within(screen.getByRole('table')).getAllByRole('row').slice(1);
}
function bodyIds() {
  return bodyRows().map((row) => Number(within(row).getAllByRole('cell')[0]!.textContent));
}
function next() {
  fireEvent.click(screen.getByRole('button', { name: 'העמוד הבא' }));
}
function search(value: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'סינון הטבלה' }), { target: { value } });
}

describe('DataTable pagination', () => {
  it('starts with 50 rows and reaches every record with accurate ranges and boundaries', () => {
    render(table());
    expect(bodyIds()).toEqual(rows.slice(0, 50).map((row) => row.id));
    expect(screen.getByText('1–50 מתוך 120')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'העמוד הקודם' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    next();
    expect(screen.getByText('51–100 מתוך 120')).toBeTruthy();
    expect(bodyIds()).toEqual(rows.slice(50, 100).map((row) => row.id));
    next();
    expect(bodyIds()).toEqual(rows.slice(100, 120).map((row) => row.id));
    expect(screen.getByText('101–120 מתוך 120')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'העמוד הבא' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'העמוד הקודם' }));
    expect(screen.getByText('51–100 מתוך 120')).toBeTruthy();
    expect(bodyIds()).toEqual(rows.slice(50, 100).map((row) => row.id));
  });

  it('searches and sorts the full row set before paging, resetting query and sort to page one', () => {
    render(table());
    next();
    search('record 120');
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText('1–1 מתוך 1')).toBeTruthy();
    expect(within(bodyRows()[0]!).getByText('120')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ניקוי סינון' }));
    expect(screen.getByText('1–50 מתוך 120')).toBeTruthy();
    next();
    fireEvent.click(screen.getByRole('button', { name: 'מספר' }));
    expect(screen.getByText('1–50 מתוך 120')).toBeTruthy();
    expect(within(bodyRows()[0]!).getByText('120')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'מספר' }).getAttribute('aria-sort')).toBe(
      'descending',
    );
    expect(screen.getByRole('columnheader', { name: 'מספר' }).getAttribute('scope')).toBe('col');
  });

  it('returns a pinned sort to the natural reading start and preserves the focused control', () => {
    const view = render(
      <>
        <nav className="app-nav" />
        {table()}
      </>,
    );
    const nav = view.container.querySelector('.app-nav')!;
    vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue({ bottom: 64 } as DOMRect);
    vi.spyOn(screen.getByRole('table'), 'getBoundingClientRect').mockReturnValue({
      top: -200,
    } as DOMRect);
    const scroll = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    next();
    const sortButton = screen.getByRole('button', { name: 'מספר' });
    sortButton.focus();
    fireEvent.click(sortButton);
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: -264, behavior: 'instant' });
    expect(document.activeElement).toBe(sortButton);
    expect(screen.getByText('1–50 מתוך 120')).toBeTruthy();
  });

  it('keeps the scroll position when sorting already at the reading start', () => {
    const view = render(
      <>
        <nav className="app-nav" />
        {table()}
      </>,
    );
    vi.spyOn(view.container.querySelector('.app-nav')!, 'getBoundingClientRect').mockReturnValue({
      bottom: 64,
    } as DOMRect);
    vi.spyOn(screen.getByRole('table'), 'getBoundingClientRect').mockReturnValue({
      top: 64,
    } as DOMRect);
    const scroll = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'מספר' }));
    expect(scroll).not.toHaveBeenCalled();
  });

  it('offers 25/50/100 sizes and resets size changes to page one', () => {
    render(table());
    const size = screen.getByRole('combobox', { name: 'שורות בעמוד' });
    expect(
      within(size)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['25', '50', '100']);
    next();
    fireEvent.change(size, { target: { value: '25' } });
    expect(bodyRows()).toHaveLength(25);
    expect(screen.getByText('1–25 מתוך 120')).toBeTruthy();
    next();
    fireEvent.change(size, { target: { value: '100' } });
    expect(bodyRows()).toHaveLength(100);
    expect(screen.getByText('1–100 מתוך 120')).toBeTruthy();
  });

  it('clamps shrinking rows and retains a valid page across inspection or same-length edits', () => {
    const view = render(table());
    next();
    view.rerender(table(rows.map((row) => ({ ...row, name: `${row.name} edited` }))));
    expect(screen.getByText('51–100 מתוך 120')).toBeTruthy();
    next();
    view.rerender(table(rows.slice(0, 60)));
    expect(screen.getByText('51–60 מתוך 60')).toBeTruthy();
    view.rerender(table(rows));
    expect(screen.getByText('51–100 מתוך 120')).toBeTruthy();
  });

  it('keeps empty results empty and disables navigation without an invalid range', () => {
    render(table());
    next();
    search('missing');
    expect(screen.getByText('אין רשומות להצגה')).toBeTruthy();
    expect(screen.getByText('0 רשומות')).toBeTruthy();
    expect(screen.getByRole('table').querySelectorAll('tbody tr')).toHaveLength(0);
    expect((screen.getByRole('button', { name: 'העמוד הבא' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'העמוד הקודם' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByText(/0–/)).toBeNull();
  });

  it('leaves unpaged consumers unpaged and keeps non-sortable headers free of sort state', () => {
    render(table(rows, false));
    expect(bodyRows()).toHaveLength(120);
    expect(screen.queryByRole('navigation', { name: 'דפדוף בטבלה' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'שם' }).hasAttribute('aria-sort')).toBe(false);
  });
});
